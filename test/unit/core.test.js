import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapLimit, mapLimitStrict, chunk, sleep } from '../../src/core/concurrency.js';
import { CancelToken, isCancellation } from '../../src/core/cancellation.js';
import { contentHash, newJobId, newSegmentId, isSafeId, assertSafeId } from '../../src/core/ids.js';
import { safeFilename, extensionOf, resolveWithin } from '../../src/core/fsutil.js';
import { AppError, ErrorCode, toAppError, ValidationError, CancelledError } from '../../src/core/errors.js';
import {
  JobStatus, StageName, StageStatus, SegmentStatus, PIPELINE_ORDER,
  createJobRecord, assertTransition, canTransition, computeResumePoint,
  recomputeSegmentSummary, summarizeJob, isTerminal,
} from '../../src/core/job-model.js';

test('mapLimit processes every item and preserves input order', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  const results = await mapLimit(items, 4, async (n) => {
    await sleep(1);
    return n * 2;
  });
  assert.deepEqual(results.map((r) => r.value), items.map((n) => n * 2));
});

test('mapLimit never exceeds the concurrency limit', async () => {
  let active = 0;
  let maxActive = 0;
  await mapLimit(Array.from({ length: 30 }), 3, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(2);
    active -= 1;
  });
  assert.ok(maxActive <= 3, `saw ${maxActive} concurrent workers`);
  assert.ok(maxActive > 1, 'expected real parallelism with limit 3');
});

test('mapLimit reports failures without aborting the batch', async () => {
  const results = await mapLimit([1, 2, 3], 2, async (n) => {
    if (n === 2) throw new Error('boom');
    return n;
  });
  assert.equal(results[0].value, 1);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[2].value, 3);
});

test('mapLimitStrict stops at the first rejection', async () => {
  let ran = 0;
  await assert.rejects(
    mapLimitStrict([1, 2, 3, 4, 5], 1, async (n) => {
      ran += 1;
      if (n === 3) throw new Error('stop');
      return n;
    }),
    /stop/,
  );
  assert.equal(ran, 3, 'later items should not run after the failure');
});

test('mapLimit on an empty list resolves immediately', async () => {
  assert.deepEqual(await mapLimit([], 4, async (x) => x), []);
});

test('chunk splits into fixed-size groups with a remainder', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});

test('CancelToken starts uncancelled and rejects after cancel', () => {
  const token = new CancelToken();
  assert.equal(token.cancelled, false);
  token.throwIfCancelled();
  token.cancel('changed my mind');
  assert.equal(token.cancelled, true);
  assert.throws(() => token.throwIfCancelled(), CancelledError);
  assert.equal(token.reason, 'changed my mind');
});

test('CancelToken notifies and unsubscribes listeners', () => {
  const token = new CancelToken();
  let calls = 0;
  const off = token.onCancel(() => { calls += 1; });
  token.cancel('x');
  assert.equal(calls, 1);
  off();
  assert.equal(calls, 1);
});

test('isCancellation recognizes cancellation errors and raw AbortErrors', () => {
  assert.equal(isCancellation(new CancelledError('x')), true);
  const abort = new Error('aborted');
  abort.name = 'AbortError';
  assert.equal(isCancellation(abort), true);
  assert.equal(isCancellation(new Error('plain')), false);
});

test('contentHash is deterministic and sensitive to input order', () => {
  assert.equal(contentHash('a', 'b'), contentHash('a', 'b'));
  assert.notEqual(contentHash('a', 'b'), contentHash('b', 'a'));
  assert.notEqual(contentHash('a', 'b'), contentHash('ab'));
});

test('newJobId and newSegmentId are distinct and safe', () => {
  const a = newJobId();
  const b = newJobId();
  assert.notEqual(a, b);
  assert.ok(isSafeId(a));
  assert.ok(isSafeId(newSegmentId(7)));
  assert.ok(newSegmentId(7).includes('00007'));
});

test('isSafeId accepts generated ids and rejects traversal', () => {
  assert.ok(isSafeId('job_abc123'));
  assert.ok(isSafeId(newJobId()));
  for (const bad of ['../etc/passwd', 'a/b', 'a\\b', '..', '.', '', 'a..b', 'a\u0000b', '-leading']) {
    assert.equal(isSafeId(bad), false, `should reject ${JSON.stringify(bad)}`);
  }
});

test('assertSafeId throws a validation-coded error for unsafe ids', () => {
  assert.equal(assertSafeId('job_abc123'), 'job_abc123');
  assert.throws(
    () => assertSafeId('../escape'),
    (err) => err.code === 'VALIDATION' && err.status === 400,
  );
});

test('safeFilename strips paths and traversal sequences', () => {
  assert.equal(safeFilename('../../etc/passwd'), 'passwd');
  assert.equal(safeFilename('/abs/path/clip.mp4'), 'clip.mp4');
  assert.equal(safeFilename('clip.mp4'), 'clip.mp4');
  assert.equal(safeFilename('..'), 'upload.bin');
});

test('extensionOf lowercases and includes the dot', () => {
  assert.equal(extensionOf('Clip.MP4'), '.mp4');
  assert.equal(extensionOf('audio.dubbed.WAV'), '.wav');
  assert.equal(extensionOf('noextension'), '');
});

test('resolveWithin permits contained paths and rejects escapes', () => {
  const root = '/tmp/dub-root';
  assert.equal(resolveWithin(root, 'a/b.wav'), '/tmp/dub-root/a/b.wav');
  assert.throws(() => resolveWithin(root, '../outside.wav'), { name: 'ValidationError' });
  assert.throws(() => resolveWithin(root, '/etc/passwd'), { name: 'ValidationError' });
});

test('toAppError normalizes plain errors and preserves AppError identity', () => {
  const app = new ValidationError('bad input');
  assert.equal(toAppError(app), app);

  const plain = new Error('something broke');
  const normalized = toAppError(plain, { stage: StageName.TTS, segmentId: 'seg_1' });
  assert.equal(normalized.message, 'something broke');
  assert.equal(normalized.stage, StageName.TTS);
  assert.equal(normalized.segmentId, 'seg_1');
  assert.equal(normalized.code, ErrorCode.INTERNAL);
});

test('AppError.toJSON exposes structure without leaking a stack', () => {
  const err = new AppError('failed', {
    code: ErrorCode.TTS_ERROR,
    retryable: true,
    recoveryScope: 'segment',
    segmentId: 'seg_2',
    details: { hint: 'retry' },
  });
  const json = err.toJSON();
  assert.equal(json.code, ErrorCode.TTS_ERROR);
  assert.equal(json.retryable, true);
  assert.equal(json.recoveryScope, 'segment');
  assert.equal(json.segmentId, 'seg_2');
  assert.equal(json.stack, undefined);
});

test('canTransition allows the documented lifecycle and blocks the rest', () => {
  assert.ok(canTransition(JobStatus.CREATED, JobStatus.RUNNING));
  assert.ok(canTransition(JobStatus.RUNNING, JobStatus.CANCELLING));
  assert.ok(canTransition(JobStatus.CANCELLING, JobStatus.CANCELLED));
  assert.ok(canTransition(JobStatus.RUNNING, JobStatus.COMPLETED));
  assert.ok(canTransition(JobStatus.RUNNING, JobStatus.FAILED));
  assert.ok(canTransition(JobStatus.CANCELLED, JobStatus.RUNNING));
  assert.ok(canTransition(JobStatus.FAILED, JobStatus.RUNNING));
  // Reaching a terminal state directly from created skips the pipeline.
  assert.equal(canTransition(JobStatus.CREATED, JobStatus.COMPLETED), false);
  assert.equal(canTransition(JobStatus.COMPLETED, JobStatus.CANCELLED), false);
});

test('assertTransition throws a conflict-coded error on an illegal move', () => {
  assert.doesNotThrow(() => assertTransition(JobStatus.RUNNING, JobStatus.CANCELLING));
  assert.throws(
    () => assertTransition(JobStatus.COMPLETED, JobStatus.CANCELLING),
    (err) => err.code === 'CONFLICT' && err.status === 409,
  );
});

test('PIPELINE_ORDER covers every stage exactly once', () => {
  assert.equal(PIPELINE_ORDER.length, 12);
  assert.equal(new Set(PIPELINE_ORDER).size, 12);
  assert.equal(PIPELINE_ORDER[0], StageName.INGEST);
  assert.equal(PIPELINE_ORDER[PIPELINE_ORDER.length - 1], StageName.QUALITY);
});

test('isTerminal identifies end states', () => {
  assert.ok(isTerminal(JobStatus.COMPLETED));
  assert.ok(isTerminal(JobStatus.FAILED));
  assert.ok(isTerminal(JobStatus.CANCELLED));
  assert.equal(isTerminal(JobStatus.RUNNING), false);
});

test('computeResumePoint returns the first stage that has not succeeded', () => {
  const job = createJobRecord({
    jobId: 'job_test_resume',
    sourceName: 'a.mp4',
    sourcePath: 'input/a.mp4',
    sourceLanguage: 'en',
    targetLanguage: 'es',
  });

  assert.equal(computeResumePoint(job), StageName.INGEST);

  job.stages[StageName.INGEST].status = StageStatus.SUCCEEDED;
  job.stages[StageName.AUDIO_EXTRACT].status = StageStatus.SUCCEEDED;
  assert.equal(computeResumePoint(job), StageName.VOCAL_SEPARATION);

  for (const name of PIPELINE_ORDER) job.stages[name].status = StageStatus.SUCCEEDED;
  assert.equal(computeResumePoint(job), null);
});

test('recomputeSegmentSummary counts each segment exactly once', () => {
  const job = createJobRecord({
    jobId: 'job_test_summary',
    sourceName: 'a.mp4',
    sourcePath: 'input/a.mp4',
    sourceLanguage: 'en',
    targetLanguage: 'es',
  });
  job.segments = [
    { segmentId: 'seg_1', status: SegmentStatus.MIXED },
    { segmentId: 'seg_2', status: SegmentStatus.FAILED },
    { segmentId: 'seg_3', status: SegmentStatus.SKIPPED },
    { segmentId: 'seg_4', status: SegmentStatus.MIXED },
  ];
  recomputeSegmentSummary(job);
  assert.equal(job.segmentSummary.total, 4);
  assert.equal(job.segmentSummary.mixed, 2);
  assert.equal(job.segmentSummary.failed, 1);
  assert.equal(job.segmentSummary.skipped, 1);
});

test('summarizeJob hides internal paths and segment bodies but keeps artifact names', () => {
  const job = createJobRecord({
    jobId: 'job_test_summarize',
    sourceName: 'a.mp4',
    sourcePath: 'input/a.mp4',
    sourceLanguage: 'en',
    targetLanguage: 'es',
  });
  job.artifacts.finalVideo = 'final/dubbed.mp4';
  job.segments = [{ segmentId: 'seg_1', status: SegmentStatus.MIXED, sourceText: 'hello' }];

  const summary = summarizeJob(job);
  assert.equal(summary.artifacts.finalVideo, 'final/dubbed.mp4');
  assert.equal(summary.segments, undefined, 'segments are omitted unless requested');
  // The on-disk staging path is internal and must not leak to clients.
  assert.equal(summary.source.relativePath, undefined);
  assert.equal(summary.source.originalName, 'a.mp4');

  const withSegments = summarizeJob(job, { includeSegments: true });
  assert.equal(withSegments.segments.length, 1);
  assert.equal(withSegments.segments[0].sourceText, 'hello');
});
