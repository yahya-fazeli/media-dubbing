import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig, ensureDataDirs, envInt, envBool, envFloat, envList, SUPPORTED_LANGUAGES,
} from '../../src/config.js';

const CONFIG_ENV = [
  'DUB_DATA_DIR', 'DUB_TMP_DIR', 'HOST', 'PORT', 'DUB_API_TOKEN', 'DUB_MEDIA_ENGINE',
  'DUB_FAKE_PROVIDER', 'DUB_TTS_CONCURRENCY', 'DUB_TRUST_PROXY', 'DUB_METRICS_ENABLED',
  'DUB_MAX_DURATION_SECONDS', 'DUB_MIN_TEMPO', 'GEMINI_API_KEY', 'GEMINI_API_KEYS',
  'DUB_FAKE_LATENCY_MS', 'DUB_LOG_PRETTY', 'DUB_OTEL_ENABLED',
];

/** Runs `fn` with a controlled environment, restoring every touched variable. */
async function withEnv(values, fn) {
  const saved = new Map(CONFIG_ENV.map((k) => [k, process.env[k]]));
  for (const k of CONFIG_ENV) delete process.env[k];
  Object.assign(process.env, values);
  try {
    return await fn();
  } finally {
    for (const k of CONFIG_ENV) delete process.env[k];
    for (const [k, v] of saved) if (v !== undefined) process.env[k] = v;
  }
}

test('envInt parses integers and falls back on junk or absence', () => {
  process.env.__T = '42';
  assert.equal(envInt('__T', 1), 42);
  process.env.__T = 'not-a-number';
  assert.equal(envInt('__T', 7), 7);
  delete process.env.__T;
  assert.equal(envInt('__T', 3), 3);
  process.env.__T = '';
  assert.equal(envInt('__T', 3), 3);
  delete process.env.__T;
});

test('envBool recognizes truthy spellings and persists the fallback otherwise', () => {
  for (const truthy of ['1', 'true', 'TRUE', 'yes', 'on']) {
    process.env.__B = truthy;
    assert.equal(envBool('__B', false), true, `${truthy} should be true`);
  }
  for (const falsy of ['0', 'false', 'no', 'off']) {
    process.env.__B = falsy;
    assert.equal(envBool('__B', true), false, `${falsy} should be false`);
  }
  delete process.env.__B;
  assert.equal(envBool('__B', true), true);
});

test('envFloat parses decimals and envList splits on commas', () => {
  process.env.__F = '1.5';
  assert.equal(envFloat('__F', 0), 1.5);
  delete process.env.__F;

  process.env.__L = ' a , b ,, c ';
  assert.deepEqual(envList('__L', []), ['a', 'b', 'c']);
  delete process.env.__L;
  assert.deepEqual(envList('__L', ['fallback']), ['fallback']);
});

test('loadConfig applies documented defaults', async () => {
  await withEnv({}, async () => {
    const config = loadConfig({ dataDir: '/tmp/example' });
    assert.equal(config.server.host, '0.0.0.0');
    assert.equal(config.server.port, 12000);
    assert.equal(config.server.apiToken, '');
    assert.equal(config.media.engine, 'auto');
    assert.equal(config.pipeline.ttsConcurrency, 4);
    assert.equal(config.pipeline.targetSampleRate, 44100);
    assert.equal(config.observability.metricsEnabled, true);
    assert.equal(config.providers.gemini.apiKeys.length, 0);
    assert.equal(config.jobsDir, path.join(config.dataDir, 'jobs'));
  });
});

test('loadConfig reads overrides and environment values', async () => {
  await withEnv({
    PORT: '9090', HOST: '127.0.0.1', DUB_API_TOKEN: 'tok',
    DUB_MEDIA_ENGINE: 'mock', DUB_FAKE_PROVIDER: 'true',
    DUB_TTS_CONCURRENCY: '8', DUB_MAX_DURATION_SECONDS: '60',
    DUB_MIN_TEMPO: '0.5', DUB_TRUST_PROXY: 'yes',
  }, async () => {
    const config = loadConfig({ dataDir: '/tmp/example' });
    assert.equal(config.server.port, 9090);
    assert.equal(config.server.host, '127.0.0.1');
    assert.equal(config.server.apiToken, 'tok');
    assert.equal(config.server.trustProxy, true);
    assert.equal(config.media.engine, 'mock');
    assert.equal(config.providers.fake.enabled, true);
    assert.equal(config.pipeline.ttsConcurrency, 8);
    assert.equal(config.media.maxDurationSeconds, 60);
    assert.equal(config.pipeline.minTempo, 0.5);
  });
});

test('loadConfig collects Gemini keys from either variable', async () => {
  await withEnv({ GEMINI_API_KEY: 'single-key' }, async () => {
    const config = loadConfig({ dataDir: '/tmp/example' });
    assert.deepEqual(config.providers.gemini.apiKeys, ['single-key']);
  });
  await withEnv({ GEMINI_API_KEYS: 'k1,k2,k3' }, async () => {
    const config = loadConfig({ dataDir: '/tmp/example' });
    assert.deepEqual(config.providers.gemini.apiKeys, ['k1', 'k2', 'k3']);
  });
});

test('loadConfig resolves data and temp directories to absolute paths', async () => {
  await withEnv({ DUB_TMP_DIR: 'relative-tmp' }, async () => {
    const config = loadConfig({ dataDir: 'relative-data' });
    assert.ok(path.isAbsolute(config.dataDir));
    assert.ok(path.isAbsolute(config.tmpDir));
  });
});

test('ensureDataDirs creates every directory with owner-only permissions', async (t) => {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-config-'));
  t.after(() => fsp.rm(base, { recursive: true, force: true }));

  const config = await withEnv({ DUB_DATA_DIR: base }, async () => ensureDataDirs(loadConfig()));
  for (const dir of [config.dataDir, config.jobsDir, config.uploadsDir, config.artifactsDir, config.logsDir, config.tmpDir]) {
    const stat = await fsp.stat(dir);
    assert.ok(stat.isDirectory(), `${dir} should exist`);
    if (dir.startsWith(base)) {
      assert.equal(stat.mode & 0o777, 0o700, `${dir} should be owner-only`);
    }
  }
});

test('loadConfig never surfaces credentials inside job-facing directories', async () => {
  await withEnv({ GEMINI_API_KEY: 'secret-key-value' }, async () => {
    const config = loadConfig({ dataDir: '/tmp/example' });
    // The key lives only in providers.gemini.apiKeys, never in job metadata.
    assert.ok(!Object.keys(config.jobsDir).length || !config.jobsDir.includes('secret-key-value'));
    assert.ok(!JSON.stringify({ ...config, providers: undefined }).includes('secret-key-value'));
  });
});

test('SUPPORTED_LANGUAGES are unique and lower-case ISO codes', () => {
  const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
  assert.equal(new Set(codes).size, codes.length, 'language codes must be unique');
  for (const lang of SUPPORTED_LANGUAGES) {
    assert.match(lang.code, /^[a-z]{2}$/, `${lang.code} should be a 2-letter code`);
    assert.ok(lang.name && typeof lang.name === 'string');
  }
});
