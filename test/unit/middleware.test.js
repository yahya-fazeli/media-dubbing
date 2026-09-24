import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import { bearerAuth, securityHeaders, jsonErrorHandler } from '../../src/server/middleware.js';
import { AppError, ErrorCode, ValidationError } from '../../src/core/errors.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

/** Boots a tiny Express app with the middleware under test and returns a fetch helper. */
async function boot(t, build) {
  const app = express();
  build(app);
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  const { port } = server.address();
  return async (path, init) => fetch(`http://127.0.0.1:${port}${path}`, init);
}

test('bearerAuth leaves the request open when no token is configured', async (t) => {
  const request = await boot(t, (app) => {
    app.use(bearerAuth({ server: { apiToken: '' } }, silentLogger));
    app.get('/x', (req, res) => res.json({ auth: req.auth }));
  });

  const res = await request('/x');
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.auth, { authenticated: false, mode: 'open' });
});

test('bearerAuth rejects a missing or malformed Authorization header', async (t) => {
  const request = await boot(t, (app) => {
    app.use(bearerAuth({ server: { apiToken: 'secret-token' } }, silentLogger));
    app.get('/x', (req, res) => res.json({ ok: true }));
  });

  const missing = await request('/x');
  assert.equal(missing.status, 401);
  assert.equal((await missing.json()).error.code, ErrorCode.UNAUTHORIZED);

  const wrongScheme = await request('/x', { headers: { authorization: 'Basic abc' } });
  assert.equal(wrongScheme.status, 401);
});

test('bearerAuth accepts the exact token and rejects a wrong one', async (t) => {
  const request = await boot(t, (app) => {
    app.use(bearerAuth({ server: { apiToken: 'secret-token' } }, silentLogger));
    app.get('/x', (req, res) => res.json({ auth: req.auth }));
  });

  const ok = await request('/x', { headers: { authorization: 'Bearer secret-token' } });
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).auth, { authenticated: true, mode: 'token' });

  // Scheme matching is case-insensitive; the token comparison is exact.
  const upper = await request('/x', { headers: { authorization: 'BEARER secret-token' } });
  assert.equal(upper.status, 200);

  const bad = await request('/x', { headers: { authorization: 'Bearer secret-tokeX' } });
  assert.equal(bad.status, 401);

  // A shorter token must be rejected rather than throwing from timingSafeEqual.
  const short = await request('/x', { headers: { authorization: 'Bearer x' } });
  assert.equal(short.status, 401);
});

test('bearerAuth never returns the expected token in an error body', async (t) => {
  const request = await boot(t, (app) => {
    app.use(bearerAuth({ server: { apiToken: 'super-secret-token' } }, silentLogger));
    app.get('/x', (req, res) => res.json({ ok: true }));
  });
  const res = await request('/x', { headers: { authorization: 'Bearer nope' } });
  const text = await res.text();
  assert.ok(!text.includes('super-secret-token'), `token leaked in response: ${text}`);
});

test('securityHeaders sets the documented protective headers', async (t) => {
  const request = await boot(t, (app) => {
    app.use(securityHeaders());
    app.get('/x', (req, res) => res.send('ok'));
  });

  const res = await request('/x');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
});

test('jsonErrorHandler maps an AppError to its status and structured body', async (t) => {
  const request = await boot(t, (app) => {
    app.get('/x', () => { throw new ValidationError('bad input', { details: { field: 'x' } }); });
    app.use(jsonErrorHandler(silentLogger));
  });

  const res = await request('/x');
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.error.code, ErrorCode.VALIDATION);
  assert.equal(body.error.message, 'bad input');
  assert.deepEqual(body.error.details, { field: 'x' });
});

test('jsonErrorHandler passes through recoveryScope and recommendedAction', async (t) => {
  const request = await boot(t, (app) => {
    app.get('/x', () => {
      throw new AppError('timed out', {
        code: ErrorCode.TIMEOUT, status: 504, retryable: true,
        recoveryScope: 'stage', recommendedAction: 'Retry the stage.',
      });
    });
    app.use(jsonErrorHandler(silentLogger));
  });

  const body = await (await request('/x')).json();
  assert.equal(body.error.recoveryScope, 'stage');
  assert.equal(body.error.recommendedAction, 'Retry the stage.');
});

test('jsonErrorHandler never leaks a stack or internal details on a 500', async (t) => {
  const request = await boot(t, (app) => {
    app.get('/x', () => {
      const err = new Error('/internal/path/leaked');
      err.status = 500;
      err.details = { sensitive: 'stack info' };
      throw err;
    });
    app.use(jsonErrorHandler(silentLogger));
  });

  const res = await request('/x');
  assert.equal(res.status, 500);
  const body = await res.json();
  assert.equal(body.error.code, ErrorCode.INTERNAL);
  assert.equal(body.error.details, undefined, '500 responses must not expose details');
  assert.equal(body.error.stack, undefined);
});

test('jsonErrorHandler delegates when the response has already been sent', async (t) => {
  const request = await boot(t, (app) => {
    app.get('/x', (req, res) => {
      res.status(200).json({ partial: true });
      throw new Error('after send');
    });
    // Express only invokes error handlers at the point they are registered, so
    // this one runs after the route has already flushed its body.
    app.use(jsonErrorHandler(silentLogger));
  });

  const res = await request('/x');
  assert.equal(res.status, 200, 'a late error must not rewrite the response status');
  assert.deepEqual(await res.json(), { partial: true });
});
