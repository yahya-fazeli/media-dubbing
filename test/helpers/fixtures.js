import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { encodeWav } from '../../src/core/wav.js';

/** Deterministic sine-wave WAV fixture used across integration tests. */
export function sineWav({ seconds = 20, sampleRate = 16000, frequency = 220, amplitude = 0.3 } = {}) {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * frequency * i) / sampleRate));
  }
  return Buffer.from(encodeWav({ samples, sampleRate, channels: 1 }));
}

function makeLogger() {
  const logger = { info() {}, warn() {}, error() {}, debug() {}, child: () => logger };
  return logger;
}

/**
 * Builds an application in a throwaway data directory using the mock engine and
 * fake provider, so tests never touch ffmpeg, the network, or real user data.
 */
export async function makeTestApp(overrides = {}) {
  const { createApplication } = await import('../../src/app.js');
  const dataDir = overrides.dataDir ?? overrides.config?.dataDir
    ?? await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-test-'));
  const app = await createApplication({
    ...overrides,
    config: {
      dataDir,
      media: { engine: 'mock' },
      providers: { fake: { enabled: true, latencyMs: 0 } },
      ...overrides.config,
    },
    logger: overrides.logger ?? makeLogger(),
  });
  return { app, dataDir };
}

export { makeLogger };

export async function cleanupDir(dir) {
  await fsp.rm(dir, { recursive: true, force: true });
}

/** Creates a job from the standard fixture and returns its record. */
export async function createFixtureJob(app, options = {}) {
  return app.orchestrator.createJob({
    sourceName: 'clip.wav',
    sourceBuffer: sineWav(options.media ?? {}),
    sourceLanguage: 'en',
    targetLanguage: 'es',
    ...options.job,
  });
}
