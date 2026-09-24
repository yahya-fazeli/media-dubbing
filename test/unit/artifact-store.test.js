import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ArtifactStore, artifactMediaError } from '../../src/core/artifact-store.js';
import { ErrorCode } from '../../src/core/errors.js';
import { encodeWav } from '../../src/core/wav.js';
import { newJobId } from '../../src/core/ids.js';

async function makeStore(t) {
  const jobsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-artifacts-'));
  t.after(() => fsp.rm(jobsDir, { recursive: true, force: true }));
  const store = new ArtifactStore({ jobsDir }, { debug() {}, warn() {} });
  const jobId = newJobId();
  await fsp.mkdir(path.join(jobsDir, jobId, 'artifacts'), { recursive: true });
  return { store, jobId, jobsDir };
}

test('resolve rejects absolute paths and null bytes', async (t) => {
  const { store, jobId } = await makeStore(t);
  assert.throws(() => store.resolve(jobId, '/etc/passwd'), /relative/i);
  assert.throws(() => store.resolve(jobId, 'a\u0000b'), /null/i);
  assert.throws(() => store.resolve(jobId, ''), /required/i);
});

test('resolve refuses to escape the job artifact root', async (t) => {
  const { store, jobId } = await makeStore(t);
  assert.throws(() => store.resolve(jobId, '../../../../etc/passwd'), /escapes/i);
  assert.throws(() => store.resolve(jobId, 'stage/../../../../escape.wav'), /escapes/i);
});

test('resolve keeps nested paths inside the job root', async (t) => {
  const { store, jobId } = await makeStore(t);
  const resolved = store.resolve(jobId, 'stage/tts/seg_00001.wav');
  assert.ok(resolved.startsWith(store.jobRoot(jobId)));
  assert.ok(resolved.endsWith(path.join('stage', 'tts', 'seg_00001.wav')));
});

test('writeBuffer then readBuffer round-trips and reports the size', async (t) => {
  const { store, jobId } = await makeStore(t);
  const payload = Buffer.from('payload-bytes');
  const info = await store.writeBuffer(jobId, 'stage/mix/clip.bin', payload);
  assert.equal(info.relative, 'stage/mix/clip.bin');
  assert.equal(info.sizeBytes, payload.length);
  assert.deepEqual(await store.readBuffer(jobId, 'stage/mix/clip.bin'), payload);
});

test('writeJson then readJson round-trips structured values', async (t) => {
  const { store, jobId } = await makeStore(t);
  const value = { words: [{ start: 0, end: 1, text: 'hi' }], language: 'en' };
  await store.writeJson(jobId, 'transcript/words.json', value);
  assert.deepEqual(await store.readJson(jobId, 'transcript/words.json'), value);
});

test('writeBuffer leaves no .part temporary files behind', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'stage/x.bin', Buffer.from('x'));
  const listed = await store.list(jobId);
  assert.deepEqual(listed.map((f) => f.relative), ['stage/x.bin']);
});

test('verify reports missing, empty, and non-WAV artifacts as invalid', async (t) => {
  const { store, jobId } = await makeStore(t);

  assert.deepEqual(await store.verify(jobId, 'nope.wav'), { valid: false, reason: 'missing' });

  await store.writeBuffer(jobId, 'empty.wav', Buffer.alloc(0));
  assert.deepEqual(await store.verify(jobId, 'empty.wav'), { valid: false, reason: 'empty' });

  await store.writeBuffer(jobId, 'garbage.wav', Buffer.from('not a wav at all'));
  const bad = await store.verify(jobId, 'garbage.wav', { expectWav: true });
  assert.equal(bad.valid, false);
  assert.equal(bad.reason, 'not-a-wav');
});

test('verify accepts a well-formed WAV produced by the WAV encoder', async (t) => {
  const { store, jobId } = await makeStore(t);
  const wav = encodeWav({ samples: new Int16Array(1600), sampleRate: 16000, channels: 1 });
  await store.writeBuffer(jobId, 'ok.wav', Buffer.from(wav));
  const result = await store.verify(jobId, 'ok.wav', { expectWav: true });
  assert.equal(result.valid, true);
  assert.equal(result.sizeBytes, wav.length);
});

test('canReuse rejects a fingerprint mismatch without touching the file', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'seg.wav', Buffer.from('data'));
  const result = await store.canReuse(jobId, 'seg.wav', {
    fingerprint: 'new', storedFingerprint: 'old',
  });
  assert.equal(result.reusable, false);
  assert.equal(result.reason, 'fingerprint-mismatch');
  assert.ok(await store.exists(jobId, 'seg.wav'), 'mismatch must not delete a valid file');
});

test('canReuse deletes a corrupt artifact so the producer regenerates it', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'corrupt.wav', Buffer.from('xxxx'));
  const result = await store.canReuse(jobId, 'corrupt.wav', { expectWav: true });
  assert.equal(result.reusable, false);
  assert.equal(result.reason, 'not-a-wav');
  assert.equal(await store.exists(jobId, 'corrupt.wav'), false, 'corrupt file should be removed');
});

test('canReuse accepts a valid artifact when no fingerprint is required', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'seg.wav', Buffer.from('data'));
  const result = await store.canReuse(jobId, 'seg.wav');
  assert.equal(result.reusable, true);
});

test('list walks nested artifact directories and ignores temp files', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'a/one.bin', Buffer.from('1'));
  await store.writeBuffer(jobId, 'a/b/two.bin', Buffer.from('22'));
  await fsp.writeFile(path.join(store.jobRoot(jobId), 'leftover.part'), 'tmp');
  const listed = await store.list(jobId);
  assert.deepEqual(listed.map((f) => f.relative), ['a/b/two.bin', 'a/one.bin']);
  assert.equal(listed[0].sizeBytes, 2);
});

test('list filters by prefix', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'tts/a.wav', Buffer.from('a'));
  await store.writeBuffer(jobId, 'mix/a.wav', Buffer.from('b'));
  const listed = await store.list(jobId, 'tts/');
  assert.deepEqual(listed.map((f) => f.relative), ['tts/a.wav']);
});

test('copyIn stores a source file with restrictive permissions', async (t) => {
  const { store, jobId } = await makeStore(t);
  const sourceDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-src-'));
  t.after(() => fsp.rm(sourceDir, { recursive: true, force: true }));
  const source = path.join(sourceDir, 'in.wav');
  await fsp.writeFile(source, 'source-bytes');

  const info = await store.copyIn(jobId, source, 'input/source.wav');
  assert.equal(info.sizeBytes, Buffer.byteLength('source-bytes'));
  const stat = await fsp.stat(store.resolve(jobId, 'input/source.wav'));
  assert.equal(stat.mode & 0o777, 0o600);
});

test('remove deletes an artifact without throwing when it is absent', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'gone.bin', Buffer.from('x'));
  await store.remove(jobId, 'gone.bin');
  assert.equal(await store.exists(jobId, 'gone.bin'), false);
  await store.remove(jobId, 'never-existed.bin');
});

test('exists is false for an empty file, since a zero-byte artifact is unusable', async (t) => {
  const { store, jobId } = await makeStore(t);
  await store.writeBuffer(jobId, 'zero.bin', Buffer.alloc(0));
  assert.equal(await store.exists(jobId, 'zero.bin'), false);
});

test('artifactMediaError produces a retryable stage-scoped failure', () => {
  const err = artifactMediaError('mix/out.wav', 'not-a-wav');
  assert.equal(err.code, ErrorCode.CORRUPT_ARTIFACT);
  assert.equal(err.retryable, true);
  assert.equal(err.recoveryScope, 'stage');
  assert.match(err.message, /not usable/);
});
