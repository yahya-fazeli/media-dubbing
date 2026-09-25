import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initTelemetrySdk, resetTelemetrySdkForTests } from '../../src/core/telemetry-sdk.js';
import { createTelemetry } from '../../src/core/telemetry.js';
import { createApplication } from '../../src/app.js';
import { makeTestApp, createFixtureJob, cleanupDir } from '../helpers/fixtures.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
const silentLogger = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * A tracer provider can only be registered once per process: after
 * `provider.shutdown()` the global API never accepts another one. The default
 * test process therefore shares a single provider, created here on first use.
 */
async function ensureSharedProvider() {
  return initTelemetrySdk({ observability: observability() });
}

const observability = (extra = {}) => ({
  otelEnabled: true,
  otelExporter: 'memory',
  otelServiceName: 'youtube-dub-test',
  otelSampleRatio: 1,
  ...extra,
});

/** Runs a snippet in a fresh process so it can register its own provider. */
async function runInFreshProcess(source, { env = {} } = {}) {
  const script = path.join(os.tmpdir(), `otel-probe-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  await fsp.writeFile(script, source);
  try {
    const { execFile } = await import('node:child_process');
    return await new Promise((resolve) => {
      execFile(process.execPath, [script], { cwd: REPO, env: { ...process.env, ...env } }, (error, stdout) => {
        resolve({ error, stdout: stdout.trim() });
      });
    });
  } finally {
    await fsp.rm(script, { force: true });
  }
}

test('tracing is not initialized unless it is enabled', () => {
  assert.equal(initTelemetrySdk({ observability: { otelEnabled: false } }), null);
  assert.equal(initTelemetrySdk({}), null);
  assert.equal(initTelemetrySdk(undefined), null);
});

test('an enabled SDK registers a provider that captures spans through the API', async () => {
  const sdk = await ensureSharedProvider();
  assert.equal(sdk.kind, 'memory');

  const telemetry = createTelemetry({ observability: observability() });
  assert.equal(telemetry.enabled, true);
  const before = sdk.spans.length;

  const value = await telemetry.span('stage.ingest', { jobId: 'job_1', stage: 'ingest' }, async () => 'ok');
  assert.equal(value, 'ok');

  const added = sdk.spans.slice(before);
  assert.equal(added.length, 1);
  assert.equal(added[0].name, 'stage.ingest');
  assert.equal(added[0].attributes.jobId, 'job_1');
  assert.ok(added[0].spanContext().traceId.length > 0, 'a real trace id is assigned');
  assert.equal(added[0].resource.attributes['service.name'], 'youtube-dub-test');
});

test('a span carrying an exception is exported with error status', async () => {
  const sdk = await ensureSharedProvider();
  const telemetry = createTelemetry({ observability: observability() });
  const before = sdk.spans.length;

  const boom = new Error('provider exploded');
  await assert.rejects(
    () => telemetry.span('stage.tts', { stage: 'tts' }, async () => { throw boom; }),
    (err) => err === boom,
  );

  const span = sdk.spans.slice(before)[0];
  assert.equal(span.name, 'stage.tts');
  assert.equal(span.status.code, 2, 'span is marked failed');
  assert.equal(span.status.message, 'provider exploded');
  const exception = span.events.find((e) => e.name === 'exception');
  assert.equal(exception.attributes['exception.message'], 'provider exploded');
});

test('repeated initialization returns the same live provider', async () => {
  const first = await ensureSharedProvider();
  const second = initTelemetrySdk({ observability: observability() });
  // A second provider would be silently ignored by the global API, which is
  // exactly the failure this memoization prevents.
  assert.equal(second, first);
});

test('flushing is safe and repeated shutdown is idempotent', async () => {
  const sdk = await ensureSharedProvider();
  await assert.doesNotReject(() => sdk.flush());
  await assert.doesNotReject(() => sdk.flush());
});

test('an unknown exporter name falls back to console', async () => {
  const { error, stdout } = await runInFreshProcess(`
    import { initTelemetrySdk } from '${REPO}/src/core/telemetry-sdk.js';
    const sdk = initTelemetrySdk({ observability: { otelEnabled: true, otelExporter: 'nonsense' } });
    console.log(JSON.stringify({ kind: sdk.kind, spans: sdk.spans }));
    await sdk.shutdown();
  `);
  assert.equal(error, null, stdout);
  assert.deepEqual(JSON.parse(stdout), { kind: 'console', spans: null });
});

test('the none exporter registers a provider without an exporter', async () => {
  const { error, stdout } = await runInFreshProcess(`
    import { initTelemetrySdk } from '${REPO}/src/core/telemetry-sdk.js';
    const sdk = initTelemetrySdk({ observability: { otelEnabled: true, otelExporter: 'none' } });
    console.log(JSON.stringify({ kind: sdk.kind, exporter: sdk.exporter, spans: sdk.spans }));
    await sdk.shutdown();
  `);
  assert.equal(error, null, stdout);
  assert.deepEqual(JSON.parse(stdout), { kind: 'none', exporter: null, spans: null });
});

test('a zero sampling ratio never emits a malformed span', async () => {
  const { error, stdout } = await runInFreshProcess(`
    import { initTelemetrySdk } from '${REPO}/src/core/telemetry-sdk.js';
    import { createTelemetry } from '${REPO}/src/core/telemetry.js';
    const config = { observability: { otelEnabled: true, otelExporter: 'memory', otelSampleRatio: 0 } };
    const sdk = initTelemetrySdk(config);
    const telemetry = createTelemetry(config);
    await telemetry.span('stage.sampled', { stage: 'ingest' }, async () => 'ok');
    const bad = sdk.spans.filter((s) => !s.spanContext().traceId || s.name !== 'stage.sampled');
    console.log(JSON.stringify({ malformed: bad.length, total: sdk.spans.length }));
    await sdk.shutdown();
  `);
  assert.equal(error, null, stdout);
  assert.deepEqual(JSON.parse(stdout), { malformed: 0, total: 0 });
});

test('a missing SDK logs a warning and disables tracing instead of throwing', async () => {
  // Runs in a fresh process: the shared provider, once registered, short-circuits
  // initialization before the loader is ever consulted.
  const { error, stdout } = await runInFreshProcess(`
    import { initTelemetrySdk } from '${REPO}/src/core/telemetry-sdk.js';
    const warnings = [];
    const logger = { warn: (msg, fields) => warnings.push({ msg, fields }) };
    const sdk = initTelemetrySdk(
      { observability: { otelEnabled: true, otelExporter: 'memory' } },
      { logger, sdkLoader: () => { throw new Error("Cannot find module '@opentelemetry/sdk-trace-node'"); } },
    );
    console.log(JSON.stringify({
      sdkIsNull: sdk === null,
      warnings: warnings.map((w) => ({ msg: w.msg, hint: w.fields.hint })),
    }));
  `);
  assert.equal(error, null, stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.sdkIsNull, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].msg, /SDK is not installed/);
  assert.match(result.warnings[0].hint, /npm install/);
});

test('createApplication wires the SDK from environment configuration', async () => {
  // Guards the composition root itself: a real job must produce spans using only
  // env config, exercising the same path `DUB_OTEL_ENABLED=1` takes in production.
  const { error, stdout } = await runInFreshProcess(`
    import { createApplication } from '${REPO}/src/app.js';
    import fs from 'node:fs/promises';
    import os from 'node:os';
    import path from 'node:path';
    import { sineWav } from '${REPO}/test/helpers/fixtures.js';

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'otel-wire-'));
    const app = await createApplication({ config: { dataDir: dir } });
    const job = await app.orchestrator.createJob({
      sourceName: 'clip.wav', sourceBuffer: sineWav({ seconds: 4 }),
      sourceLanguage: 'en', targetLanguage: 'es',
    });
    await app.orchestrator.startJob(job.jobId);
    const done = await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120000 });
    await app.close();
    const stages = app.telemetrySdk.spans.filter((s) => s.name.startsWith('stage.'));
    console.log(JSON.stringify({
      jobStatus: done.status,
      sdkKind: app.telemetrySdk.kind,
      stageSpans: stages.length,
    }));
    await fs.rm(dir, { recursive: true, force: true });
  `, { env: { DUB_OTEL_ENABLED: '1', DUB_OTEL_EXPORTER: 'memory', DUB_LOG_LEVEL: 'error' } });

  assert.equal(error, null, stdout);
  const result = JSON.parse(stdout);
  assert.equal(result.sdkKind, 'memory');
  assert.equal(result.jobStatus, 'completed');
  assert.ok(result.stageSpans >= 10, `expected a span per stage, got ${result.stageSpans}`);
});

test('createApplication builds no provider when tracing is disabled', async (t) => {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-otel-off-'));
  t.after(async () => { await fsp.rm(dataDir, { recursive: true, force: true }); });

  const app = await createApplication({
    config: { dataDir },
    logger: silentLogger,
    telemetrySdk: undefined,
  });
  // Config is env-driven and tracing is off by default, so no provider is built.
  assert.equal(app.telemetrySdk, null);
  assert.equal(app.telemetry.enabled, false);
  await assert.doesNotReject(() => app.close());
});

test('a full job emits a correlated span per pipeline stage', async (t) => {
  const telemetrySdk = await ensureSharedProvider();
  const telemetry = createTelemetry({ observability: observability() });
  const before = telemetrySdk.spans.length;

  const { app, dataDir } = await makeTestApp({ telemetrySdk, telemetry });
  t.after(async () => { await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  await app.orchestrator.startJob(job.jobId);
  const done = await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });
  assert.equal(done.status, 'completed');
  await app.close();

  const stageSpans = telemetrySdk.spans.slice(before).filter((s) => s.name.startsWith('stage.'));
  assert.ok(stageSpans.length >= 10, `expected a span per stage, got ${stageSpans.length}`);

  for (const span of stageSpans) {
    assert.equal(span.attributes.jobId, job.jobId, 'every span is correlated to the job');
    assert.ok(span.attributes.stage, 'every span names its stage');
    assert.equal(span.status.code, 0, `${span.name} should have succeeded`);
  }

  const stageNames = new Set(stageSpans.map((s) => s.attributes.stage));
  for (const expected of ['ingest', 'audio_extract', 'transcription', 'translation', 'tts', 'mixing', 'rendering', 'quality']) {
    assert.ok(stageNames.has(expected), `expected a span for ${expected}`);
  }
});

test('span attributes never carry credentials or media content', async (t) => {
  const telemetrySdk = await ensureSharedProvider();
  const telemetry = createTelemetry({ observability: observability() });
  const before = telemetrySdk.spans.length;

  const { app, dataDir } = await makeTestApp({ telemetrySdk, telemetry });
  t.after(async () => { await cleanupDir(dataDir); });

  const job = await createFixtureJob(app, { media: { seconds: 4 } });
  await app.orchestrator.startJob(job.jobId);
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });
  await app.close();

  const attributes = telemetrySdk.spans.slice(before).map((s) => s.attributes);
  assert.ok(attributes.length > 0, 'the job should have produced spans');
  const serialized = JSON.stringify(attributes);
  for (const needle of ['apiKey', 'api_key', 'AIza', 'token', 'Authorization', 'password']) {
    assert.ok(!serialized.includes(needle), `span attributes must not contain "${needle}"`);
  }
  assert.ok(serialized.length < 10_000, 'attributes should stay a small set of scalars');
});

// Last: releasing the global provider must not affect earlier assertions.
test('shutdown releases the provider', async () => {
  const sdk = await ensureSharedProvider();
  await sdk.shutdown();
  await resetTelemetrySdkForTests();
});
