import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProvider, unsupportedProviderError } from '../../src/providers/index.js';
import { FakeProvider } from '../../src/providers/fake-provider.js';
import { GeminiProvider } from '../../src/providers/gemini-provider.js';
import { assertProvider } from '../../src/providers/provider.js';
import { createMediaEngine } from '../../src/media/index.js';
import { MockEngine } from '../../src/media/mock-engine.js';
import { FfmpegEngine } from '../../src/media/ffmpeg-engine.js';
import { loadConfig } from '../../src/config.js';
import { ErrorCode } from '../../src/core/errors.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } };

function configWith(overrides = {}) {
  const config = loadConfig({ dataDir: '/tmp/providers-test' });
  config.providers.fake.enabled = overrides.fakeEnabled ?? false;
  config.providers.gemini.apiKeys = overrides.apiKeys ?? [];
  if (overrides.engine) config.media.engine = overrides.engine;
  return config;
}

test('createProvider selects the offline provider when no keys are configured', () => {
  const selection = createProvider(configWith(), { logger: silentLogger });
  assert.equal(selection.kind, 'fake');
  assert.ok(selection.provider instanceof FakeProvider);
  assert.match(selection.reason, /no gemini api keys/i);
});

test('createProvider prefers the offline provider when it is explicitly enabled', () => {
  const selection = createProvider(configWith({ fakeEnabled: true, apiKeys: ['k'] }), { logger: silentLogger });
  assert.equal(selection.kind, 'fake');
  assert.match(selection.reason, /DUB_FAKE_PROVIDER/);
});

test('createProvider selects Gemini when keys are configured', () => {
  const selection = createProvider(configWith({ apiKeys: ['k1', 'k2'] }), { logger: silentLogger });
  assert.equal(selection.kind, 'gemini');
  assert.ok(selection.provider instanceof GeminiProvider);
  assert.match(selection.reason, /2 API key\(s\)/);
});

test('selected providers satisfy the provider contract', () => {
  const fake = createProvider(configWith(), { logger: silentLogger }).provider;
  const gemini = createProvider(configWith({ apiKeys: ['k'] }), { logger: silentLogger }).provider;
  assert.doesNotThrow(() => assertProvider(fake));
  assert.doesNotThrow(() => assertProvider(gemini));
});

test('unsupportedProviderError is non-retryable with no recovery scope', () => {
  const err = unsupportedProviderError('vocal separation');
  assert.equal(err.code, ErrorCode.PROVIDER_UNAVAILABLE);
  assert.equal(err.retryable, false);
  assert.equal(err.recoveryScope, 'none');
  assert.match(err.message, /vocal separation/);
});

test('createMediaEngine honors an explicit mock selection', async () => {
  const selection = await createMediaEngine(configWith({ engine: 'mock' }), silentLogger);
  assert.equal(selection.kind, 'mock');
  assert.ok(selection.engine instanceof MockEngine);
});

test('createMediaEngine honors an explicit ffmpeg selection without probing', async () => {
  const selection = await createMediaEngine(configWith({ engine: 'ffmpeg' }), silentLogger);
  assert.equal(selection.kind, 'ffmpeg');
  assert.ok(selection.engine instanceof FfmpegEngine);
});

test('createMediaEngine falls back to mock under auto when ffmpeg is absent', async () => {
  // Point the binary paths at names that cannot exist so availability is false.
  const config = configWith({ engine: 'auto' });
  config.media.ffmpegPath = 'definitely-not-ffmpeg-xyz';
  config.media.ffprobePath = 'definitely-not-ffprobe-xyz';

  const selection = await createMediaEngine(config, silentLogger);
  assert.equal(selection.kind, 'mock');
  assert.ok(selection.engine instanceof MockEngine);
  assert.match(selection.reason, /not found/i);
});
