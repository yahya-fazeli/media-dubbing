import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand, probeTool, isCancellation } from '../../src/media/command.js';
import { ErrorCode } from '../../src/core/errors.js';

// The child is always a real Node process, so no external media tool is needed
// while still exercising spawn, pipes, exit codes, signals, and timeouts.
const NODE = process.execPath;
const evalScript = (source) => [NODE, ['-e', source]];

test('runCommand captures stdout, stderr, exit code, and duration', async () => {
  const [cmd, args] = evalScript('process.stdout.write("hello"); process.stderr.write("warn");');
  const result = await runCommand(cmd, args);

  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'hello');
  assert.equal(result.stderr, 'warn');
  assert.equal(typeof result.durationMs, 'number');
  assert.ok(result.durationMs >= 0);
});

test('runCommand rejects a non-zero exit with a structured MediaError', async () => {
  const [cmd, args] = evalScript('process.stdout.write("out"); process.stderr.write("bad input"); process.exit(3);');

  await assert.rejects(
    () => runCommand(cmd, args, { toolName: 'ffmpeg', stage: 'mix', segmentId: 'seg_00007' }),
    (err) => {
      assert.equal(err.code, ErrorCode.MEDIA_ERROR);
      assert.equal(err.stage, 'mix');
      assert.equal(err.segmentId, 'seg_00007');
      assert.match(err.message, /ffmpeg failed with exit code 3/);
      assert.equal(err.details.exitCode, 3);
      assert.match(err.details.stderr, /bad input/);
      assert.ok(err.recommendedAction);
      return true;
    },
  );
});

test('runCommand passes arguments as an array so no shell is involved', async () => {
  // Shell metacharacters must arrive as literal argv entries, not be executed.
  const [cmd, base] = evalScript('process.stdout.write(JSON.stringify(process.argv.slice(1)));');
  const hostile = 'a; touch /tmp/dub-should-not-exist && echo pwned';

  const result = await runCommand(cmd, [...base, hostile]);
  assert.deepEqual(JSON.parse(result.stdout), [hostile]);
  await assert.rejects(() => fsp.stat('/tmp/dub-should-not-exist'), /ENOENT/);
});

test('runCommand honours cwd and merges custom env over process.env', async (t) => {
  const cwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-cmd-'));
  t.after(() => fsp.rm(cwd, { recursive: true, force: true }));

  const [cmd, args] = evalScript(
    'process.stdout.write(JSON.stringify({ cwd: process.cwd(), custom: process.env.DUB_TEST_VAR, inherited: typeof process.env.PATH }));',
  );
  const result = await runCommand(cmd, args, { cwd, env: { DUB_TEST_VAR: 'injected' } });

  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.custom, 'injected');
  assert.equal(parsed.inherited, 'string', 'the parent environment is inherited');
  // macOS reports /private/tmp for /tmp, so compare real paths.
  assert.equal(await fsp.realpath(parsed.cwd), await fsp.realpath(cwd));
});

test('runCommand kills a process that exceeds its timeout with a TimeoutError', async () => {
  const [cmd, args] = evalScript('setTimeout(() => {}, 60_000);');

  const started = Date.now();
  await assert.rejects(
    () => runCommand(cmd, args, { timeoutMs: 200, toolName: 'ffmpeg' }),
    (err) => {
      assert.equal(err.code, ErrorCode.TIMEOUT);
      assert.equal(err.retryable, true);
      assert.equal(err.recoveryScope, 'stage');
      assert.match(err.message, /exceeded its .* time limit/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 10_000, 'the timeout must fire promptly, not wait for the child');
});

test('runCommand aborts a running process when its signal fires', async () => {
  const [cmd, args] = evalScript('setTimeout(() => {}, 60_000);');
  const controller = new AbortController();

  const promise = runCommand(cmd, args, { signal: controller.signal, toolName: 'ffmpeg' });
  setTimeout(() => controller.abort(), 150);

  await assert.rejects(promise, (err) => {
    assert.equal(err.code, ErrorCode.CANCELLED);
    assert.equal(err.retryable, false);
    assert.equal(err.recoveryScope, 'job');
    return true;
  });
});

test('runCommand refuses to start when the signal is already aborted', async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => runCommand(NODE, ['-e', 'process.exit(0)'], { signal: controller.signal }),
    (err) => err.code === ErrorCode.CANCELLED,
  );
});

test('runCommand reports a missing tool with an actionable code', async () => {
  await assert.rejects(
    () => runCommand('definitely-not-a-real-tool-xyz', ['--version'], { toolName: 'demucs' }),
    (err) => {
      assert.equal(err.code, ErrorCode.MEDIA_TOOL_MISSING);
      assert.equal(err.retryable, false);
      assert.match(err.message, /demucs.*not installed/);
      assert.match(err.recommendedAction, /mock/);
      return true;
    },
  );
});

test('runCommand resolves a missing tool result when allowMissing is set', async () => {
  const result = await runCommand('definitely-not-a-real-tool-xyz', [], { allowMissing: true });
  assert.equal(result.missing, true);
  assert.equal(result.code, 127);
  assert.equal(result.stdout, '');
});

test('runCommand caps captured output to maxOutputChars', async () => {
  const [cmd, args] = evalScript('process.stdout.write("x".repeat(50_000));');
  const result = await runCommand(cmd, args, { maxOutputChars: 100 });

  assert.ok(result.stdout.length <= 50_000, 'output is bounded');
  assert.ok(result.stdout.length < 50_000, `expected truncation, got ${result.stdout.length} chars`);
});

test('runCommand does not reject after the promise has already settled', async () => {
  // A process that writes and exits immediately must resolve exactly once; a
  // late abort after settle must not surface as an unhandled rejection.
  const [cmd, args] = evalScript('process.stdout.write("done");');
  const controller = new AbortController();
  const result = await runCommand(cmd, args, { signal: controller.signal });
  assert.equal(result.stdout, 'done');
  controller.abort();
  await new Promise((r) => setTimeout(r, 20));
});

test('probeTool reports availability and the first version line', async () => {
  const available = await probeTool(NODE, ['-e', 'process.stdout.write("v99.0.0\\nextra line")']);
  assert.equal(available.available, true);
  assert.equal(available.version, 'v99.0.0', 'only the first line is reported');

  const missing = await probeTool('definitely-not-a-real-tool-xyz');
  assert.equal(missing.available, false);
  assert.equal(missing.version, null);
});

test('isCancellation re-export recognizes cancellation errors', async () => {
  const controller = new AbortController();
  controller.abort();
  const err = await runCommand(NODE, ['-e', 'setTimeout(()=>{},1000)'], { signal: controller.signal })
    .catch((e) => e);
  assert.equal(isCancellation(err), true);
  assert.equal(isCancellation(new Error('other')), false);
});
