import fsp from 'node:fs/promises';
import path from 'node:path';
import { encodeWav, decodeWav, toMono, toChannels, resample, mixInto, fadeEdges, rms } from '../core/wav.js';
import { MediaError } from '../core/errors.js';
import { ensureDir, statSafe } from '../core/fsutil.js';

/**
 * Dependency-free media engine. It writes real 16-bit PCM WAV files with
 * deterministic content derived from a seed, so the whole pipeline (segmentation
 * math, timing, mixing, quality validation, artifact reuse) can be exercised
 * without ffmpeg or any network access.
 *
 * Video outputs are placeholder MP4-ish containers: a small header plus the
 * audio payload, which is enough for the render and validation stages to run.
 */
export class MockEngine {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger ?? { debug() {}, warn() {} };
    this.name = 'mock';
  }

  async probe(input) {
    const stat = await this.#assertReadable(input);
    if (input.endsWith('.wav')) {
      const wav = await this.#readWav(input);
      return {
        container: 'wav',
        durationSeconds: wav.durationSeconds,
        sizeBytes: stat.size,
        hasVideo: false,
        hasAudio: true,
        videoStreams: 0,
        audioStreams: 1,
        video: null,
        audio: {
          codec: 'pcm_s16le',
          sampleRate: wav.sampleRate,
          channels: wav.channels,
          channelLayout: wav.channels === 1 ? 'mono' : 'stereo',
          durationSeconds: wav.durationSeconds,
        },
        tags: {},
      };
    }

    // Opaque containers: recover the duration from a WAV payload if one is
    // embedded (common for mock-produced files and test fixtures), otherwise
    // derive a deterministic value from the file's size and name so repeated
    // probes agree with each other.
    const embedded = await this.#findEmbeddedWav(input);
    const isVideo = this.config.media.videoExtensions.includes(path.extname(input).toLowerCase());
    let durationSeconds;
    let audio;

    if (embedded) {
      durationSeconds = embedded.durationSeconds;
      audio = {
        codec: 'pcm_s16le',
        sampleRate: embedded.sampleRate,
        channels: embedded.channels,
        channelLayout: embedded.channels === 1 ? 'mono' : 'stereo',
        durationSeconds,
      };
    } else {
      durationSeconds = this.#declaredDuration(input, stat.size);
      audio = {
        codec: 'aac',
        sampleRate: this.config.pipeline.targetSampleRate,
        channels: 2,
        channelLayout: 'stereo',
        durationSeconds,
      };
    }

    return {
      container: path.extname(input).replace('.', '') || 'unknown',
      durationSeconds,
      sizeBytes: stat.size,
      hasVideo: isVideo,
      hasAudio: true,
      videoStreams: isVideo ? 1 : 0,
      audioStreams: 1,
      video: isVideo
        ? { codec: 'h264', width: 1280, height: 720, frameRate: '30/1', durationSeconds }
        : null,
      audio,
      tags: {},
    };
  }

  async extractAudio(input, output, options = {}) {
    await this.#assertReadable(input);
    await ensureDir(path.dirname(output));
    const probe = await this.probe(input);
    const duration = options.durationSeconds ?? probe.durationSeconds ?? 0;
    const sampleRate = options.sampleRate ?? this.config.pipeline.targetSampleRate;
    const channels = options.channels ?? 1;
    const samples = this.#synthesize(duration, sampleRate, channels, `extract:${path.basename(input)}`);
    await fsp.writeFile(output, encodeWav({ samples, sampleRate, channels }));
    return { path: output, durationSeconds: duration, sampleRate, channels, sizeBytes: samples.length * 2 };
  }

  async separateVocals(input, output, options = {}) {
    await this.#assertReadable(input);
    const wav = await this.#readWav(input);
    await ensureDir(path.dirname(output));

    if (!this.config.media.demucsEnabled) {
      await fsp.copyFile(input, output);
      // A synthetic "background" bed is still produced so mixing has something
      // to combine with; it is a quiet tone, not a copy of the dialogue.
      const accompanimentPath = options.accompanimentPath
        ? path.join(path.dirname(output), path.basename(options.accompanimentPath))
        : null;
      if (accompanimentPath) {
        const bed = this.#synthesize(wav.durationSeconds, wav.sampleRate, wav.channels, 'bed', 0.06);
        await fsp.writeFile(accompanimentPath, encodeWav({
          samples: bed, sampleRate: wav.sampleRate, channels: wav.channels,
        }));
      }
      return {
        path: output,
        separated: false,
        reason: 'Vocal separation disabled; mock engine passes audio through and synthesizes a background bed.',
        accompanimentPath,
        durationSeconds: wav.durationSeconds,
      };
    }

    // With separation "enabled", the mock splits by attenuating content in the
    // mid band. It is a deterministic stand-in, not real source separation.
    const mono = toMono(wav.samples, wav.channels);
    const vocals = new Int16Array(mono.length);
    const background = new Int16Array(mono.length);
    let prev = 0;
    for (let i = 0; i < mono.length; i += 1) {
      // Cheap high-pass approximation: differences emphasise speech transients.
      const high = mono[i] - prev;
      prev = mono[i];
      vocals[i] = Math.max(-32768, Math.min(32767, Math.round(high * 0.8 + mono[i] * 0.4)));
      background[i] = Math.max(-32768, Math.min(32767, Math.round(mono[i] - vocals[i] * 0.5)));
    }
    const accompanimentPath = options.accompanimentPath
      ?? path.join(path.dirname(output), 'accompaniment.wav');
    await fsp.writeFile(output, encodeWav({
      samples: toChannels(vocals, wav.channels), sampleRate: wav.sampleRate, channels: wav.channels,
    }));
    await fsp.writeFile(accompanimentPath, encodeWav({
      samples: toChannels(background, wav.channels), sampleRate: wav.sampleRate, channels: wav.channels,
    }));
    return {
      path: output,
      separated: true,
      vocalsPath: output,
      accompanimentPath,
      model: 'mock-separation',
      durationSeconds: wav.durationSeconds,
    };
  }

  async trimAudio(input, output, options = {}) {
    const wav = await this.#readWav(input);
    const start = Math.max(0, Number(options.startSeconds ?? 0));
    const duration = Number(options.durationSeconds ?? 0);
    if (!(duration > 0)) throw new MediaError('trimAudio requires a positive duration');
    const startFrame = Math.round(start * wav.sampleRate);
    const frameLen = Math.round(duration * wav.sampleRate);
    const samples = wav.samples.subarray(
      startFrame * wav.channels,
      Math.min(wav.samples.length, (startFrame + frameLen) * wav.channels),
    );
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, encodeWav({
      samples: Int16Array.from(samples), sampleRate: wav.sampleRate, channels: wav.channels,
    }));
    return { path: output, durationSeconds: duration, sampleRate: wav.sampleRate, channels: wav.channels };
  }

  async normalizeAudio(input, output, options = {}) {
    const wav = await this.#readWav(input);
    const target = options.targetRms ?? 0.18;
    const level = rms(wav.samples) || 1e-6;
    const gain = Math.min(8, target / level);
    const samples = new Int16Array(wav.samples.length);
    for (let i = 0; i < wav.samples.length; i += 1) {
      samples[i] = Math.max(-32768, Math.min(32767, Math.round(wav.samples[i] * gain)));
    }
    const sampleRate = options.sampleRate ?? wav.sampleRate;
    const scaled = sampleRate === wav.sampleRate
      ? samples
      : resample(samples, wav.sampleRate, sampleRate, wav.channels);
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, encodeWav({ samples: scaled, sampleRate, channels: wav.channels }));
    return { path: output, sampleRate, channels: wav.channels, appliedGain: gain };
  }

  async concatAudio(inputs, output, options = {}) {
    const parts = [];
    let sampleRate = options.sampleRate ?? this.config.pipeline.targetSampleRate;
    let channels = 1;
    for (const input of inputs) {
      const wav = await this.#readWav(input);
      sampleRate = wav.sampleRate;
      channels = wav.channels;
      parts.push(wav.samples);
    }
    const total = parts.reduce((sum, p) => sum + p.length, 0);
    const merged = new Int16Array(total);
    let offset = 0;
    for (const part of parts) {
      merged.set(part, offset);
      offset += part.length;
    }
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, encodeWav({ samples: merged, sampleRate, channels }));
    return { path: output, sampleRate, channels, durationSeconds: merged.length / channels / sampleRate };
  }

  async mixAudio(sources, output, options = {}) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new MediaError('mixAudio requires at least one source');
    }
    const sampleRate = options.sampleRate ?? this.config.pipeline.targetSampleRate;
    const channels = options.channels ?? 2;
    const duration = options.durationSeconds ?? 0;
    const totalFrames = Math.max(1, Math.round(duration * sampleRate));
    const out = new Int16Array(totalFrames * channels);

    for (const source of sources) {
      const wav = await this.#readWav(source.path);
      const gain = source.gain ?? 1;
      const mono = toMono(wav.samples, wav.channels);
      const resampled = wav.sampleRate === sampleRate
        ? mono
        : resample(mono, wav.sampleRate, sampleRate, 1);
      const loop = source.loop === true;
      if (loop) {
        // Tile the background bed until it covers the full output duration.
        let written = 0;
        while (written < totalFrames) {
          const remaining = totalFrames - written;
          const slice = resampled.subarray(0, Math.min(resampled.length, remaining));
          const startFrame = written * channels;
          const patch = new Int16Array(slice.length * channels);
          for (let i = 0; i < slice.length; i += 1) {
            for (let c = 0; c < channels; c += 1) patch[i * channels + c] = slice[i];
          }
          mixInto(out, patch, startFrame, gain);
          written += slice.length;
          if (slice.length === 0) break;
        }
      } else {
        const startFrame = Math.round((source.startSeconds ?? 0) * sampleRate) * channels;
        const patch = toChannels(resampled, channels);
        mixInto(out, patch, startFrame, gain);
      }
    }
    await ensureDir(path.dirname(output));
    await fsp.writeFile(output, encodeWav({ samples: out, sampleRate, channels }));
    return { path: output, sampleRate, channels, durationSeconds: totalFrames / sampleRate };
  }

  async renderVideo(input, audioPath, output, options = {}) {
    await this.#assertReadable(input);
    await this.#assertReadable(audioPath);
    await ensureDir(path.dirname(output));
    const wav = await this.#readWav(audioPath);
    const duration = options.durationSeconds ?? wav.durationSeconds;

    // A real muxer is not available, so the mock container records the video
    // duration in a small text banner and embeds the dialogue as a complete WAV
    // payload. probe() locates that payload, keeping the contract identical to
    // what ffmpeg's container would provide.
    const banner = Buffer.from(
      `MOCKMP4\nduration=${duration.toFixed(3)}\nvideoBytes=${(duration * 250_000).toFixed(0)}\n`,
      'utf8',
    );
    const wavBytes = encodeWav({ samples: wav.samples, sampleRate: wav.sampleRate, channels: wav.channels });
    await fsp.writeFile(output, Buffer.concat([banner, wavBytes]));

    return {
      path: output,
      durationSeconds: wav.durationSeconds,
      videoReencoded: options.reencode === true,
      sizeBytes: banner.length + wavBytes.length,
      muxed: false,
    };
  }

  #synthesize(durationSeconds, sampleRate, channels, seed, amplitude = 0.25) {
    const frames = Math.max(1, Math.round(durationSeconds * sampleRate));
    const samples = new Int16Array(frames * channels);
    // Deterministic multi-tone speech-like signal keyed off the seed so runs are
    // reproducible and artifacts can be compared byte-for-byte in tests.
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    const base = 120 + (h % 180);
    const peak = 32767 * amplitude;
    for (let f = 0; f < frames; f += 1) {
      const t = f / sampleRate;
      const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 2.5 * t + h);
      const value = Math.round(
        peak * env
          * (0.6 * Math.sin(2 * Math.PI * base * t)
            + 0.3 * Math.sin(2 * Math.PI * base * 2 * t)
            + 0.1 * Math.sin(2 * Math.PI * base * 3.5 * t)),
      );
      for (let c = 0; c < channels; c += 1) samples[f * channels + c] = value;
    }
    return fadeEdges(samples, channels, Math.round(sampleRate * 0.01));
  }

  async #readWav(file) {
    const stat = await this.#assertReadable(file);
    const buffer = await fsp.readFile(file);
    try {
      return decodeWav(buffer);
    } catch (err) {
      // Container inputs (mock renders, test fixtures) embed a WAV payload; use
      // it rather than failing, so the pipeline can still progress.
      const embedded = await this.#findEmbeddedWav(file);
      if (embedded) return embedded;
      const declared = this.#declaredDuration(file, stat.size);
      if (declared > 0) {
        const sampleRate = this.config.pipeline.targetSampleRate;
        return {
          samples: this.#synthesize(declared, sampleRate, 1, path.basename(file)),
          sampleRate,
          channels: 1,
          durationSeconds: declared,
          synthesizedFromContainer: true,
        };
      }
      throw new MediaError(`Mock engine could not decode ${path.basename(file)}: ${err.message}`, {
        cause: err, details: { sizeBytes: stat.size },
      });
    }
  }

  /**
   * Scans a container for an embedded WAV payload. Mock-rendered files and test
   * fixtures are built by concatenating a small header with WAV audio, so this
   * recovers the true duration without needing ffprobe.
   */
  async #findEmbeddedWav(file) {
    let buffer;
    try {
      buffer = await fsp.readFile(file);
    } catch {
      return null;
    }
    const riffOffset = buffer.indexOf('RIFF');
    if (riffOffset === -1 || riffOffset > buffer.length - 12) return null;
    const waveOffset = buffer.indexOf('WAVE', riffOffset);
    if (waveOffset === -1) return null;
    try {
      return decodeWav(buffer.subarray(riffOffset));
    } catch {
      return null;
    }
  }

  /**
   * Deterministic duration for a container with no readable audio. Derived from
   * size and name so the same file always reports the same duration, which keeps
   * pipeline runs reproducible.
   */
  #declaredDuration(file, sizeBytes) {
    let h = 0;
    const name = path.basename(file);
    for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const megabytes = sizeBytes / (1024 * 1024);
    // Assume roughly 128 kB/s of media, floored at a few seconds and capped so a
    // stray large file does not invent an hour-long job.
    const estimate = megabytes * 8;
    return Math.round(Math.max(2, Math.min(600, estimate + (h % 5))) * 1000) / 1000;
  }

  async #assertReadable(input) {
    if (!input || typeof input !== 'string') {
      throw new MediaError('A file path is required', { details: { input } });
    }
    const stat = await statSafe(input);
    if (!stat || !stat.isFile()) {
      throw new MediaError('Media input is missing or is not a regular file', {
        details: { input },
        recoveryScope: 'stage',
      });
    }
    return stat;
  }
}
