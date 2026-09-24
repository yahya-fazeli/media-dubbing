import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPool, ModelChain } from '../../src/providers/key-pool.js';
import {
  FailureClass, classifyHttpStatus, classifyError, backoffDelay, withRetries,
} from '../../src/providers/retry.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { CancelledError, ProviderError } from '../../src/core/errors.js';
import { CancelToken } from '../../src/core/cancellation.js';

test('KeyPool de-duplicates keys and reports size', () => {
  const pool = new KeyPool([' a ', 'b', 'a', '', '  ']);
  assert.equal(pool.size, 2);
});

test('KeyPool rotates through distinct keys on successive calls', () => {
  const pool = new KeyPool(['k1', 'k2', 'k3']);
  const seen = new Set();
  for (let i = 0; i < 3; i += 1) seen.add(pool.next().key);
  assert.equal(seen.size, 3, 'each call should prefer an unused key');
});

test('KeyPool throws an actionable error when no keys are configured', () => {
  const pool = new KeyPool([]);
  assert.throws(
    () => pool.next(),
    (err) => err.code === 'PROVIDER_AUTH' && /GEMINI_API_KEYS/.test(err.recommendedAction),
  );
});

test('KeyPool blocks an auth-failed key permanently', () => {
  const pool = new KeyPool(['bad', 'good']);
  pool.recordFailure('bad', { authFailed: true });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(pool.next().key, 'good');
  }
});

test('KeyPool cools a key down after repeated transient failures', () => {
  const pool = new KeyPool(['k1'], { cooldownMs: 50 });
  pool.recordFailure('k1');
  assert.equal(pool.next().key, 'k1', 'one failure should not block the key');

  pool.recordFailure('k1');
  pool.recordFailure('k1');
  assert.throws(() => pool.next(), (err) => err.code === 'PROVIDER_QUOTA' && err.retryable === true);

  return new Promise((resolve) => {
    setTimeout(() => {
      assert.equal(pool.next().key, 'k1', 'key should return after the cooldown');
      resolve();
    }, 70);
  });
});

test('KeyPool.describe never reveals full key material', () => {
  const pool = new KeyPool(['super-secret-key-value']);
  const [info] = pool.describe();
  assert.ok(!JSON.stringify(info).includes('super-secret-key-value'));
  assert.equal(info.fingerprint, 'supe...alue');
  assert.equal(info.fingerprint.length, 11, 'only a short fingerprint is exposed');
});

test('ModelChain yields the primary first then fallbacks', () => {
  const chain = new ModelChain('primary', ['secondary', 'tertiary']);
  assert.deepEqual([...chain.candidates()], ['primary', 'secondary', 'tertiary']);
});

test('ModelChain skips models that have permanently failed', () => {
  const chain = new ModelChain('primary', ['secondary']);
  chain.markFailed('primary');
  assert.deepEqual([...chain.candidates()], ['secondary']);
});

test('ModelChain falls back to all models when every one has failed', () => {
  const chain = new ModelChain('primary', ['secondary']);
  chain.markFailed('primary');
  chain.markFailed('secondary');
  assert.equal([...chain.candidates()].length, 2);
  chain.reset();
  assert.deepEqual([...chain.candidates()], ['primary', 'secondary']);
});

test('classifyHttpStatus maps statuses to failure classes', () => {
  assert.equal(classifyHttpStatus(429), FailureClass.QUOTA);
  assert.equal(classifyHttpStatus(401), FailureClass.AUTH);
  assert.equal(classifyHttpStatus(403), FailureClass.AUTH);
  assert.equal(classifyHttpStatus(400), FailureClass.INVALID);
  assert.equal(classifyHttpStatus(500), FailureClass.TRANSIENT);
  assert.equal(classifyHttpStatus(503), FailureClass.TRANSIENT);
  assert.equal(classifyHttpStatus(200, 'RESOURCE_EXHAUSTED'), FailureClass.QUOTA);
  assert.equal(classifyHttpStatus(418), FailureClass.PERMANENT);
});

test('classifyError recognizes cancellation and transient network faults', () => {
  assert.equal(classifyError(new CancelledError('x')), FailureClass.CANCELLED);
  assert.equal(classifyError(new ProviderError('q', { code: 'PROVIDER_QUOTA' })), FailureClass.QUOTA);
  assert.equal(classifyError(new ProviderError('a', { code: 'PROVIDER_AUTH' })), FailureClass.AUTH);

  const econn = new Error('reset');
  econn.code = 'ECONNRESET';
  assert.equal(classifyError(econn), FailureClass.TRANSIENT);
  assert.equal(classifyError(new Error('nope')), FailureClass.PERMANENT);
});

test('backoffDelay grows exponentially and stays within bounds', () => {
  const noJitterHigh = () => 1;
  const noJitterLow = () => 0;
  assert.equal(backoffDelay(1, 100, 5000, noJitterHigh), 100);
  assert.equal(backoffDelay(3, 100, 5000, noJitterHigh), 400);
  assert.equal(backoffDelay(10, 100, 5000, noJitterHigh), 5000);
  assert.equal(backoffDelay(1, 100, 5000, noJitterLow), 50);
});

test('withRetries returns immediately on success', async () => {
  let calls = 0;
  const result = await withRetries(async () => { calls += 1; return 'ok'; }, { maxAttempts: 3, baseDelayMs: 1 });
  assert.equal(result, 'ok');
  assert.equal(calls, 1);
});

test('withRetries retries transient network failures until success', async () => {
  let calls = 0;
  const result = await withRetries(async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('connection reset');
      err.code = 'ECONNRESET';
      throw err;
    }
    return 'recovered';
  }, { maxAttempts: 5, baseDelayMs: 1 });
  assert.equal(result, 'recovered');
  assert.equal(calls, 3);
});

test('withRetries gives up after maxAttempts and preserves the last error', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      const err = new Error('always down');
      err.code = 'ETIMEDOUT';
      throw err;
    }, { maxAttempts: 3, baseDelayMs: 1 }),
    /always down/,
  );
  assert.equal(calls, 3);
});

test('withRetries does not retry auth failures', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw new ProviderError('bad key', { code: 'PROVIDER_AUTH' });
    }, { maxAttempts: 4, baseDelayMs: 1 }),
    /bad key/,
  );
  assert.equal(calls, 1, 'an auth failure must fail fast');
});

test('withRetries does not retry malformed-request failures', async () => {
  let calls = 0;
  await assert.rejects(
    withRetries(async () => {
      calls += 1;
      throw new ProviderError('invalid payload', { code: 'PROVIDER_INVALID' });
    }, { maxAttempts: 4, baseDelayMs: 1 }),
    /invalid payload/,
  );
  assert.equal(calls, 1, 'an invalid-request failure must fail fast');
});

test('withRetries stops immediately on a cancelled signal', async () => {
  const controller = new AbortController();
  controller.abort('user cancelled');
  let calls = 0;
  await assert.rejects(
    withRetries(async () => { calls += 1; return 'never'; }, { maxAttempts: 3, signal: controller.signal }),
    CancelledError,
  );
  assert.equal(calls, 0, 'the worker must not run once the signal is aborted');
});

function fakeConfig(overrides = {}) {
  return {
    pipeline: { targetSampleRate: 16000 },
    providers: {
      fake: {
        latencyMs: 0,
        failureRate: 0,
        ...overrides,
      },
    },
  };
}

test('FakeProvider transcribes deterministically with word timestamps', async () => {
  const provider = new FakeProvider(fakeConfig(), { debug() {} });
  const result = await provider.transcribe({}, { durationSeconds: 6, language: 'en' });
  assert.equal(result.language, 'en');
  assert.ok(result.words.length > 0);
  for (let i = 1; i < result.words.length; i += 1) {
    assert.ok(result.words[i].start >= result.words[i - 1].start, 'timestamps are ordered');
    assert.ok(result.words[i].start < result.words[i].end, 'each word has positive duration');
  }
});

test('FakeProvider translation is deterministic for identical input', async () => {
  const provider = new FakeProvider(fakeConfig(), { debug() {} });
  const segments = [{ segmentId: 'seg_00000', text: 'hello world' }];
  const first = await provider.translate(segments, { sourceLanguage: 'en', targetLanguage: 'es' });
  const second = await provider.translate(segments, { sourceLanguage: 'en', targetLanguage: 'es' });
  assert.deepEqual(first, second);
  assert.match(first[0].text, /^\[es\]/);
});

test('FakeProvider forces synthesis failures a requested number of times', async () => {
  const provider = new FakeProvider(fakeConfig(), { debug() {} });
  provider.failNextSynthesis('seg_00000', 2);

  await assert.rejects(provider.synthesize('hey', { segmentId: 'seg_00000' }), (e) => e.code === 'TTS_ERROR');
  await assert.rejects(provider.synthesize('hey', { segmentId: 'seg_00000' }), (e) => e.code === 'TTS_ERROR');
  const result = await provider.synthesize('hey', { segmentId: 'seg_00000' });
  assert.ok(result.audio, 'synthesis recovers after the forced failures');
});

test('FakeProvider returns a decodable WAV from synthesis', async () => {
  const { decodeWav } = await import('../../src/core/wav.js');
  const provider = new FakeProvider(fakeConfig(), { debug() {} });
  const result = await provider.synthesize('some words to speak aloud', { segmentId: 'seg_1', voice: 'Kore' });
  const decoded = decodeWav(Buffer.from(result.audio));
  assert.ok(decoded.samples.length > 0);
  assert.equal(decoded.channels, 1);
  assert.equal(result.voice, 'Kore');
});

test('FakeProvider refuses work once its signal is aborted', async () => {
  const provider = new FakeProvider(fakeConfig({ latencyMs: 50 }), { debug() {} });
  const controller = new AbortController();
  controller.abort('stop');
  await assert.rejects(
    provider.transcribe({}, { durationSeconds: 2, signal: controller.signal }),
    (err) => err.code === 'CANCELLED',
  );
});
