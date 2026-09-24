import { FfmpegEngine, ffmpegAvailable } from './ffmpeg-engine.js';
import { MockEngine } from './mock-engine.js';
import { assertEngine } from './engine.js';

/**
 * Selects the media engine. `auto` prefers ffmpeg when both binaries work and
 * silently falls back to the mock engine otherwise, recording why in the result
 * so the Studio can surface the capability gap instead of hiding it.
 */
export async function createMediaEngine(config, logger) {
  const requested = config.media.engine;
  if (requested === 'mock') {
    return { engine: assertEngine(new MockEngine(config, logger)), kind: 'mock', reason: 'Configured explicitly.' };
  }
  if (requested === 'ffmpeg') {
    return { engine: assertEngine(new FfmpegEngine(config, logger)), kind: 'ffmpeg', reason: 'Configured explicitly.' };
  }

  const availability = await ffmpegAvailable(config);
  if (availability.available) {
    return {
      engine: assertEngine(new FfmpegEngine(config, logger)),
      kind: 'ffmpeg',
      reason: `ffmpeg detected (${availability.ffmpeg.version ?? 'unknown version'}).`,
    };
  }
  return {
    engine: assertEngine(new MockEngine(config, logger)),
    kind: 'mock',
    reason: 'ffmpeg/ffprobe not found; using the deterministic mock engine.',
  };
}

export { FfmpegEngine, MockEngine };
