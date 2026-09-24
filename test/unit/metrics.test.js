import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry, MetricNames, DEFAULT_BUCKETS, createMetrics } from '../../src/core/metrics.js';

test('increment accumulates per label set and ignores label order', () => {
  const m = new MetricsRegistry();
  m.increment('calls', 1, { job: 'a', stage: 'tts' });
  m.increment('calls', 2, { stage: 'tts', job: 'a' });
  m.increment('calls', 1, { job: 'b', stage: 'tts' });

  const { counters } = m.snapshot();
  assert.equal(counters.length, 2, 'label order must not create distinct series');
  const a = counters.find((c) => c.labels.job === 'a');
  assert.equal(a.value, 3);
});

test('gauge replaces the previous value for the same series', () => {
  const m = new MetricsRegistry();
  m.gauge(MetricNames.ACTIVE_JOBS, 3);
  m.gauge(MetricNames.ACTIVE_JOBS, 1);
  const { gauges } = m.snapshot();
  assert.equal(gauges.length, 1);
  assert.equal(gauges[0].value, 1);
});

test('observe tracks count, sum, min, max, and cumulative buckets', () => {
  const m = new MetricsRegistry();
  m.observe('latency_ms', 5, {}, [1, 10, 100]);
  m.observe('latency_ms', 7, {}, [1, 10, 100]);
  m.observe('latency_ms', 500, {}, [1, 10, 100]);

  const hist = m.snapshot().histograms[0];
  assert.equal(hist.count, 3);
  assert.equal(hist.sum, 512);
  assert.equal(hist.min, 5);
  assert.equal(hist.max, 500);
  assert.equal(hist.avg, 512 / 3);
  assert.deepEqual(hist.buckets, { 1: 0, 10: 2, 100: 2 });
});

test('observe reports null min/max before any observation', () => {
  const m = new MetricsRegistry();
  m.observe('unused', 1);
  const empty = new MetricsRegistry().snapshot().histograms;
  assert.deepEqual(empty, []);
  assert.equal(m.snapshot().histograms[0].min, 1);
});

test('a disabled registry records nothing but keeps the API usable', () => {
  const m = new MetricsRegistry({ enabled: false });
  m.increment('x');
  m.gauge('y', 1);
  m.observe('z', 1);
  const snapshot = m.snapshot();
  assert.deepEqual(snapshot, { counters: [], gauges: [], histograms: [] });
  assert.equal(m.enabled, false);
});

test('reset clears every series', () => {
  const m = new MetricsRegistry();
  m.increment('x');
  m.gauge('y', 1);
  m.observe('z', 1);
  m.reset();
  assert.deepEqual(m.snapshot(), { counters: [], gauges: [], histograms: [] });
});

test('time observes elapsed milliseconds even when the body throws', async () => {
  const m = new MetricsRegistry();
  const value = await m.time('op_ms', { stage: 'mix' }, async () => 'done');
  assert.equal(value, 'done');

  await assert.rejects(() => m.time('op_ms', { stage: 'mix' }, async () => { throw new Error('x'); }), /x/);

  const hist = m.snapshot().histograms[0];
  assert.equal(hist.count, 2, 'a failed call still contributes a duration');
  assert.equal(hist.labels.stage, 'mix');
});

test('toPrometheus emits counters, gauges, and histogram buckets', () => {
  const m = new MetricsRegistry();
  m.increment(MetricNames.JOBS_CREATED, 2, { engine: 'mock' });
  m.gauge(MetricNames.ACTIVE_JOBS, 1);
  m.observe(MetricNames.STAGE_DURATION, 120, { stage: 'tts' }, [50, 100, 500]);

  const text = m.toPrometheus();
  assert.match(text, /# TYPE dub_jobs_created_total counter/);
  assert.match(text, /dub_jobs_created_total\{engine="mock"\} 2/);
  assert.match(text, /# TYPE dub_active_jobs gauge/);
  assert.match(text, /dub_stage_duration_ms_bucket\{stage="tts",le="100"\} 0/);
  assert.match(text, /dub_stage_duration_ms_bucket\{stage="tts",le="500"\} 1/);
  assert.match(text, /dub_stage_duration_ms_bucket\{stage="tts",le="\+Inf"\} 1/);
  assert.match(text, /dub_stage_duration_ms_sum\{stage="tts"\} 120/);
  assert.match(text, /dub_stage_duration_ms_count\{stage="tts"\} 1/);
  assert.ok(text.endsWith('\n'), 'Prometheus output should be newline terminated');
});

test('toPrometheus escapes quotes and backslashes in label values', () => {
  const m = new MetricsRegistry();
  m.increment('calls', 1, { note: 'a"b\\c' });
  const text = m.toPrometheus();
  assert.match(text, /note="a\\"b\\\\c"/);
});

test('createMetrics honors the observability toggle', () => {
  assert.equal(createMetrics({ observability: { metricsEnabled: false } }).enabled, false);
  assert.equal(createMetrics({ observability: { metricsEnabled: true } }).enabled, true);
  assert.equal(createMetrics({}).enabled, true);
});

test('MetricNames uses a consistent dub_ prefix and unique names', () => {
  const names = Object.values(MetricNames);
  assert.ok(names.every((n) => n.startsWith('dub_')));
  assert.equal(new Set(names).size, names.length, 'metric names must be unique');
});

test('DEFAULT_BUCKETS is sorted ascending', () => {
  const sorted = [...DEFAULT_BUCKETS].sort((a, b) => a - b);
  assert.deepEqual(DEFAULT_BUCKETS, sorted);
});
