import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatJobLine, formatJobDetail, formatSegments, formatFailures } from '../../src/cli/format.js';

function job(overrides = {}) {
  return {
    jobId: 'job_abc',
    status: 'completed',
    languages: { source: 'en', target: 'es' },
    source: { originalName: 'clip.wav', durationSeconds: 12.34 },
    createdAt: '2024-01-01T10:00:00.123Z',
    updatedAt: '2024-01-01T10:05:00.123Z',
    stages: {},
    segmentSummary: { total: 3, mixed: 3, failed: 0, skipped: 0 },
    metrics: {},
    ...overrides,
  };
}

test('formatJobLine renders the id, status, languages, and progress', () => {
  const line = formatJobLine(job({ metrics: { totalDurationMs: 42000 } }));
  assert.match(line, /job_abc/);
  assert.match(line, /completed/);
  assert.match(line, /en->es/);
  assert.match(line, /3\/3/);
  assert.match(line, /42s/);
  assert.match(line, /2024-01-01 10:00:00/, 'ISO timestamps are shortened for the terminal');
});

test('formatJobLine tolerates missing metrics and segment summaries', () => {
  const line = formatJobLine(job({ metrics: undefined, segmentSummary: undefined }));
  assert.match(line, /-/);
});

test('formatJobDetail lists every stage with status and timing', () => {
  const detail = formatJobDetail(job({
    providerInfo: { provider: 'fake', engine: 'mock' },
    resume: { nextStage: 'tts' },
    stages: {
      transcribe: { status: 'succeeded', durationMs: 2000 },
      tts: { status: 'failed', durationMs: 500, error: { message: 'boom' } },
      translate: { status: 'skipped', skipReason: 'not needed' },
    },
    quality: { overall: 'pass', summary: 'all good' },
    artifacts: { finalVideo: 'final.mp4' },
  }));

  assert.match(detail, /status:\s+completed/);
  assert.match(detail, /en -> es/);
  assert.match(detail, /provider:\s+fake \/ engine: mock/);
  assert.match(detail, /resume at:\s+tts/);
  assert.match(detail, /transcribe\s+succeeded\s+2s/);
  assert.match(detail, /tts\s+failed\s+1s\s+boom/);
  assert.match(detail, /translate\s+skipped\s+-\s+not needed/);
  assert.match(detail, /Quality: pass - all good/);
  assert.match(detail, /Final artifact: final\.mp4/);
});

test('formatJobDetail omits optional blocks when absent', () => {
  const detail = formatJobDetail(job({ stages: {} }));
  assert.doesNotMatch(detail, /Quality:/);
  assert.doesNotMatch(detail, /Final artifact:/);
  assert.doesNotMatch(detail, /resume at:/);
});

test('formatSegments includes a header and one row per segment', () => {
  const segments = [
    { segmentId: 'seg_00001', start: 0, end: 8, status: 'mixed', timing: { appliedTempo: 1.05 }, translatedText: 'hola' },
    { segmentId: 'seg_00002', start: 8, end: 16, status: 'failed', sourceText: 'hello there' },
  ];
  const out = formatSegments(segments);
  assert.match(out, /Segments \(2\)/);
  assert.match(out, /seg_00001/);
  assert.match(out, /0-8s/);
  assert.match(out, /1\.05/);
  assert.match(out, /hola/);
  assert.match(out, /seg_00002/);
  assert.match(out, /hello there/, 'falls back to source text when there is no translation');
});

test('formatSegments filters by status and reports the match count', () => {
  const segments = [
    { segmentId: 'seg_00001', start: 0, end: 8, status: 'mixed' },
    { segmentId: 'seg_00002', start: 8, end: 16, status: 'failed' },
  ];
  const out = formatSegments(segments, 50, 'failed');
  assert.match(out, /matching failed/);
  assert.match(out, /seg_00002/);
  assert.doesNotMatch(out, /seg_00001/);
});

test('formatSegments truncates long lists and notes the remainder', () => {
  const segments = Array.from({ length: 5 }, (_, i) => ({
    segmentId: `seg_${i}`, start: i, end: i + 1, status: 'mixed',
  }));
  const out = formatSegments(segments, 2);
  assert.match(out, /\.\.\. 3 more/);
});

test('formatFailures renders structured errors with a recommended action', () => {
  const out = formatFailures(job({
    failures: [
      { stage: 'tts', segmentId: 'seg_00002', error: { code: 'TTS_ERROR', message: 'synthesis failed', recommendedAction: 'Retry the segment.' } },
      { stage: 'transcribe', error: { code: 'PROVIDER_ERROR', message: 'quota' } },
    ],
  }));
  assert.match(out, /Failures \(2\)/);
  assert.match(out, /\[TTS_ERROR\] tts \/ seg_00002/);
  assert.match(out, /-> Retry the segment\./);
  assert.match(out, /\[PROVIDER_ERROR\] transcribe/);
});

test('formatFailures reports none when there are no failures', () => {
  const out = formatFailures(job({ failures: [] }));
  assert.match(out, /Failures \(0\)/);
  assert.match(out, /none/);
  assert.match(formatFailures(job()), /none/);
});

test('formatFailures caps output at the most recent failures', () => {
  const failures = Array.from({ length: 40 }, (_, i) => ({
    stage: 'tts', error: { code: 'TTS_ERROR', message: `failure ${i}` },
  }));
  const out = formatFailures(job({ failures }));
  assert.ok(out.split('\n').length < 80, 'output must stay readable for large jobs');
  assert.match(out, /failure 39/, 'the most recent failure is shown');
});
