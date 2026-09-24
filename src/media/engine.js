/**
 * Media engine contract. Two implementations exist:
 *
 *  - ffmpegEngine: real extraction, separation, mixing, and rendering.
 *  - mockEngine:   deterministic, dependency-free synthesis. Used for tests,
 *                  demos, and environments without ffmpeg installed.
 *
 * Both must expose the same methods so the pipeline never branches on which one
 * is active. Every method accepts `(input, output, options)` and returns a
 * metadata object describing what was produced.
 */

export const MediaEngineCapabilities = {
  EXTRACT_AUDIO: 'extractAudio',
  SEPARATE_VOCALS: 'separateVocals',
  PROBE: 'probe',
  MIX: 'mixAudio',
  RENDER_VIDEO: 'renderVideo',
  TRIM: 'trimAudio',
  NORMALIZE: 'normalizeAudio',
  CONCAT: 'concatAudio',
};

export function assertEngine(engine) {
  const required = Object.values(MediaEngineCapabilities);
  const missing = required.filter((name) => typeof engine?.[name] !== 'function');
  if (missing.length) {
    throw new TypeError(`Media engine is missing methods: ${missing.join(', ')}`);
  }
  return engine;
}

/** Normalizes a probe result into the shape the rest of the app expects. */
export function normalizeProbe(info, fallback = {}) {
  const streams = Array.isArray(info?.streams) ? info.streams : [];
  const video = streams.find((s) => s.codec_type === 'video' && s.disposition?.attached_pic !== 1);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const format = info?.format ?? {};
  const durationSeconds = Number.parseFloat(format.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;

  return {
    container: format.format_name ?? null,
    durationSeconds,
    sizeBytes: Number.parseInt(format.size ?? 0, 10) || 0,
    bitRate: Number.parseInt(format.bit_rate ?? 0, 10) || 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    videoStreams: streams.filter((s) => s.codec_type === 'video').length,
    audioStreams: streams.filter((s) => s.codec_type === 'audio').length,
    video: video
      ? {
          codec: video.codec_name ?? null,
          width: video.width ?? null,
          height: video.height ?? null,
          frameRate: video.r_frame_rate ?? null,
          durationSeconds: Number.parseFloat(video.duration ?? durationSeconds) || durationSeconds,
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name ?? null,
          sampleRate: Number.parseInt(audio.sample_rate ?? 0, 10) || null,
          channels: audio.channels ?? null,
          channelLayout: audio.channel_layout ?? null,
          durationSeconds: Number.parseFloat(audio.duration ?? durationSeconds) || durationSeconds,
        }
      : null,
    tags: format.tags ?? {},
    ...fallback,
  };
}
