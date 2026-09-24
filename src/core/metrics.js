/**
 * In-process metrics registry. Counters and histograms are kept in memory and
 * exported in Prometheus text format for scraping, plus a JSON snapshot for the
 * Studio's observability panel.
 */
export class MetricsRegistry {
  #counters = new Map();
  #histograms = new Map();
  #gauges = new Map();
  #enabled;

  constructor({ enabled = true } = {}) {
    this.#enabled = enabled;
  }

  get enabled() { return this.#enabled; }

  #counterKey(name, labels) {
    const sorted = Object.entries(labels ?? {}).sort(([a], [b]) => a.localeCompare(b));
    return { key: `${name}|${JSON.stringify(sorted)}`, sorted };
  }

  increment(name, amount = 1, labels = {}) {
    if (!this.#enabled) return;
    const { key, sorted } = this.#counterKey(name, labels);
    const existing = this.#counters.get(key) ?? { name, labels: sorted, value: 0 };
    existing.value += amount;
    this.#counters.set(key, existing);
  }

  gauge(name, value, labels = {}) {
    if (!this.#enabled) return;
    const { key, sorted } = this.#counterKey(name, labels);
    this.#gauges.set(key, { name, labels: sorted, value });
  }

  /**
   * Records a timing or size observation. Buckets are fixed and coarse: the
   * goal is trend visibility, not precise percentile math.
   */
  observe(name, value, labels = {}, buckets = DEFAULT_BUCKETS) {
    if (!this.#enabled) return;
    const { key, sorted } = this.#counterKey(name, labels);
    let hist = this.#histograms.get(key);
    if (!hist) {
      hist = {
        name,
        labels: sorted,
        buckets: new Map(buckets.map((b) => [b, 0])),
        count: 0,
        sum: 0,
        min: Number.POSITIVE_INFINITY,
        max: Number.NEGATIVE_INFINITY,
      };
      this.#histograms.set(key, hist);
    }
    hist.count += 1;
    hist.sum += value;
    hist.min = Math.min(hist.min, value);
    hist.max = Math.max(hist.max, value);
    for (const bucket of buckets) {
      if (value <= bucket) hist.buckets.set(bucket, hist.buckets.get(bucket) + 1);
    }
  }

  /** Convenience wrapper that observes elapsed milliseconds. */
  async time(name, labels, fn) {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.observe(name, Date.now() - start, labels, DURATION_BUCKETS_MS);
    }
  }

  snapshot() {
    const counters = [...this.#counters.values()].map((c) => ({
      name: c.name,
      labels: Object.fromEntries(c.labels),
      value: c.value,
    }));
    const gauges = [...this.#gauges.values()].map((g) => ({
      name: g.name,
      labels: Object.fromEntries(g.labels),
      value: g.value,
    }));
    const histograms = [...this.#histograms.values()].map((h) => ({
      name: h.name,
      labels: Object.fromEntries(h.labels),
      count: h.count,
      sum: h.sum,
      min: h.count ? h.min : null,
      max: h.count ? h.max : null,
      avg: h.count ? h.sum / h.count : null,
      buckets: Object.fromEntries(h.buckets),
    }));
    return { counters, gauges, histograms };
  }

  reset() {
    this.#counters.clear();
    this.#histograms.clear();
    this.#gauges.clear();
  }

  toPrometheus() {
    const lines = [];
    const escape = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    const fmtLabels = (labels) => {
      const entries = Object.entries(labels);
      if (!entries.length) return '';
      return `{${entries.map(([k, v]) => `${k}="${escape(v)}"`).join(',')}}`;
    };
    for (const counter of this.#counters.values()) {
      lines.push(`# TYPE ${counter.name} counter`);
      lines.push(`${counter.name}${fmtLabels(Object.fromEntries(counter.labels))} ${counter.value}`);
    }
    for (const gauge of this.#gauges.values()) {
      lines.push(`# TYPE ${gauge.name} gauge`);
      lines.push(`${gauge.name}${fmtLabels(Object.fromEntries(gauge.labels))} ${gauge.value}`);
    }
    for (const hist of this.#histograms.values()) {
      lines.push(`# TYPE ${hist.name} histogram`);
      const base = Object.fromEntries(hist.labels);
      for (const [bucket, count] of hist.buckets) {
        lines.push(`${hist.name}_bucket${fmtLabels({ ...base, le: bucket })} ${count}`);
      }
      lines.push(`${hist.name}_bucket${fmtLabels({ ...base, le: '+Inf' })} ${hist.count}`);
      lines.push(`${hist.name}_sum${fmtLabels(base)} ${hist.sum}`);
      lines.push(`${hist.name}_count${fmtLabels(base)} ${hist.count}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

export const DEFAULT_BUCKETS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
export const DURATION_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000];

/** Canonical metric names, kept in one place so naming stays consistent. */
export const MetricNames = {
  JOBS_CREATED: 'dub_jobs_created_total',
  JOBS_COMPLETED: 'dub_jobs_completed_total',
  JOBS_FAILED: 'dub_jobs_failed_total',
  JOBS_CANCELLED: 'dub_jobs_cancelled_total',
  JOBS_RESUMED: 'dub_jobs_resumed_total',
  STAGE_DURATION: 'dub_stage_duration_ms',
  STAGE_FAILURES: 'dub_stage_failures_total',
  STAGE_RETRIES: 'dub_stage_retries_total',
  SEGMENT_DURATION: 'dub_segment_duration_ms',
  SEGMENT_FAILURES: 'dub_segment_failures_total',
  SEGMENT_RETRIES: 'dub_segment_retries_total',
  SEGMENT_REUSED: 'dub_segment_reused_total',
  PROVIDER_CALLS: 'dub_provider_calls_total',
  PROVIDER_ERRORS: 'dub_provider_errors_total',
  PROVIDER_DURATION: 'dub_provider_duration_ms',
  PROVIDER_QUOTA_EVENTS: 'dub_provider_quota_events_total',
  PROVIDER_KEY_ROTATIONS: 'dub_provider_key_rotations_total',
  PROVIDER_MODEL_FALLBACKS: 'dub_provider_model_fallbacks_total',
  TTS_CALLS: 'dub_tts_calls_total',
  TTS_ERRORS: 'dub_tts_errors_total',
  TTS_DURATION: 'dub_tts_duration_ms',
  TTS_AUDIO_SECONDS: 'dub_tts_audio_seconds_total',
  MEDIA_COMMANDS: 'dub_media_commands_total',
  MEDIA_ERRORS: 'dub_media_errors_total',
  MEDIA_DURATION: 'dub_media_duration_ms',
  TIMEOUTS: 'dub_timeouts_total',
  CANCELLATIONS: 'dub_cancellations_total',
  ARTIFACT_REUSE: 'dub_artifact_reuse_total',
  ACTIVE_JOBS: 'dub_active_jobs',
  QUALITY_FAILURES: 'dub_quality_failures_total',
};

export function createMetrics(config) {
  return new MetricsRegistry({ enabled: config?.observability?.metricsEnabled ?? true });
}
