import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  ingestUpload, validateMediaSignature, enforceMediaLimits, cleanupStaging, MAGIC_SIGNATURES,
} from '../../src/media/ingest.js';
import { loadConfig, ensureDataDirs } from '../../src/config.js';
import { ErrorCode } from '../../src/core/errors.js';
import { encodeWav } from '../../src/core/wav.js';

async function makeConfig(t, overrides = {}) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-ingest-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const config = ensureDataDirs(loadConfig({ dataDir }));
  Object.assign(config.media, overrides.media ?? {});
  return config;
}

/** Writes a staging file and returns the express-upload-shaped descriptor. */
async function stage(t, name, bytes) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-stage-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'upload');
  await fsp.writeFile(file, bytes);
  return { path: file, originalname: name, name };
}

const WAV_BYTES = Buffer.from(encodeWav({ samples: new Int16Array(800), sampleRate: 16000, channels: 1 }));

test('every allow-listed extension has a magic signature, except opaque containers', () => {
  const covered = new Set(MAGIC_SIGNATURES.map((s) => s.ext));
  for (const ext of ['.wav', '.mp3', '.flac', '.ogg', '.opus', '.m4a', '.aac', '.mp4', '.mov', '.webm', '.mkv']) {
    assert.ok(covered.has(ext), `missing signature for ${ext}`);
  }
  // .avi and .m4v are intentionally not sniffed; validateMediaSignature must
  // report them as unchecked rather than silently rejecting valid files.
  assert.ok(!covered.has('.avi'));
});

test('validateMediaSignature accepts a real WAV header', async (t) => {
  const file = await stage(t, 'a.wav', WAV_BYTES);
  const result = await validateMediaSignature(file.path, '.wav');
  assert.equal(result.valid, true);
  assert.equal(result.checked, true);
});

test('validateMediaSignature rejects content that contradicts the extension', async (t) => {
  const file = await stage(t, 'a.wav', Buffer.from('#!/bin/sh\necho pwned\n'));
  const result = await validateMediaSignature(file.path, '.wav');
  assert.equal(result.valid, false);
  assert.ok(result.head, 'the offending header bytes are reported for diagnostics');
});

test('validateMediaSignature reports unchecked for extensions without a signature', async (t) => {
  const file = await stage(t, 'a.avi', Buffer.from('RIFF....AVI '));
  const result = await validateMediaSignature(file.path, '.avi');
  assert.deepEqual(result, { valid: true, checked: false });
});

test('ingestUpload stores a valid upload under the job input directory', async (t) => {
  const config = await makeConfig(t);
  const upload = await stage(t, 'clip.wav', WAV_BYTES);

  const result = await ingestUpload(config, 'job_test', upload);
  assert.equal(result.storedName, 'clip.wav');
  assert.equal(result.extension, '.wav');
  assert.equal(result.isVideo, false);
  assert.equal(result.signatureChecked, true);
  assert.equal(result.sizeBytes, WAV_BYTES.length);

  const stored = await fsp.readFile(result.path);
  assert.deepEqual(stored, WAV_BYTES);
  const stat = await fsp.stat(result.path);
  assert.equal(stat.mode & 0o777, 0o600, 'stored uploads must not be world-readable');
});

test('ingestUpload rejects an unsupported extension before reading the file', async (t) => {
  const config = await makeConfig(t);
  const upload = await stage(t, 'payload.exe', Buffer.from('MZ'));
  await assert.rejects(
    () => ingestUpload(config, 'job_test', upload),
    (err) => err.code === ErrorCode.VALIDATION && /Unsupported file type/.test(err.message),
  );
});

test('ingestUpload rejects a renamed executable whose bytes contradict the extension', async (t) => {
  const config = await makeConfig(t);
  const upload = await stage(t, 'sneaky.wav', Buffer.from('MZ\x90\x00 not audio'));
  await assert.rejects(
    () => ingestUpload(config, 'job_test', upload),
    (err) => /do not match its extension/.test(err.message),
  );
});

test('ingestUpload neutralizes path traversal in the supplied filename', async (t) => {
  const config = await makeConfig(t);
  const upload = await stage(t, '../../../../tmp/evil.wav', WAV_BYTES);

  const result = await ingestUpload(config, 'job_test', upload);
  const inputDir = path.dirname(result.path);
  assert.equal(path.dirname(path.resolve(result.path)), path.resolve(inputDir));
  assert.ok(!result.storedName.includes('/'), `stored name must be a basename: ${result.storedName}`);
  assert.ok(!result.storedName.includes('..'), `stored name must not traverse: ${result.storedName}`);
});

test('ingestUpload rejects a zero-byte upload', async (t) => {
  const config = await makeConfig(t);
  const upload = await stage(t, 'empty.wav', Buffer.alloc(0));
  await assert.rejects(() => ingestUpload(config, 'job_test', upload), /empty/i);
});

test('ingestUpload enforces the configured size limit', async (t) => {
  const config = await makeConfig(t, { media: { maxFileBytes: 8 } });
  const upload = await stage(t, 'big.wav', WAV_BYTES);
  await assert.rejects(() => ingestUpload(config, 'job_test', upload), /exceeds/i);
});

test('enforceMediaLimits rejects a source with no audio stream', async (t) => {
  const config = await makeConfig(t);
  await assert.rejects(
    () => enforceMediaLimits(config, {}, '/x', { hasAudio: false, durationSeconds: 1, sizeBytes: 1 }),
    (err) => err.code === ErrorCode.VALIDATION && /no audio stream/.test(err.message),
  );
});

test('enforceMediaLimits rejects sources over the duration and size limits', async (t) => {
  const config = await makeConfig(t, { media: { maxDurationSeconds: 10, maxFileBytes: 100 } });

  await assert.rejects(
    () => enforceMediaLimits(config, {}, '/x', { hasAudio: true, durationSeconds: 11, sizeBytes: 1 }),
    /exceeds the limit/,
  );
  await assert.rejects(
    () => enforceMediaLimits(config, {}, '/x', { hasAudio: true, durationSeconds: 1, sizeBytes: 101 }),
    /size limit/,
  );
});

test('enforceMediaLimits passes a source inside the limits and reuses a supplied probe', async (t) => {
  const config = await makeConfig(t);
  const probe = { hasAudio: true, durationSeconds: 1, sizeBytes: 10 };
  const result = await enforceMediaLimits(config, {}, '/x', probe);
  assert.equal(result, probe, 'a supplied probe should be reused rather than re-run');

  // Without a probe it must call the engine.
  let called = 0;
  const engine = { async probe() { called += 1; return probe; } };
  await enforceMediaLimits(config, engine, '/x');
  assert.equal(called, 1);
});

test('cleanupStaging removes the staged file and tolerates a missing path', async (t) => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-stage-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'upload');
  await fsp.writeFile(file, 'x');

  await cleanupStaging({ path: file });
  await assert.rejects(() => fsp.stat(file), /ENOENT/);
  await cleanupStaging({});
  await cleanupStaging(undefined);
});
