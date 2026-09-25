import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { startServer } from '../../src/server/server.js';
import { makeLogger } from '../helpers/fixtures.js';
import { sineWav } from '../helpers/fixtures.js';
import os from 'node:os';
import path from 'node:path';

// The server reads its configuration from the environment (see loadConfig), so
// tests set the relevant variables for the duration of a server's lifetime and
// restore them afterwards.
const ENV_KEYS = ['PORT', 'HOST', 'DUB_DATA_DIR', 'DUB_TMP_DIR', 'DUB_API_TOKEN',
  'DUB_MEDIA_ENGINE', 'DUB_FAKE_PROVIDER', 'DUB_FAKE_LATENCY_MS'];

const API_TOKEN = 'test-token-value';

async function boot(t, { token = '', latencyMs = 0 } = {}) {
  const saved = new Map(ENV_KEYS.map((k) => [k, process.env[k]]));
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-api-'));
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-api-tmp-'));
  Object.assign(process.env, {
    HOST: '127.0.0.1',
    PORT: '0',
    DUB_DATA_DIR: dataDir,
    DUB_TMP_DIR: tmpDir,
    DUB_MEDIA_ENGINE: 'mock',
    DUB_FAKE_PROVIDER: 'true',
    DUB_FAKE_LATENCY_MS: String(latencyMs),
  });
  if (token) process.env.DUB_API_TOKEN = token; else delete process.env.DUB_API_TOKEN;

  const handle = await startServer({ logger: makeLogger() });
  t.after(async () => {
    // Destroy idle keep-alive sockets first so `server.close()` does not wait
    // for the 65s keep-alive timeout to expire.
    handle.httpServer.closeAllConnections?.();
    await handle.close();
    await fsp.rm(dataDir, { recursive: true, force: true });
    await fsp.rm(tmpDir, { recursive: true, force: true });
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  return { handle, base: `http://127.0.0.1:${handle.port}`, token };
}

function authHeaders(token) {
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Reads and drains a response body so keep-alive sockets are released. */
async function readJson(res) {
  return res.json();
}

async function uploadJob(base, token, { bytes, fields = {} } = {}) {
  const form = new FormData();
  form.set('file', new Blob([bytes ?? sineWav({ seconds: 6 })], { type: 'audio/wav' }), 'clip.wav');
  form.set('sourceLanguage', fields.sourceLanguage ?? 'en');
  form.set('targetLanguage', fields.targetLanguage ?? 'es');
  if (fields.autoStart) form.set('autoStart', 'true');
  const res = await fetch(`${base}/api/jobs`, { method: 'POST', headers: authHeaders(token), body: form });
  return res;
}

async function waitForCompletion(base, token, jobId, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`${base}/api/jobs/${jobId}?segments=false`, { headers: authHeaders(token) });
    const { job } = await res.json();
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${jobId} did not settle`);
}

test('health and meta are reachable without a token', async (t) => {
  const { base } = await boot(t);

  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  assert.equal((await health.json()).status, 'ok');

  const meta = await fetch(`${base}/api/meta`);
  const body = await readJson(meta);
  assert.equal(body.name, 'youtube-dub');
  assert.ok(body.languages.some((l) => l.code === 'en'));
  assert.ok(body.languages.some((l) => l.code === 'fa'));
  assert.deepEqual(body.sourceLanguageOptions[0], { code: 'auto', name: 'Auto-detect' });
  assert.equal(body.authRequired, false);
});

test('the liveness probe is unauthenticated while the API enforces the token', async (t) => {
  const { base, token } = await boot(t, { token: API_TOKEN });

  const live = await fetch(`${base}/healthz`);
  assert.equal(live.status, 200);
  await live.arrayBuffer();

  const noToken = await fetch(`${base}/api/jobs`);
  assert.equal(noToken.status, 401, 'missing token is rejected');
  await noToken.arrayBuffer();

  const badToken = await fetch(`${base}/api/jobs`, { headers: { authorization: 'Bearer wrong' } });
  assert.equal(badToken.status, 401, 'an invalid token is rejected');
  await badToken.arrayBuffer();

  const ok = await fetch(`${base}/api/jobs`, { headers: authHeaders(token) });
  assert.equal(ok.status, 200);
  await ok.arrayBuffer();
});

test('a job can be uploaded, started, and polled to completion over HTTP', async (t) => {
  const { base, token } = await boot(t);
  const upload = await uploadJob(base, token, { fields: { autoStart: true } });
  assert.equal(upload.status, 201);
  const { job } = await readJson(upload);
  assert.ok(job.jobId.startsWith('job_'));

  const done = await waitForCompletion(base, token, job.jobId);
  assert.equal(done.status, 'completed');
  assert.ok(done.artifacts.finalVideo);
  assert.equal(done.quality.overall, 'pass');
});

test('the job list, segments, transcript, and translations endpoints return data', async (t) => {
  const { base, token } = await boot(t);
  const upload = await uploadJob(base, token, { fields: { autoStart: true } });
  const { job } = await upload.json();
  await waitForCompletion(base, token, job.jobId);

  const list = await (await fetch(`${base}/api/jobs`, { headers: authHeaders(token) })).json();
  assert.ok(list.jobs.some((j) => j.jobId === job.jobId));

  const segments = await (await fetch(`${base}/api/jobs/${job.jobId}/segments`, { headers: authHeaders(token) })).json();
  assert.ok(segments.segments.length > 0);
  assert.equal(segments.total, segments.segments.length);

  const transcript = await (await fetch(`${base}/api/jobs/${job.jobId}/transcript`, { headers: authHeaders(token) })).json();
  assert.ok(transcript.words.length > 0, 'word-level transcript is served');

  const translations = await (await fetch(`${base}/api/jobs/${job.jobId}/translations`, { headers: authHeaders(token) })).json();
  assert.ok(translations.segments.length > 0);
  assert.ok(translations.segments[0].translatedText);
});

test('the final video artifact streams with byte-range support', async (t) => {
  const { base, token } = await boot(t);
  const upload = await uploadJob(base, token, { fields: { autoStart: true } });
  const { job } = await upload.json();
  const done = await waitForCompletion(base, token, job.jobId);

  const url = `${base}/api/jobs/${job.jobId}/artifacts/${done.artifacts.finalVideo}`;
  const full = await fetch(url, { headers: authHeaders(token) });
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('accept-ranges'), 'bytes');
  const size = Number(full.headers.get('content-length'));
  assert.ok(size > 0);
  assert.equal((await full.arrayBuffer()).byteLength, size);

  const ranged = await fetch(url, { headers: { ...authHeaders(token), range: 'bytes=0-99' } });
  assert.equal(ranged.status, 206);
  assert.match(ranged.headers.get('content-range'), /^bytes 0-99\/\d+$/);
  assert.equal(Number(ranged.headers.get('content-length')), 100);
  assert.equal((await ranged.arrayBuffer()).byteLength, 100);

  const bad = await fetch(url, { headers: { ...authHeaders(token), range: 'bytes=99999999-' } });
  assert.equal(bad.status, 416);
  await bad.arrayBuffer();
});

test('artifact requests cannot escape the job directory', async (t) => {
  const { base, token } = await boot(t);
  const upload = await uploadJob(base, token, { fields: { autoStart: true } });
  const { job } = await upload.json();
  await waitForCompletion(base, token, job.jobId);

  for (const evil of ['../../../../etc/passwd', '..%2f..%2fjob.json', 'final/../../../etc/hosts']) {
    const res = await fetch(`${base}/api/jobs/${job.jobId}/artifacts/${evil}`, { headers: authHeaders(token) });
    assert.ok(res.status >= 400, `traversal path ${evil} must be rejected, got ${res.status}`);
    await res.arrayBuffer();
  }
});

test('artifact resolution is scoped to the owning job', async (t) => {
  const { base, token } = await boot(t);
  const first = await (await uploadJob(base, token, { fields: { autoStart: true } })).json();
  const second = await (await uploadJob(base, token, { fields: { autoStart: true } })).json();
  const firstDone = await waitForCompletion(base, token, first.job.jobId);
  await waitForCompletion(base, token, second.job.jobId);

  // A source path is not a servable artifact and is not a stage prefix, so it
  // must be refused even though the file exists in the job directory.
  const forged = await fetch(`${base}/api/jobs/${second.job.jobId}/artifacts/input/clip.wav`, {
    headers: authHeaders(token),
  });
  assert.equal(forged.status, 404);
  await forged.arrayBuffer();

  // A stage-prefixed path from job B resolves inside job B's own tree, so the
  // request never reaches job A's files even when the relative path matches.
  const streamed = await fetch(
    `${base}/api/jobs/${second.job.jobId}/artifacts/final/dubbed.mp4`,
    { headers: authHeaders(token) },
  );
  assert.equal(streamed.status, 200);
  assert.ok(Buffer.from(await streamed.arrayBuffer()).length > 0);

  // The same relative path under job A is served from job A's tree.
  const fromA = await fetch(
    `${base}/api/jobs/${first.job.jobId}/artifacts/${firstDone.artifacts.finalVideo}`,
    { headers: authHeaders(token) },
  );
  assert.equal(fromA.status, 200);
  assert.ok((await fromA.arrayBuffer()).byteLength > 0);
});

test('an upload with an unsupported extension is rejected with a validation error', async (t) => {
  const { base, token } = await boot(t);
  const res = await uploadJob(base, token, { bytes: Buffer.from('not media at all') });
  // A .wav name with garbage bytes: staged validation should reject it.
  assert.ok(res.status >= 400);
  const body = await readJson(res);
  assert.ok(body.error?.code, 'a structured error is returned');
});

test('source and target language must differ', async (t) => {
  const { base, token } = await boot(t);
  const res = await uploadJob(base, token, { fields: { sourceLanguage: 'en', targetLanguage: 'en' } });
  assert.equal(res.status, 400);
  assert.equal((await readJson(res)).error.code, 'VALIDATION');
});

test('Persian and automatic source languages are accepted by the API', async (t) => {
  const { base, token } = await boot(t);

  const automatic = await uploadJob(base, token, {
    fields: { sourceLanguage: 'auto', targetLanguage: 'fa' },
  });
  assert.equal(automatic.status, 201);
  assert.equal((await readJson(automatic)).job.languages.source, 'auto');

  const persianSource = await uploadJob(base, token, {
    fields: { sourceLanguage: 'fa', targetLanguage: 'en' },
  });
  assert.equal(persianSource.status, 201);

  const automaticTarget = await uploadJob(base, token, {
    fields: { sourceLanguage: 'en', targetLanguage: 'auto' },
  });
  assert.equal(automaticTarget.status, 400);
  assert.equal((await readJson(automaticTarget)).error.code, 'VALIDATION');
});

test('unknown jobs, unknown routes, and bad ids return structured errors', async (t) => {
  const { base, token } = await boot(t);

  const missing = await fetch(`${base}/api/jobs/job_doesnotexist_0000`, { headers: authHeaders(token) });
  assert.equal(missing.status, 404);
  assert.ok((await missing.json()).error.code);

  const traversalId = await fetch(`${base}/api/jobs/..%2f..%2fetc/segments`, { headers: authHeaders(token) });
  assert.ok([400, 404].includes(traversalId.status));
  await traversalId.arrayBuffer();

  const unknown = await fetch(`${base}/api/nope`, { headers: authHeaders(token) });
  assert.equal(unknown.status, 404);
  await unknown.arrayBuffer();
});

test('a running job can be cancelled through the API', async (t) => {
  // A high provider latency keeps the job in a cancellable state without heavy
  // CPU work, so the test stays reliable even when the suite runs in parallel.
  const { base } = await boot(t, { latencyMs: 200 });

  const { job } = await (await uploadJob(base, '', { bytes: sineWav({ seconds: 20 }) })).json();
  await (await fetch(`${base}/api/jobs/${job.jobId}/start`, { method: 'POST' })).arrayBuffer();
  await new Promise((r) => setTimeout(r, 250));

  const cancel = await fetch(`${base}/api/jobs/${job.jobId}/cancel`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason: 'api cancel test' }),
  });
  assert.equal(cancel.status, 202);
  await cancel.arrayBuffer();

  const settled = await waitForCompletion(base, '', job.jobId, { timeoutMs: 60_000 });
  assert.equal(settled.status, 'cancelled');
  assert.equal(settled.cancellation.reason, 'api cancel test');
});

test('metrics are exposed in JSON and Prometheus formats', async (t) => {
  const { base, token } = await boot(t);
  const upload = await uploadJob(base, token, { fields: { autoStart: true } });
  const { job } = await upload.json();
  await waitForCompletion(base, token, job.jobId);

  const json = await readJson(await fetch(`${base}/api/metrics`, { headers: authHeaders(token) }));
  assert.ok(json.counters, 'metric counters are present');

  const prom = await fetch(`${base}/api/metrics/prometheus`, { headers: authHeaders(token) });
  assert.equal(prom.status, 200);
  assert.match(prom.headers.get('content-type'), /text\/plain/);
  assert.match(await prom.text(), /dub_jobs_created_total/);
  await prom.arrayBuffer().catch(() => {});
});

test('deleting a job over the API removes it', async (t) => {
  const { base, token } = await boot(t);
  const { job } = await (await uploadJob(base, token, { fields: { autoStart: true } })).json();
  await waitForCompletion(base, token, job.jobId);

  const del = await fetch(`${base}/api/jobs/${job.jobId}`, { method: 'DELETE', headers: authHeaders(token) });
  assert.equal(del.status, 204);
  await del.arrayBuffer();
  const gone = await fetch(`${base}/api/jobs/${job.jobId}`, { headers: authHeaders(token) });
  assert.equal(gone.status, 404);
  await gone.arrayBuffer();
});

test('the Studio static bundle is served at the root', async (t) => {
  const { base } = await boot(t);
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html/i, 'index.html is served');
  const assets = await fsp.readdir(new URL('../../public/js', import.meta.url));
  assert.ok(assets.includes('app.js'));

  const css = await (await fetch(`${base}/css/studio.css`)).text();
  assert.match(css, /\.artifact-video\s*\{[\s\S]*?width:\s*100%/);
  assert.match(css, /max-height:\s*min\(420px,\s*60vh\)/);
  assert.match(css, /\.artifact-video\s*\{[\s\S]*?object-fit:\s*contain/);
  const views = await (await fetch(`${base}/js/views.js`)).text();
  assert.match(views, /class:\s*'artifact-video'/);
});
