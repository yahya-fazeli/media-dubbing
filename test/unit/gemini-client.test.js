import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeminiClient } from '../../src/providers/gemini-client.js';
import { loadConfig } from '../../src/config.js';
import { MetricsRegistry } from '../../src/core/metrics.js';
import { ErrorCode } from '../../src/core/errors.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

function makeClient(overrides = {}) {
  const config = loadConfig({ dataDir: '/tmp/gemini-client-test' });
  config.providers.gemini.apiKeys = overrides.apiKeys ?? ['key-one', 'key-two'];
  config.providers.gemini.baseUrl = 'https://gemini.test/v1beta';
  config.providers.gemini.maxAttempts = overrides.maxAttempts ?? 3;
  config.providers.gemini.baseBackoffMs = 1;
  config.providers.gemini.maxBackoffMs = 2;
  config.providers.gemini.requestTimeoutMs = overrides.requestTimeoutMs ?? 5000;
  config.providers.gemini.quotaCooldownMs = 50;

  const metrics = new MetricsRegistry();
  const client = new GeminiClient(config, {
    logger: silentLogger,
    metrics,
    fetchImpl: overrides.fetchImpl,
    random: () => 0,
  });
  return { client, config, metrics };
}

/** Builds a fetch stub that records every call and replays scripted responses. */
function stubFetch(script) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const step = script[Math.min(calls.length - 1, script.length - 1)];
    return step(url, init, calls.length - 1);
  };
  fn.calls = calls;
  return fn;
}

const okResponse = (json) => ({
  ok: true,
  status: 200,
  async json() { return json; },
  async text() { return JSON.stringify(json); },
});

const errResponse = (status, text = 'error') => ({
  ok: false,
  status,
  async json() { return { error: text }; },
  async text() { return text; },
});

const PARSE = (json) => ({ parsed: true, raw: json });
const BUILD = (model) => ({ contents: [{ parts: [{ text: `hi-${model}` }] }] });

test('generateContent posts to the model endpoint with the key in a header', async () => {
  const fetchImpl = stubFetch([() => okResponse({ candidates: [] })]);
  const { client } = makeClient({ fetchImpl });

  const result = await client.generateContent({
    models: ['gemini-2.5-flash'],
    buildBody: BUILD,
    operation: 'transcribe',
    parse: PARSE,
  });

  assert.deepEqual(result, { parsed: true, raw: { candidates: [] } });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, init } = fetchImpl.calls[0];
  assert.equal(url, 'https://gemini.test/v1beta/models/gemini-2.5-flash:generateContent');
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  // KeyPool.next() advances its cursor before reading, so the first call uses
  // the second configured key. See the rotation-order test below.
  assert.equal(init.headers['x-goog-api-key'], 'key-two');
});

test('the API key never appears in the request URL', async () => {
  const fetchImpl = stubFetch([() => okResponse({})]);
  const { client } = makeClient({ fetchImpl, apiKeys: ['super-secret-key'] });

  await client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'translate' });

  const { url } = fetchImpl.calls[0];
  assert.ok(!url.includes('super-secret-key'), `key leaked into URL: ${url}`);
  assert.ok(!url.includes('key='), 'keys must not travel as query strings');
});

test('buildBody receives the model so callers can vary the payload', async () => {
  const fetchImpl = stubFetch([() => okResponse({})]);
  const { client } = makeClient({ fetchImpl });
  let seenModel = null;

  await client.generateContent({
    models: ['model-a'],
    buildBody: (model) => { seenModel = model; return {}; },
    operation: 'tts',
  });

  assert.equal(seenModel, 'model-a');
  assert.deepEqual(JSON.parse(fetchImpl.calls[0].init.body), {});
});

test('generateContent refuses to run with no configured keys', async () => {
  const { client } = makeClient({ apiKeys: [], fetchImpl: stubFetch([() => okResponse({})]) });
  assert.equal(client.configured, false);

  await assert.rejects(
    () => client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'transcribe' }),
    (err) => err.code === ErrorCode.PROVIDER_AUTH,
  );
});

test('a quota response rotates to another key and can still succeed', async () => {
  const fetchImpl = stubFetch([
    () => errResponse(429, 'quota exceeded'),
    () => okResponse({ ok: true }),
  ]);
  const { client, metrics } = makeClient({ fetchImpl, apiKeys: ['key-one', 'key-two'] });

  const result = await client.generateContent({
    models: ['m'], buildBody: BUILD, operation: 'transcribe', parse: PARSE,
  });

  assert.equal(result.parsed, true);
  assert.equal(fetchImpl.calls.length, 2, 'the quota retry must try another key');
  const usedKeys = fetchImpl.calls.map((c) => c.init.headers['x-goog-api-key']);
  assert.notEqual(usedKeys[0], usedKeys[1], 'the retry must not reuse the same key');

  const snap = metrics.snapshot();
  assert.ok(snap.counters.some((c) => c.name === 'dub_provider_quota_events_total'));
});

test('an auth failure fails fast and permanently blocks the key', async () => {
  const fetchImpl = stubFetch([() => errResponse(401, 'invalid key')]);
  const { client } = makeClient({ fetchImpl });

  await assert.rejects(
    () => client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'transcribe' }),
    (err) => err.code === ErrorCode.PROVIDER_AUTH,
  );

  // Auth is fatal for the key, so retrying the same key cannot help.
  assert.equal(fetchImpl.calls.length, 1, 'auth failures must not burn the retry budget');
  const blocked = client.keyHealth().filter((k) => k.blockedUntil === Number.MAX_SAFE_INTEGER);
  assert.equal(blocked.length, 1, `expected one permanently blocked key, got ${JSON.stringify(client.keyHealth())}`);
});

test('KeyPool rotation advances the cursor so distinct keys are preferred', async () => {
  // Characterizes the rotation contract: consecutive calls pick distinct keys,
  // even though the first call is not the zero-index key.
  const fetchImpl = stubFetch([() => okResponse({})]);
  const { client } = makeClient({ fetchImpl, apiKeys: ['k1', 'k2', 'k3'] });

  const used = [];
  for (let i = 0; i < 3; i += 1) {
    await client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'transcribe' });
    used.push(fetchImpl.calls[i].init.headers['x-goog-api-key']);
  }
  assert.equal(new Set(used).size, 3, `expected three distinct keys, got ${used.join(',')}`);
});

test('an unavailable model falls back to the next model in the chain', async () => {
  const fetchImpl = stubFetch([
    () => errResponse(400, 'model gemini-2.5-flash is not found'),
    () => okResponse({ fromFallback: true }),
  ]);
  const { client, metrics } = makeClient({ fetchImpl });

  const result = await client.generateContent({
    models: ['gemini-2.5-flash', 'gemini-2.0-flash'],
    buildBody: BUILD,
    operation: 'translate',
    parse: PARSE,
  });

  assert.deepEqual(result.raw, { fromFallback: true });
  assert.match(fetchImpl.calls[0].url, /gemini-2\.5-flash/);
  assert.match(fetchImpl.calls[1].url, /gemini-2\.0-flash/);
  assert.ok(metrics.snapshot().counters.some((c) => c.name === 'dub_provider_model_fallbacks_total'));
});

test('a malformed request is not retried, though the chain still advances', async () => {
  const fetchImpl = stubFetch([() => errResponse(400, 'invalid argument: bad field')]);
  const { client } = makeClient({ fetchImpl });

  await assert.rejects(
    () => client.generateContent({
      models: ['m1', 'm2'], buildBody: BUILD, operation: 'transcribe',
    }),
    (err) => err.code === ErrorCode.PROVIDER_ERROR && err.retryable === false,
  );

  // A 400 is not retried against the same model (it would fail identically), but
  // the client does move on to the next model in the chain once.
  assert.equal(fetchImpl.calls.length, 2, 'one attempt per model, no retries within a model');
  assert.match(fetchImpl.calls[0].url, /m1/);
  assert.match(fetchImpl.calls[1].url, /m2/);
});

test('repeated server errors exhaust the bounded retry budget', async () => {
  const fetchImpl = stubFetch([() => errResponse(503, 'unavailable')]);
  const { client } = makeClient({ fetchImpl, maxAttempts: 3 });

  await assert.rejects(
    () => client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'transcribe' }),
    (err) => err.code === ErrorCode.PROVIDER_ERROR,
  );
  assert.equal(fetchImpl.calls.length, 3, 'retries must be bounded by maxAttempts');
});

test('a transient error that clears on retry succeeds', async () => {
  const fetchImpl = stubFetch([
    () => errResponse(500, 'boom'),
    () => okResponse({ recovered: true }),
  ]);
  const { client } = makeClient({ fetchImpl });

  const result = await client.generateContent({
    models: ['m'], buildBody: BUILD, operation: 'tts', parse: PARSE,
  });
  assert.equal(result.raw.recovered, true);
  assert.equal(fetchImpl.calls.length, 2);
});

test('a hanging request times out with a retryable TimeoutError', async () => {
  // Never resolves on its own; only the client's abort signal is expected to end it.
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const { client } = makeClient({ fetchImpl, requestTimeoutMs: 80, maxAttempts: 1 });

  await assert.rejects(
    () => client.generateContent({
      models: ['m'], buildBody: BUILD, operation: 'transcribe', stage: 'transcribe', segmentId: 'seg_00001',
    }),
    (err) => {
      assert.equal(err.code, ErrorCode.TIMEOUT);
      assert.equal(err.retryable, true);
      assert.equal(err.stage, 'transcribe');
      return true;
    },
  );
});

test('an aborted signal cancels the request immediately', async () => {
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new Error('aborted')));
  });
  const { client } = makeClient({ fetchImpl, requestTimeoutMs: 60_000, maxAttempts: 3 });
  const controller = new AbortController();

  const promise = client.generateContent({
    models: ['m'], buildBody: BUILD, operation: 'transcribe', signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 40);

  await assert.rejects(promise, (err) => err.code === ErrorCode.CANCELLED);
});

test('an already-aborted signal short-circuits before any fetch', async () => {
  const fetchImpl = stubFetch([() => okResponse({})]);
  const { client } = makeClient({ fetchImpl });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => client.generateContent({
      models: ['m'], buildBody: BUILD, operation: 'transcribe', signal: controller.signal,
    }),
    (err) => err.code === ErrorCode.CANCELLED,
  );
  assert.equal(fetchImpl.calls.length, 0);
});

test('provider metrics are recorded for calls, durations, and errors', async () => {
  const fetchImpl = stubFetch([
    () => errResponse(503, 'down'),
    () => okResponse({}),
  ]);
  const { client, metrics } = makeClient({ fetchImpl });

  await client.generateContent({ models: ['m'], buildBody: BUILD, operation: 'translate' });

  const snap = metrics.snapshot();
  const calls = snap.counters.find((c) => c.name === 'dub_provider_calls_total');
  assert.equal(calls.value, 2);
  assert.equal(calls.labels.operation, 'translate');
  assert.ok(snap.counters.some((c) => c.name === 'dub_provider_errors_total'));
  assert.ok(snap.histograms.some((h) => h.name === 'dub_provider_duration_ms'));
});

test('key health is described without revealing key material', async () => {
  const { client } = makeClient({ apiKeys: ['sk-live-abcdef123456', 'sk-live-zzzz999999'] });
  const description = JSON.stringify(client.keyHealth());
  assert.ok(!description.includes('sk-live-abcdef123456'), `key leaked: ${description}`);
  assert.ok(!description.includes('sk-live-zzzz999999'), `key leaked: ${description}`);
  assert.equal(client.keyPoolSize, 2);
  // Only a short fingerprint may be exposed.
  assert.match(client.keyHealth()[0].fingerprint, /^sk-l/);
});
