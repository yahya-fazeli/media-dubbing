import { createRequire } from 'node:module';

/**
 * Initializes the OpenTelemetry SDK behind DUB_OTEL_ENABLED.
 *
 * `telemetry.js` builds spans through `@opentelemetry/api`, but the API alone is
 * a no-op until a provider is registered: spans are created and immediately
 * dropped. This module supplies the provider and an exporter, and is loaded
 * lazily so the SDK stays an optional dependency.
 *
 * The SDK packages are declared `optionalDependencies`, so a plain install may
 * omit them; a missing SDK logs a warning and leaves tracing disabled rather than
 * failing startup.
 */

const require = createRequire(import.meta.url);

const EXPORTERS = new Set(['console', 'memory', 'none']);

// The tracer provider is process-global: `register()` installs it once and
// cannot replace it afterwards, so a second registration is silently ignored and
// a provider that has been shut down is never revived. Rebuilding an app in the
// same process (tests, or a restarted CLI command) must therefore reuse whatever
// provider is already live rather than constructing a new one.
let activeSdk = null;

export class TelemetrySdk {
  #provider;
  #exporter;
  #disposed = false;

  constructor({ provider, exporter, kind }) {
    this.#provider = provider;
    this.#exporter = exporter;
    this.kind = kind;
  }

  /** Finished spans, when the memory exporter is in use. Null otherwise. */
  get spans() {
    return this.#exporter?.getFinishedSpans?.() ?? null;
  }

  get exporter() { return this.#exporter; }

  /**
   * Flushes buffered spans without tearing the provider down. A batching span
   * processor would otherwise lose its final spans; the provider stays
   * registered so a later app in this process still traces.
   */
  async flush() {
    if (this.#disposed) return;
    try {
      await this.#provider?.forceFlush();
    } catch {
      // Flushing during teardown must never mask the reason the process is
      // exiting, and there is nothing useful left to do about a flush failure.
    }
  }

  /**
   * Permanently stops the provider. Only safe at true process exit or in tests:
   * the global tracer cannot be re-registered afterwards.
   */
  async shutdown() {
    if (this.#disposed) return;
    this.#disposed = true;
    if (activeSdk === this) activeSdk = null;
    try {
      await this.#provider?.shutdown();
    } catch {
      // Same reasoning as flush: a shutdown failure is not actionable here.
    }
    this.#provider = null;
  }
}

/**
 * Builds and registers a tracer provider. Returns null when tracing is disabled
 * or the SDK is unavailable, so callers can treat tracing as best-effort.
 *
 * Repeated calls return the existing live SDK rather than registering a second
 * provider, which the API would ignore.
 */
export function initTelemetrySdk(config, { logger, sdkLoader = loadSdk } = {}) {
  const observability = config?.observability ?? {};
  if (!observability.otelEnabled) return null;
  if (activeSdk) return activeSdk;

  let sdk;
  try {
    sdk = sdkLoader();
  } catch (err) {
    logger?.warn?.('OpenTelemetry tracing requested but the SDK is not installed', {
      hint: 'npm install @opentelemetry/sdk-trace-node @opentelemetry/sdk-trace-base',
      error: err.message,
    });
    return null;
  }

  const kind = normalizeExporter(observability.otelExporter);
  const exporter = kind === 'memory'
    ? new sdk.InMemorySpanExporter()
    : kind === 'console'
      ? new sdk.ConsoleSpanExporter()
      : null;

  const provider = new sdk.NodeTracerProvider({
    resource: sdk.resourceFromAttributes({
      'service.name': observability.otelServiceName ?? 'youtube-dub',
      'service.version': observability.otelServiceVersion ?? '3.0.0',
    }),
    sampler: observability.otelSampleRatio >= 1
      ? new sdk.AlwaysOnSampler()
      : new sdk.ParentBasedSampler({
        root: new sdk.TraceIdRatioBasedSampler(clampRatio(observability.otelSampleRatio)),
      }),
    // A simple (synchronous) processor keeps the exit path deterministic: a
    // batching processor holds a scheduled timer that would keep the process
    // alive indefinitely now that the provider is never shut down.
    spanProcessors: exporter ? [new sdk.SimpleSpanProcessor(exporter)] : [],
  });
  provider.register();

  logger?.info?.('OpenTelemetry tracing enabled', {
    exporter: kind,
    serviceName: observability.otelServiceName ?? 'youtube-dub',
    sampleRatio: clampRatio(observability.otelSampleRatio),
  });

  activeSdk = new TelemetrySdk({ provider, exporter, kind });
  return activeSdk;
}

/** Drops the memoized SDK so a later init builds a fresh provider. Test-only. */
export async function resetTelemetrySdkForTests() {
  const sdk = activeSdk;
  activeSdk = null;
  await sdk?.shutdown();
}

function loadSdk() {
  const traceNode = require('@opentelemetry/sdk-trace-node');
  const resources = require('@opentelemetry/resources');
  return {
    NodeTracerProvider: traceNode.NodeTracerProvider,
    InMemorySpanExporter: traceNode.InMemorySpanExporter,
    ConsoleSpanExporter: traceNode.ConsoleSpanExporter,
    SimpleSpanProcessor: traceNode.SimpleSpanProcessor,
    AlwaysOnSampler: traceNode.AlwaysOnSampler,
    ParentBasedSampler: traceNode.ParentBasedSampler,
    TraceIdRatioBasedSampler: traceNode.TraceIdRatioBasedSampler,
    resourceFromAttributes: resources.resourceFromAttributes,
  };
}

function normalizeExporter(value) {
  const kind = String(value ?? 'console').toLowerCase();
  return EXPORTERS.has(kind) ? kind : 'console';
}

function clampRatio(value) {
  const ratio = Number(value);
  if (!Number.isFinite(ratio)) return 1;
  return Math.min(1, Math.max(0, ratio));
}
