import { loadConfig, ensureDataDirs } from './config.js';
import { createLogger } from './core/logger.js';
import { createMetrics } from './core/metrics.js';
import { createTelemetry } from './core/telemetry.js';
import { JobStore } from './core/job-store.js';
import { ArtifactStore } from './core/artifact-store.js';
import { JobOrchestrator } from './pipeline/orchestrator.js';
import { createMediaEngine } from './media/index.js';
import { createProvider } from './providers/index.js';

/**
 * Composition root. Everything is constructed once here and injected, so tests
 * can swap the engine, provider, or stores without touching the pipeline.
 */
export async function createApplication(overrides = {}) {
  const config = ensureDataDirs(loadConfig(overrides.config ?? {}));
  const logger = overrides.logger ?? createLogger(config);
  const metrics = overrides.metrics ?? createMetrics(config);
  const telemetry = overrides.telemetry ?? createTelemetry(config);

  const engineSelection = overrides.engine
    ? { engine: overrides.engine, kind: overrides.engine.name ?? 'custom', reason: 'Injected.' }
    : await createMediaEngine(config, logger);

  const providerSelection = overrides.provider
    ? { provider: overrides.provider, kind: overrides.provider.name ?? 'custom', reason: 'Injected.' }
    : createProvider(config, { logger, metrics });

  const store = overrides.store ?? new JobStore(config, logger);
  const artifacts = overrides.artifacts ?? new ArtifactStore(config, logger);

  const orchestrator = overrides.orchestrator ?? new JobOrchestrator({
    config,
    store,
    artifacts,
    engine: engineSelection.engine,
    provider: providerSelection.provider,
    logger,
    metrics,
    telemetry,
    services: overrides.services ?? {},
  });

  if (!config.server.apiToken) {
    logger.warn('No API token configured; the HTTP API is unauthenticated', {
      hint: 'Set DUB_API_TOKEN to require bearer authentication.',
    });
  }

  const app = {
    config,
    logger,
    metrics,
    telemetry,
    store,
    artifacts,
    orchestrator,
    engine: engineSelection.engine,
    engineKind: engineSelection.kind,
    engineReason: engineSelection.reason,
    provider: providerSelection.provider,
    providerKind: providerSelection.kind,
    providerReason: providerSelection.reason,

    async close({ timeoutMs = 15000 } = {}) {
      await orchestrator.shutdown({ timeoutMs });
    },
  };

  logger.info('Application initialized', {
    engine: engineSelection.kind,
    engineReason: engineSelection.reason,
    provider: providerSelection.kind,
    providerReason: providerSelection.reason,
    dataDir: config.dataDir,
  });

  return app;
}

/** Builds only the pieces needed to run pipeline work in-process (CLI, tests). */
export async function createPipelineServices(overrides = {}) {
  return createApplication(overrides);
}
