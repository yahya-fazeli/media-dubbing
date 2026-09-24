import express from 'express';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { createApplication } from '../app.js';
import { createApiRouter } from './api.js';
import { bearerAuth, securityHeaders, jsonErrorHandler } from './middleware.js';
import { ErrorCode } from '../core/errors.js';
import { ensureDir } from '../core/fsutil.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, '../../public');

/**
 * Builds the Express app. Kept separate from `listen` so tests can mount the app
 * on an ephemeral port and CLI commands can reuse the same wiring.
 */
export async function buildServer(overrides = {}) {
  const app = await createApplication(overrides);
  const { config, logger } = app;

  const stagingDir = path.join(config.tmpDir, 'uploads');
  await ensureDir(stagingDir);

  const server = express();
  server.disable('x-powered-by');
  if (config.server.trustProxy) server.set('trust proxy', true);

  server.use(securityHeaders());

  // Unauthenticated liveness probe, kept outside the auth gate so container
  // health checks do not need credentials.
  server.get('/healthz', (req, res) => res.json({ status: 'ok' }));

  server.use('/api', bearerAuth(config, logger), createApiRouter(app, { uploadDir: stagingDir }));

  // Static Studio. Served without auth because it holds no data of its own; the
  // data endpoints it calls are authenticated.
  server.use(express.static(publicDir, {
    index: 'index.html',
    setHeaders: (res, filePath) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
    },
  }));

  server.get('/', (req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  server.use((req, res) => {
    res.status(404).json({ error: { code: ErrorCode.NOT_FOUND, message: 'Not found' } });
  });

  server.use(jsonErrorHandler(logger));

  return { app, server };
}

/**
 * Starts the HTTP server. Returns a handle with a `close()` that drains active
 * jobs first, so a restart does not leave jobs stuck in `running`.
 */
export async function startServer(overrides = {}) {
  const { app, server } = await buildServer(overrides);
  const { config, logger, orchestrator } = app;

  // Jobs left running by a previous process are marked resumable, not resumed
  // automatically: the operator decides when to spend the compute.
  await orchestrator.recoverInterruptedJobs();

  const httpServer = http.createServer(server);
  // Uploads of large media can take a while; keep the header timeout generous
  // but bounded so a stalled client cannot hold a socket forever.
  httpServer.headersTimeout = 120_000;
  httpServer.requestTimeout = 0;
  httpServer.keepAliveTimeout = 65_000;

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.server.port, config.server.host, resolve);
  });

  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : config.server.port;
  logger.info('Server listening', { host: config.server.host, port, engine: app.engineKind, provider: app.providerKind });

  let closing = false;
  return {
    app,
    server,
    httpServer,
    port,
    url: `http://${config.server.host}:${port}`,
    async close({ timeoutMs = 15000 } = {}) {
      if (closing) return;
      closing = true;
      await app.close({ timeoutMs });
      await new Promise((resolve) => httpServer.close(resolve));
      logger.info('Server stopped');
    },
  };
}

export { createApplication };
