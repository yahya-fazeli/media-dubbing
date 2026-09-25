import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { decodeWav } from '../../src/core/wav.js';
import { JobStatus, StageName, StageStatus, SegmentStatus } from '../../src/core/job-model.js';
import { GeminiProvider } from '../../src/providers/gemini-provider.js';
import { makeTestApp, createFixtureJob, cleanupDir, sineWav } from '../helpers/fixtures.js';

test('waitFor clears its timeout timer once the job settles', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  await app.orchestrator.startJob(job.jobId);

  const before = process._getActiveHandles().length;
  // A generous timeout: if the timer is not cleared it stays armed for the full
  // duration and holds the event loop open long after the job has completed.
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 600_000 });
  const after = process._getActiveHandles().length;

  assert.equal(after, before, 'waitFor must not leave its timeout armed');
});

async function runJob(app, jobId, { timeoutMs = 120_000 } = {}) {
  await app.orchestrator.startJob(jobId);
  await app.orchestrator.waitFor(jobId, { timeoutMs });
  return app.orchestrator.getJob(jobId);
}

test('a full job runs every pipeline stage and completes', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);

  assert.equal(done.status, JobStatus.COMPLETED);
  for (const stage of Object.values(done.stages)) {
    assert.notEqual(stage.status, StageStatus.FAILED, `${stage.name} should not fail`);
  }
  assert.equal(done.quality.overall, 'pass');
  assert.ok(done.segments.length > 1, 'a 20s source should produce multiple segments');
});

test('the pipeline passes inline audio to Gemini using the positional contract', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const geminiSettings = app.config.providers.gemini;
  geminiSettings.apiKeys = ['test-key'];
  geminiSettings.maxAttempts = 1;

  const calls = [];
  const gemini = new GeminiProvider(app.config, {
    logger: app.logger,
    async fetchImpl(url, init) {
      calls.push({ url, init });
      const body = {
        candidates: [{ content: { parts: [{ text: JSON.stringify({
          language: 'en',
          words: [
            { text: 'hello', start: 0, end: 0.4 },
            { text: 'world', start: 0.4, end: 0.8 },
          ],
          text: 'hello world',
        }) }] } }],
      };
      return {
        ok: true,
        status: 200,
        async json() { return body; },
        async text() { return JSON.stringify(body); },
      };
    },
  });

  let audioBase64;
  let transcriptionOptions;
  app.provider.transcribe = (input, options) => {
    audioBase64 = input;
    transcriptionOptions = options;
    assert.equal(typeof input, 'string');
    assert.ok(input.length > 0, 'transcription input must be base64 audio');
    assert.equal(options.mimeType, 'audio/wav');
    assert.equal(options.language, 'en');
    assert.equal(options.stage, StageName.TRANSCRIPTION);
    assert.equal(options.signal.aborted, false);
    assert.equal(typeof options.signal.addEventListener, 'function');
    return gemini.transcribe(input, options);
  };

  const job = await createFixtureJob(app, { media: { seconds: 2 } });
  const done = await runJob(app, job.jobId);

  assert.equal(done.status, JobStatus.COMPLETED);
  assert.equal(done.stages[StageName.TRANSCRIPTION].status, StageStatus.SUCCEEDED);
  assert.equal(transcriptionOptions.durationSeconds, 2);
  assert.equal(calls.length, 1, 'Gemini must receive the extracted audio');

  const sent = JSON.parse(calls[0].init.body);
  const inline = sent.contents[0].parts.find((part) => part.inlineData);
  assert.equal(inline.inlineData.data, audioBase64);
  assert.equal(inline.inlineData.mimeType, 'audio/wav');
  const decoded = decodeWav(Buffer.from(inline.inlineData.data, 'base64'));
  assert.ok(Math.abs(decoded.durationSeconds - 2) < 0.01);
});

test('a completed job produces playable artifacts on disk', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);

  const expected = ['extractedAudio', 'transcript', 'translations', 'dubbedAudio', 'finalVideo'];
  for (const key of expected) {
    assert.ok(done.artifacts[key], `${key} artifact should be recorded`);
    const resolved = await app.orchestrator.resolveArtifact(job.jobId, done.artifacts[key]);
    assert.ok(resolved.sizeBytes > 0, `${key} should be non-empty`);
  }

  // The dubbed audio must be real, decodable PCM.
  const dubbed = await app.orchestrator.resolveArtifact(job.jobId, done.artifacts.dubbedAudio);
  const decoded = decodeWav(await fsp.readFile(dubbed.path));
  assert.equal(decoded.channels, 2, 'output is mixed to stereo by default');
  assert.ok(decoded.durationSeconds > 15 && decoded.durationSeconds < 25);
});

test('each segment records tts, alignment, timing, and mixing outputs', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);
  const raw = await app.store.read(job.jobId, { fresh: true });
  const { segments } = await app.orchestrator.getSegments(job.jobId, { limit: 1000 });

  assert.equal(segments.length, done.segments.length);
  for (const segment of segments) {
    assert.equal(segment.status, SegmentStatus.MIXED, `segment ${segment.segmentId} should be fully mixed`);
    assert.equal(segment.hasTtsAudio, true, 'synthesized audio exists');
    assert.equal(segment.stages.tts.status, StageStatus.SUCCEEDED);
    assert.equal(segment.stages.alignment.status, StageStatus.SUCCEEDED);
    assert.equal(segment.stages.timing.status, StageStatus.SUCCEEDED);
    assert.ok(segment.translatedText?.trim(), 'translation is present');
  }

  const record = raw.segments[0];
  assert.ok(record.artifacts.tts, 'tts artifact path is recorded');
  assert.ok(record.artifacts.fitted, 'fitted artifact path is recorded');
  assert.ok(record.alignment, 'alignment metrics are recorded');
  assert.ok(record.timing, 'timing metrics are recorded');
});

test('segment windows are contiguous and cover the source duration', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app, { media: { seconds: 30 } });
  const done = await runJob(app, job.jobId);

  assert.ok(done.segments.length >= 3);
  for (let i = 1; i < done.segments.length; i += 1) {
    // Segmentation inserts a small boundary gap between segments, so require
    // non-overlap and near-contiguity rather than exact adjacency.
    const gap = done.segments[i].start - done.segments[i - 1].end;
    assert.ok(gap >= -0.001, 'segments must not overlap');
    assert.ok(gap < 0.2, `segments should be near-contiguous, saw a ${gap}s gap`);
  }
  assert.ok(Math.abs(done.segments[0].start) < 0.001);
  assert.ok(done.segments.at(-1).end <= 30.01, 'segments stay within the source');
});

test('job and segment identities survive a reload from disk', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);
  const segmentIds = done.segments.map((s) => s.segmentId).sort();
  await app.close();

  // A brand-new process over the same data directory must see the same ids.
  const { makeTestApp: remake } = await import('../helpers/fixtures.js');
  const { app: app2, dataDir: dir2 } = await remake({ config: { dataDir } });
  assert.equal(dir2, dataDir);
  try {
    const reloaded = await app2.orchestrator.getJob(job.jobId);
    assert.equal(reloaded.status, JobStatus.COMPLETED);
    assert.deepEqual(reloaded.segments.map((s) => s.segmentId).sort(), segmentIds);
  } finally {
    await app2.close();
  }
});

test('resuming a completed job reuses existing segment audio instead of regenerating it', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);
  const callsAfterFirstRun = app.provider.calls.synthesize;

  await app.orchestrator.startJob(job.jobId, { resume: true });
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });
  const resumed = await app.orchestrator.getJob(job.jobId);

  assert.equal(resumed.status, JobStatus.COMPLETED);
  assert.ok(
    app.provider.calls.synthesize - callsAfterFirstRun < done.segments.length,
    'most segments should be reused rather than re-synthesized',
  );
});

test('a running job can be cancelled and remains resumable', async (t) => {
  const { app, dataDir } = await makeTestApp({
    config: { providers: { fake: { enabled: true, latencyMs: 40 } } },
  });
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app, { media: { seconds: 60 } });
  await app.orchestrator.startJob(job.jobId);
  // Let the pipeline get past ingest and start doing real segment work.
  await new Promise((resolve) => setTimeout(resolve, 120));
  await app.orchestrator.cancelJob(job.jobId, 'test cancel');
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });

  const cancelled = await app.orchestrator.getJob(job.jobId);
  assert.equal(cancelled.status, JobStatus.CANCELLED);
  assert.ok(cancelled.cancellation?.reason, 'the cancellation reason is recorded');

  // Cancelled jobs can be resumed to completion.
  await app.orchestrator.startJob(job.jobId, { resume: true });
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });
  const resumed = await app.orchestrator.getJob(job.jobId);
  assert.equal(resumed.status, JobStatus.COMPLETED);
});

test('a segment-level retry regenerates only the requested segments', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);
  const target = done.segments[0].segmentId;
  const beforeRaw = await app.store.read(job.jobId, { fresh: true });
  const otherTts = beforeRaw.segments.find((s) => s.segmentId !== target).artifacts.tts;
  const callsBefore = app.provider.calls.synthesize;

  await app.orchestrator.retryJob(job.jobId, { scope: 'segment', segmentIds: [target] });
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });

  const afterRaw = await app.store.read(job.jobId, { fresh: true });
  const retried = afterRaw.segments.find((s) => s.segmentId === target);
  const untouched = afterRaw.segments.find((s) => s.segmentId !== target);

  assert.ok(app.provider.calls.synthesize > callsBefore, 'the retried segment is re-synthesized');
  assert.equal(untouched.artifacts.tts, otherTts, 'other segments keep their artifacts');
  assert.equal(retried.status, SegmentStatus.MIXED);
  assert.equal((await app.orchestrator.getJob(job.jobId)).status, JobStatus.COMPLETED);
});

test('a stage-level retry reopens the stage and everything after it', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  await runJob(app, job.jobId);

  await app.orchestrator.retryJob(job.jobId, { scope: 'stage', stage: StageName.MIXING });
  await app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });

  const done = await app.orchestrator.getJob(job.jobId);
  assert.equal(done.status, JobStatus.COMPLETED);
  assert.equal(done.stages[StageName.MIXING].status, StageStatus.SUCCEEDED);
  assert.equal(done.stages[StageName.RENDERING].status, StageStatus.SUCCEEDED);
  assert.equal(done.stages[StageName.QUALITY].status, StageStatus.SUCCEEDED);
});

test('an interrupted job is marked failed and resumable after a restart', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  // Simulate a crash mid-run by writing a job record stuck in `running`.
  await app.store.mutate(job.jobId, (record) => {
    record.status = JobStatus.RUNNING;
    record.stages[StageName.TRANSCRIPTION].status = StageStatus.RUNNING;
  });
  await app.close();

  const { makeTestApp: remake } = await import('../helpers/fixtures.js');
  const { app: app2 } = await remake({ config: { dataDir } });
  t.after(async () => { await app2.close(); });
  try {
    const recovered = await app2.orchestrator.recoverInterruptedJobs();
    assert.deepEqual(recovered, [job.jobId]);

    const record = await app2.orchestrator.getJob(job.jobId);
    assert.equal(record.status, JobStatus.FAILED);
    assert.ok(record.failures.some((f) => /interrupted/i.test(f.error.message)));
    assert.ok(record.resume.nextStage, 'a resume point is computed');

    await app2.orchestrator.startJob(job.jobId, { resume: true });
    await app2.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 });
    assert.equal((await app2.orchestrator.getJob(job.jobId)).status, JobStatus.COMPLETED);
  } finally {
    await cleanupDir(dataDir);
  }
});

test('concurrent jobs run in isolation with distinct directories', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const jobs = await Promise.all([
    createFixtureJob(app, { media: { seconds: 12, frequency: 200 } }),
    createFixtureJob(app, { media: { seconds: 12, frequency: 300 } }),
  ]);
  for (const job of jobs) await app.orchestrator.startJob(job.jobId);
  await Promise.all(jobs.map((job) => app.orchestrator.waitFor(job.jobId, { timeoutMs: 120_000 })));

  const results = await Promise.all(jobs.map((job) => app.orchestrator.getJob(job.jobId)));
  for (const result of results) {
    assert.equal(result.status, JobStatus.COMPLETED);
    assert.ok(result.artifacts.finalVideo);
  }
  const [a, b] = await Promise.all(results.map((r) => app.orchestrator.resolveArtifact(r.jobId, r.artifacts.finalVideo)));
  assert.notEqual(a.path, b.path, 'each job owns its own artifact tree');
});

test('a job rejects a missing source instead of creating a broken record', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  await assert.rejects(
    app.orchestrator.createJob({ sourceName: 'nope.wav', sourceLanguage: 'en', targetLanguage: 'es' }),
    (err) => err.code === 'VALIDATION',
  );
});

test('deleting a job removes its directory and artifacts', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);
  const dir = app.store.jobDir(job.jobId);

  await app.orchestrator.deleteJob(job.jobId);
  await assert.rejects(app.orchestrator.getJob(job.jobId), (err) => err.code === 'NOT_FOUND');
  await assert.rejects(fsp.stat(dir));
  assert.ok(done.artifacts.finalVideo);
});

test('source buffers are validated for size and cached sources are copied in', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const bytes = sineWav({ seconds: 3 });
  const job = await app.orchestrator.createJob({
    sourceName: 'clip.wav',
    sourceBuffer: bytes,
    sourceLanguage: 'en',
    targetLanguage: 'fr',
  });

  const staged = app.artifacts.resolve(job.jobId, job.source.relativePath);
  const onDisk = await fsp.readFile(staged);
  assert.deepEqual(onDisk, bytes, 'the source is copied byte-for-byte');
});

test('loudness normalization is optional and off by default', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app);
  const done = await runJob(app, job.jobId);

  assert.equal(done.stages[StageName.MIXING].metadata.normalized, null);
  assert.equal(done.artifacts.dubbedAudio, 'audio/dubbed.wav');
});

test('a job can opt into loudness normalization of the final mix', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  const job = await createFixtureJob(app, { job: { settings: { normalizeLoudness: true } } });
  const done = await runJob(app, job.jobId);

  assert.equal(done.status, JobStatus.COMPLETED);
  const meta = done.stages[StageName.MIXING].metadata;
  assert.ok(meta.normalized, 'normalization should be recorded');
  assert.equal(meta.normalized.relative, 'audio/dubbed-normalized.wav');
  assert.equal(done.artifacts.dubbedAudio, 'audio/dubbed-normalized.wav');

  // The normalized artifact must exist, be valid PCM, and keep the duration.
  const resolved = await app.orchestrator.resolveArtifact(job.jobId, done.artifacts.dubbedAudio);
  const decoded = decodeWav(await fsp.readFile(resolved.path));
  assert.equal(decoded.channels, 2);
  assert.ok(Math.abs(decoded.durationSeconds - meta.durationSeconds) < 0.5, 'normalization must not shift duration');

  // The un-normalized mix stays available as the pre-normalization artifact.
  const raw = await app.orchestrator.resolveArtifact(job.jobId, 'audio/dubbed.wav');
  assert.ok(raw.sizeBytes > 0);
});

test('a failing normalization degrades gracefully instead of failing the dub', async (t) => {
  const { app, dataDir } = await makeTestApp();
  t.after(async () => { await app.close(); await cleanupDir(dataDir); });

  // Force the engine's normalizeAudio to blow up; the job must still complete.
  const original = app.engine.normalizeAudio.bind(app.engine);
  app.engine.normalizeAudio = async () => { throw new Error('normalizer exploded'); };
  t.after(() => { app.engine.normalizeAudio = original; });

  const job = await createFixtureJob(app, { job: { settings: { normalizeLoudness: true } } });
  const done = await runJob(app, job.jobId);

  assert.equal(done.status, JobStatus.COMPLETED);
  assert.equal(done.stages[StageName.MIXING].status, StageStatus.SUCCEEDED);
  assert.equal(done.stages[StageName.MIXING].metadata.normalized, null);
  assert.equal(done.artifacts.dubbedAudio, 'audio/dubbed.wav', 'falls back to the validated mix');
});

