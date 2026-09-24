/**
 * Minimal PCM WAV read/write. The pipeline produces and manipulates raw PCM in
 * several places (TTS output normalization, silence padding, trimming), and
 * doing it here avoids a subprocess round trip for pure sample math.
 */

const HEADER_SIZE = 44;

export function encodeWavHeader({ sampleRate, channels, bitsPerSample = 16, dataBytes }) {
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(HEADER_SIZE);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Encodes 16-bit PCM samples (interleaved Int16) into a WAV buffer. */
export function encodeWav({ samples, sampleRate, channels = 1 }) {
  const dataBytes = samples.length * 2;
  return Buffer.concat([
    encodeWavHeader({ sampleRate, channels, bitsPerSample: 16, dataBytes }),
    Buffer.from(samples.buffer, samples.byteOffset, dataBytes),
  ]);
}

/**
 * Parses a PCM WAV buffer. Handles extra chunks between `fmt ` and `data`
 * because encoders (including some TTS services) insert LIST/fact chunks.
 */
export function decodeWav(buffer) {
  if (buffer.length < 12) throw new WavError('Buffer too small to be a WAV file');
  if (buffer.toString('ascii', 0, 4) !== 'RIFF') throw new WavError('Missing RIFF header');
  if (buffer.toString('ascii', 8, 12) !== 'WAVE') throw new WavError('Missing WAVE marker');

  let offset = 12;
  let fmt = null;
  let data = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (body + chunkSize > buffer.length) {
      // Truncated tail: accept what is present rather than failing the job.
      if (chunkId === 'data') {
        data = buffer.subarray(body);
        break;
      }
      throw new WavError(`Truncated WAV chunk: ${chunkId}`);
    }
    if (chunkId === 'fmt ') {
      fmt = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        byteRate: buffer.readUInt32LE(body + 8),
        blockAlign: buffer.readUInt16LE(body + 12),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === 'data') {
      data = buffer.subarray(body, body + chunkSize);
    }
    offset = body + chunkSize + (chunkSize % 2); // chunks are word aligned
  }

  if (!fmt) throw new WavError('WAV file has no fmt chunk');
  if (!data) throw new WavError('WAV file has no data chunk');
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 0xfffe) {
    throw new WavError(`Unsupported WAV format code ${fmt.audioFormat}; only PCM is supported`);
  }
  if (fmt.bitsPerSample !== 16) {
    throw new WavError(`Unsupported bit depth ${fmt.bitsPerSample}; only 16-bit PCM is supported`);
  }

  const sampleCount = Math.floor(data.length / 2);
  const samples = new Int16Array(sampleCount);
  for (let i = 0; i < sampleCount; i += 1) samples[i] = data.readInt16LE(i * 2);

  return {
    samples,
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    durationSeconds: sampleCount / fmt.channels / fmt.sampleRate,
  };
}

export class WavError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WavError';
    this.code = 'CORRUPT_ARTIFACT';
  }
}

/** Number of PCM frames (per-channel samples) in an Int16Array. */
export function frameCount(samples, channels) {
  return Math.floor(samples.length / channels);
}

export function samplesToSeconds(sampleCount, sampleRate, channels) {
  return sampleCount / channels / sampleRate;
}

export function secondsToFrames(seconds, sampleRate) {
  return Math.round(seconds * sampleRate);
}

/**
 * Converts interleaved multi-channel PCM to mono by averaging channels. Used
 * when a TTS response arrives in stereo but the timeline mixer works in mono.
 */
export function toMono(samples, channels) {
  if (channels === 1) return samples;
  const frames = Math.floor(samples.length / channels);
  const out = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    let sum = 0;
    for (let c = 0; c < channels; c += 1) sum += samples[i * channels + c];
    out[i] = Math.round(sum / channels);
  }
  return out;
}

/** Replicates mono PCM across `channels` interleaved channels. */
export function toChannels(mono, channels) {
  if (channels === 1) return mono;
  const out = new Int16Array(mono.length * channels);
  for (let i = 0; i < mono.length; i += 1) {
    for (let c = 0; c < channels; c += 1) out[i * channels + c] = mono[i];
  }
  return out;
}

/**
 * Linear resampling. Quality is adequate for speech that is about to be mixed
 * under a music bed; this is a fallback for engine-free runs, not the primary
 * path (ffmpeg handles real conversions).
 */
export function resample(samples, fromRate, toRate, channels = 1) {
  if (fromRate === toRate) return samples;
  const inFrames = Math.floor(samples.length / channels);
  const outFrames = Math.max(1, Math.round((inFrames * toRate) / fromRate));
  const out = new Int16Array(outFrames * channels);
  const ratio = inFrames / outFrames;
  for (let i = 0; i < outFrames; i += 1) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(inFrames - 1, i0 + 1);
    const frac = srcPos - i0;
    for (let c = 0; c < channels; c += 1) {
      const a = samples[i0 * channels + c] ?? 0;
      const b = samples[i1 * channels + c] ?? a;
      out[i * channels + c] = Math.round(a + (b - a) * frac);
    }
  }
  return out;
}

/** Mixes `source` into `target` starting at `startFrame`, clipping to Int16. */
export function mixInto(target, source, startFrame, gain = 1) {
  const out = target;
  for (let i = 0; i < source.length; i += 1) {
    const idx = startFrame + i;
    if (idx < 0 || idx >= out.length) continue;
    const mixed = out[idx] + source[i] * gain;
    out[idx] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
  }
  return out;
}

/**
 * Applies linear interpolation between the previous sample and `toSample` over
 * `frames` frames. Used to fade speech edges so segment joins do not click.
 */
export function fadeEdges(samples, channels, fadeFrames, fromSample = 0) {
  const frames = Math.floor(samples.length / channels);
  const n = Math.min(fadeFrames, Math.floor(frames / 2));
  if (n <= 0) return samples;
  const out = Int16Array.from(samples);
  for (let i = 0; i < n; i += 1) {
    const inGain = i / n;
    const outGain = 1 - inGain;
    for (let c = 0; c < channels; c += 1) {
      const leadIdx = i * channels + c;
      const tailIdx = (frames - 1 - i) * channels + c;
      out[leadIdx] = Math.round(fromSample + (out[leadIdx] - fromSample) * inGain);
      out[tailIdx] = Math.round(out[tailIdx] * outGain);
    }
  }
  return out;
}

/** Root-mean-square level of PCM samples, normalized to 0..1. */
export function rms(samples) {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length) / 32768;
}

/** Peak absolute amplitude, normalized to 0..1. */
export function peak(samples) {
  let max = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = Math.abs(samples[i]);
    if (v > max) max = v;
  }
  return max / 32768;
}

/** Builds a downsampled peak envelope for waveform rendering in the Studio. */
export function waveformPeaks(samples, channels, buckets = 400) {
  const frames = Math.floor(samples.length / channels);
  if (frames === 0) return [];
  const perBucket = Math.max(1, Math.floor(frames / buckets));
  const out = [];
  for (let start = 0; start < frames; start += perBucket) {
    let peakValue = 0;
    let sum = 0;
    let count = 0;
    const end = Math.min(frames, start + perBucket);
    for (let i = start; i < end; i += 1) {
      const v = samples[i * channels];
      peakValue = Math.max(peakValue, Math.abs(v));
      sum += v * v;
      count += 1;
    }
    out.push({
      startFrame: start,
      peak: peakValue / 32768,
      rms: count ? Math.sqrt(sum / count) / 32768 : 0,
    });
  }
  return out;
}

export { HEADER_SIZE };
