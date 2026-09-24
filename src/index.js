/**
 * Public module entrypoint. The package is normally used through the CLI
 * (`bin/youtube-dub.js`) or the HTTP server, but these exports let it be embedded
 * in another Node application or a test harness.
 */
export { createApplication, createPipelineServices } from './app.js';
export { buildServer, startServer } from './server/server.js';
export { loadConfig, ensureDataDirs, SUPPORTED_LANGUAGES } from './config.js';
export { JobOrchestrator } from './pipeline/orchestrator.js';
export { JobStore } from './core/job-store.js';
export { ArtifactStore } from './core/artifact-store.js';
export { createMediaEngine } from './media/index.js';
export { createProvider } from './providers/index.js';
export { createLogger } from './core/logger.js';
export { createMetrics } from './core/metrics.js';
export { AppError, ErrorCode, RecoveryScope } from './core/errors.js';
export {
  JobStatus, StageName, StageStatus, SegmentStatus, PIPELINE_ORDER,
} from './core/job-model.js';
