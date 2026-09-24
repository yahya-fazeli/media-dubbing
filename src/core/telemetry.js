import { createRequire } from 'node:module';

/**
 * Optional OpenTelemetry tracing. When DUB_OTEL_ENABLED is set and
 * @opentelemetry/api is installed, spans are emitted for each pipeline stage and
 * provider call. Otherwise `tracer` is a no-op shim so callers never branch on
 * whether tracing is available.
 */

const NOOP_SPAN = {
  setAttribute() {},
  setAttributes() {},
  addEvent() {},
  recordException() {},
  setStatus() {},
  end() {},
  spanContext() { return { traceId: '', spanId: '' }; },
  isRecording() { return false; },
};

const NOOP_TRACER = {
  startSpan: () => NOOP_SPAN,
  startActiveSpan: (_name, _opts, fn) => fn(NOOP_SPAN),
};

const require = createRequire(import.meta.url);

export class Telemetry {
  #tracer = NOOP_TRACER;
  #enabled = false;
  #api = null;

  constructor({ enabled = false, serviceName = 'youtube-dub', api = null } = {}) {
    this.serviceName = serviceName;
    const resolved = api ?? (enabled ? tryLoadOtelApi() : null);
    if (!resolved) return;
    this.#api = resolved;
    this.#tracer = resolved.trace.getTracer(serviceName);
    this.#enabled = true;
  }

  get enabled() { return this.#enabled; }
  get tracer() { return this.#tracer; }

  /** Wraps `fn` in a span; errors are recorded and rethrown unchanged. */
  async span(name, attributes, fn) {
    if (!this.#enabled) return fn(NOOP_SPAN);
    return this.#tracer.startActiveSpan(name, async (span) => {
      try {
        span.setAttributes(cleanAttributes(attributes));
        return await fn(span);
      } catch (err) {
        if (err instanceof Error) span.recordException(err);
        span.setStatus({ code: 2, message: err?.message ?? 'error' });
        throw err;
      } finally {
        span.end();
      }
    });
  }

  /** Correlates logs with traces by exposing the current trace id. */
  currentTraceId() {
    if (!this.#enabled || !this.#api) return null;
    const span = this.#api.trace.getActiveSpan?.();
    return span?.spanContext?.().traceId ?? null;
  }
}

function tryLoadOtelApi() {
  try {
    return require('@opentelemetry/api');
  } catch {
    return null;
  }
}

function cleanAttributes(attributes = {}) {
  const out = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === undefined || value === null) continue;
    out[key] = typeof value === 'object' ? JSON.stringify(value) : value;
  }
  return out;
}

export function createTelemetry(config, api = null) {
  return new Telemetry({
    enabled: config?.observability?.otelEnabled ?? false,
    serviceName: config?.observability?.otelServiceName ?? 'youtube-dub',
    api,
  });
}
