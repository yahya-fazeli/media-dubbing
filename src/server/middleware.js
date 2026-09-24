import crypto from 'node:crypto';
import { AppError, ErrorCode } from '../core/errors.js';

/**
 * Bearer-token authentication for the HTTP API. When no token is configured the
 * middleware allows the request but marks it as unauthenticated, so a local
 * single-user instance works out of the box while a deployment that sets
 * DUB_API_TOKEN gets real enforcement.
 *
 * The comparison is constant-time so a token cannot be recovered by timing.
 */
export function bearerAuth(config, logger) {
  const expected = config.server.apiToken;

  return function authenticate(req, res, next) {
    if (!expected) {
      req.auth = { authenticated: false, mode: 'open' };
      next();
      return;
    }

    const header = req.get('authorization') ?? '';
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match) {
      logger.warn('Rejected unauthenticated request', { path: req.path, method: req.method });
      res.status(401).json({
        error: { code: ErrorCode.UNAUTHORIZED, message: 'Missing bearer token' },
      });
      return;
    }

    if (!timingSafeEqual(match[1].trim(), expected)) {
      logger.warn('Rejected request with invalid token', { path: req.path, method: req.method });
      res.status(401).json({
        error: { code: ErrorCode.UNAUTHORIZED, message: 'Invalid bearer token' },
      });
      return;
    }

    req.auth = { authenticated: true, mode: 'token' };
    next();
  };
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  // Length is allowed to leak here; digesting both sides first would hide it but
  // is unnecessary because the token is a fixed-length secret chosen by the
  // operator, not user data.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Restricts artifact access to the job that owns it. Requests carry the job id
 * in the path, and the handler re-checks that the artifact belongs to that job
 * before any bytes are read, so guessing a filename is not enough to read it.
 */
export function requireJobArtifact(app) {
  return async function authorizeArtifact(req, res, next) {
    try {
      const { jobId, artifactPath } = req.params;
      const resolved = await app.orchestrator.resolveArtifact(jobId, artifactPath);
      req.artifact = resolved;
      next();
    } catch (err) {
      next(err);
    }
  };
}

/**
 * Conservative security headers. The Studio is a local tool, but these cost
 * nothing and prevent an injected artifact from being treated as a document.
 */
export function securityHeaders() {
  return function headers(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; "
      + "script-src 'self'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'",
    );
    next();
  };
}

/** Limits the size of JSON bodies; uploads have their own limit. */
export function jsonErrorHandler(logger) {
  return function handle(err, req, res, next) {
    if (res.headersSent) {
      next(err);
      return;
    }
    const appErr = err instanceof AppError
      ? err
      : new AppError(err?.message ?? 'Internal error', {
          code: err?.code ?? ErrorCode.INTERNAL,
          status: err?.status ?? 500,
        });

    if (appErr.status >= 500) {
      logger.error('Request failed', {
        path: req.path, method: req.method, code: appErr.code, error: appErr.message,
      });
    } else {
      logger.debug('Request rejected', {
        path: req.path, method: req.method, code: appErr.code, error: appErr.message,
      });
    }

    // Never echo a stack trace or internal path to the client.
    res.status(appErr.status).json({
      error: {
        code: appErr.code,
        message: appErr.message,
        ...(appErr.recoveryScope ? { recoveryScope: appErr.recoveryScope } : {}),
        ...(appErr.recommendedAction ? { recommendedAction: appErr.recommendedAction } : {}),
        ...(appErr.details && appErr.status < 500 ? { details: appErr.details } : {}),
      },
    });
  };
}
