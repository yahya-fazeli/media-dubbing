/**
 * Real-runtime smoke test against ffmpeg and the fake provider.
 *
 * Verifies the actual subprocess path: the mock engine never spawns a child, so
 * runCommand's signal handling and every ffmpeg argument list were previously
 * unexercised. Gated behind RUN_REAL_MEDIA_TESTS so deterministic CI stays green
 * on machines without ffmpeg.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createApplication } from '../../src/app.js';
import { FfmpegEngine, ffmpegAvailable } from '../../src/media/ffmpeg-engine.js';
import { loadConfig } from '../../src/config.js';
import { encodeWav, decodeWav } from '../../src/core/wav.js';
import { runCommand } from '../../src/media/command.js';
import { CancelToken } from '../../src/core/cancellation.js';

const ENABLED = process.env.RUN_REAL_MEDIA_TESTS === '1';

function sineWav({ seconds = 3, sampleRate = 16000, frequency = 220 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.round(0.3 * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  }
  return Buffer.from(encodeWav({ samples, sampleRate, channels: 1 }));
}

const silentLogger = (() => {
  const l = { info() {}, warn() {}, error() {}, debug() {}, child: () => l };
  return l;
})();

let dir;
let engine;
let available;

before(async () => {
  if (!ENABLED) return;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-real-media-'));
  const config = loadConfig({ dataDir: dir });
  available = await ffmpegAvailable(config);
  engine = new FfmpegEngine(config, silentLogger);
});

after(async () => {
  if (dir) await fsp.rm(dir, { recursive: true, force: true });
});

test('ffmpeg and ffprobe are present', { skip: !ENABLED }, async () => {
  assert.equal(available.available, true, 'ffmpeg/ffprobe must be installed for real-media tests');
  assert.match(available.ffmpeg.version, /ffmpeg version/);
});

test('probe reports real streams', { skip: !ENABLED }, async () => {
  const input = path.join(dir, 'a.wav');
  await fsp.writeFile(input, sineWav({ seconds: 2 }));

  const probe = await engine.probe(input);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.hasVideo, false);
  assert.equal(probe.audio.sampleRate, 16000);
  assert.equal(probe.audio.channels, 1);
  assert.ok(Math.abs(probe.durationSeconds - 2) < 0.1, `duration ${probe.durationSeconds}`);
});

test('extractAudio writes a decodable working track', { skip: !ENABLED }, async () => {
  const input = path.join(dir, 'b.wav');
  const output = path.join(dir, 'b-out.wav');
  await fsp.writeFile(input, sineWav({ seconds: 2 }));

  const result = await engine.extractAudio(input, output);
  assert.ok(result.sizeBytes > 0);
  assert.ok(decodeWav(await fsp.readFile(output)).samples.length > 0);
});

test('trimAudio honours start and duration', { skip: !ENABLED }, async () => {
  const input = path.join(dir, 'c.wav');
  const output = path.join(dir, 'c-out.wav');
  await fsp.writeFile(input, sineWav({ seconds: 4 }));

  const result = await engine.trimAudio(input, output, { startSeconds: 1, durationSeconds: 1.5 });
  assert.ok(Math.abs(result.durationSeconds - 1.5) < 0.15, `got ${result.durationSeconds}`);
});

test('normalizeAudio applies loudness normalization', { skip: !ENABLED }, async () => {
  const input = path.join(dir, 'd.wav');
  const output = path.join(dir, 'd-out.wav');
  await fsp.writeFile(input, sineWav({ seconds: 2 }));

  const result = await engine.normalizeAudio(input, output);
  assert.ok(result.sizeBytes > 0);
  const probe = await engine.probe(output);
  assert.ok(Math.abs(probe.durationSeconds - 2) < 0.2, 'normalization must not change duration');
});

test('concatAudio joins inputs into one track', { skip: !ENABLED }, async () => {
  const a = path.join(dir, 'e1.wav');
  const b = path.join(dir, 'e2.wav');
  const output = path.join(dir, 'e-out.wav');
  await fsp.writeFile(a, sineWav({ seconds: 1, frequency: 220 }));
  await fsp.writeFile(b, sineWav({ seconds: 1, frequency: 440 }));

  const result = await engine.concatAudio([a, b], output);
  assert.ok(Math.abs(result.durationSeconds - 2) < 0.2, `got ${result.durationSeconds}`);
});

test('mixAudio combines sources at the given gains', { skip: !ENABLED }, async () => {
  const output = path.join(dir, 'f-out.wav');
  const result = await engine.mixAudio(
    [
      { path: path.join(dir, 'e1.wav'), gain: 1, role: 'dialogue' },
      { path: path.join(dir, 'e2.wav'), gain: 0.4, role: 'background' },
    ],
    output,
    { durationSeconds: 1 },
  );
  assert.equal(result.sources, 2);
  assert.ok(result.sizeBytes > 0);
});

test('renderVideo muxes new audio into the source video', { skip: !ENABLED }, async () => {
  const source = path.join(dir, 'g-src.mp4');
  const audio = path.join(dir, 'g-audio.wav');
  const output = path.join(dir, 'g-out.mp4');

  // Build a video fixture with ffmpeg itself so no binary asset is committed.
  await runCommand(engine.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=3:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ], { timeoutMs: 60000 });
  await fsp.writeFile(audio, sineWav({ seconds: 3, frequency: 440 }));

  const result = await engine.renderVideo(source, audio, output);
  assert.equal(result.kind, 'video');
  assert.equal(result.videoReencoded, false, 'stream copy should succeed for a compatible source');

  const probe = await engine.probe(output);
  assert.equal(probe.hasVideo, true);
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.video.codec, 'h264', 'source video should be preserved');
  assert.ok(Math.abs(probe.durationSeconds - 3) < 0.3, `got ${probe.durationSeconds}`);
});

test('renderVideo falls back to re-encode when copy is impossible', { skip: !ENABLED }, async () => {
  const source = path.join(dir, 'h-src.mp4');
  const audio = path.join(dir, 'h-audio.wav');
  const output = path.join(dir, 'h-out.mp4');
  await runCommand(engine.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=2:size=160x120:rate=15',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', source,
  ], { timeoutMs: 60000 });
  await fsp.writeFile(audio, sineWav({ seconds: 2 }));

  const result = await engine.renderVideo(source, audio, output, { reencode: true });
  assert.equal(result.videoReencoded, true);
  assert.equal((await engine.probe(output)).hasVideo, true);
});

test('runCommand accepts a CancelToken as its signal', { skip: !ENABLED }, async () => {
  // The orchestrator passes a CancelToken as `signal`; runCommand calls
  // signal.addEventListener directly, so the two interfaces must agree.
  const token = new CancelToken();
  const result = await runCommand(engine.ffmpeg, ['-version'], { timeoutMs: 30000, signal: token });
  assert.match(result.stdout, /ffmpeg version/);
});

test('cancelling aborts a running subprocess', { skip: !ENABLED }, async () => {
  const token = new CancelToken();
  const output = path.join(dir, 'i-out.mp4');
  // A long encode gives cancellation a window to land mid-flight.
  const running = runCommand(engine.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=120:size=640x480:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=120',
    '-c:v', 'libx264', '-preset', 'veryslow', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', output,
  ], { timeoutMs: 120000, signal: token });

  setTimeout(() => token.cancel('test cancellation'), 600);
  await assert.rejects(running, (err) => {
    assert.equal(err.code, 'CANCELLED', `expected CANCELLED, got ${err.code}: ${err.message}`);
    return true;
  });
});

test('runCommand rejects a missing binary with a clear error', { skip: !ENABLED }, async () => {
  await assert.rejects(
    runCommand('/nonexistent/ffmpeg-xyz', ['-version'], { timeoutMs: 5000, toolName: 'ffmpeg' }),
    (err) => {
      assert.match(err.message, /not found|not installed|ENOENT|missing/i);
      return true;
    },
  );
});

test('full pipeline completes against real ffmpeg (audio-only source)', { skip: !ENABLED }, async () => {
  const appDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-real-pipe-'));
  const app = await createApplication({
    config: { dataDir: appDir, media: { engine: 'ffmpeg' }, providers: { fake: { enabled: true, latencyMs: 0 } } },
    logger: silentLogger,
  });

  const job = await app.orchestrator.createJob({
    sourceName: 'clip.wav',
    sourceBuffer: sineWav({ seconds: 6 }),
    sourceLanguage: 'en',
    targetLanguage: 'es',
  });
  await app.orchestrator.startJob(job.jobId);
  const done = await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120000 });

  assert.equal(done.status, 'completed', `job failed: ${JSON.stringify(done.stages)}`);
  for (const [name, stage] of Object.entries(done.stages)) {
    assert.ok(
      ['succeeded', 'skipped'].includes(stage.status),
      `stage ${name} ended ${stage.status}: ${stage.error?.message ?? ''}`,
    );
  }
  assert.ok(done.artifacts.finalVideo, 'a final video artifact must exist');

  // Resolve through the store rather than guessing the on-disk layout.
  const finalPath = app.artifacts.resolve(job.jobId, done.artifacts.finalVideo);
  assert.ok((await fsp.stat(finalPath)).size > 0, 'final artifact is non-empty');
  const probe = await engine.probe(finalPath);
  assert.equal(probe.hasAudio, true, 'final artifact must carry the dubbed audio');
  // An audio-only source cannot produce a video stream; the render maps video
  // optionally (`-map 0:v:0?`) so this stays a valid audio-only result.
  assert.equal(probe.hasVideo, false, 'an audio-only source yields an audio-only result');

  await app.orchestrator.shutdown().catch(() => {});
  await fsp.rm(appDir, { recursive: true, force: true });
});

test('full pipeline preserves source video through a real render', { skip: !ENABLED }, async () => {
  const appDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-real-vid-'));
  const app = await createApplication({
    config: { dataDir: appDir, media: { engine: 'ffmpeg' }, providers: { fake: { enabled: true, latencyMs: 0 } } },
    logger: silentLogger,
  });

  // A real mp4 source, generated with ffmpeg so no binary asset is committed.
  const videoFixture = path.join(appDir, 'source.mp4');
  await runCommand(engine.ffmpeg, [
    '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc=duration=6:size=320x240:rate=25',
    '-f', 'lavfi', '-i', 'sine=frequency=300:duration=6',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', videoFixture,
  ], { timeoutMs: 60000 });

  const job = await app.orchestrator.createJob({
    sourceName: 'source.mp4',
    sourceBuffer: await fsp.readFile(videoFixture),
    sourceLanguage: 'en',
    targetLanguage: 'es',
  });
  await app.orchestrator.startJob(job.jobId);
  const done = await app.orchestrator.waitFor(job.jobId, { timeoutMs: 180000 });

  assert.equal(done.status, 'completed', `job failed: ${JSON.stringify(done.stages)}`);
  const finalPath = app.artifacts.resolve(job.jobId, done.artifacts.finalVideo);
  const probe = await engine.probe(finalPath);

  assert.equal(probe.hasVideo, true, 'source video must survive the dub');
  assert.equal(probe.hasAudio, true);
  assert.equal(probe.video.codec, 'h264', 'video should be stream-copied, not re-encoded');
  assert.ok(Math.abs(probe.durationSeconds - 6) < 0.6, `duration drifted to ${probe.durationSeconds}`);
  assert.ok(done.segments.length >= 1, 'segments were produced');

  await app.orchestrator.shutdown().catch(() => {});
  await fsp.rm(appDir, { recursive: true, force: true });
});
