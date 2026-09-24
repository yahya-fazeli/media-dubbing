import fsp from 'node:fs/promises';
import path from 'node:path';
import { runCommand } from './command.js';
import { normalizeProbe } from './engine.js';
import { MediaError, ErrorCode } from '../core/errors.js';
import { ensureDir, statSafe } from '../core/fsutil.js';

/**
 * ffmpeg/ffprobe-backed engine. Every call passes explicit arguments to spawn,
 * never a shell string, and all inputs are validated to be readable files before
 * ffmpeg is invoked.
 */
export class FfmpegEngine {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.ffmpeg = config.media.ffmpegPath;
    this.ffprobe = config.media.ffprobePath;
    this.name = 'ffmpeg';
  }

  async probe(input, options = {}) {
    await this.#assertReadable(input);
    const result = await runCommand(
      this.ffprobe,
      [
        '-v', 'error',
        '-print_format', 'json',
        '-show_format',
        '-show_streams',
        '--',
        path.resolve(input),
      ],
      {
        timeoutMs: options.timeoutMs ?? 60_000,
        signal: options.signal,
        stage: options.stage,
        toolName: 'ffprobe',
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new MediaError('ffprobe returned unparseable output', {
        code: ErrorCode.CORRUPT_ARTIFACT,
        details: { stdout: result.stdout.slice(0, 500) },
        cause: err,
      });
    }
    return normalizeProbe(parsed);
  }

  async extractAudio(input, output, options = {}) {
    await this.#assertReadable(input);
    await ensureDir(path.dirname(output));
    const sampleRate = options.sampleRate ?? this.config.pipeline.targetSampleRate;
    await runCommand(
      this.ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', path.resolve(input),
        '-vn',
        '-map', '0:a:0',
        '-ac', String(options.channels ?? 2),
        '-ar', String(sampleRate),
        '-c:a', 'pcm_s16le',
        path.resolve(output),
      ],
      { ...this.#runOptions(options), toolName: 'ffmpeg', stage: options.stage },
    );
    return this.#describeOutput(output, { kind: 'audio', durationSeconds: options.durationSeconds });
  }

  /**
   * Splits speech from background. Uses Demucs when enabled, otherwise passes
   * the source through and reports that separation was not performed so the
   * pipeline can note the capability gap rather than silently pretending.
   */
  async separateVocals(input, output, options = {}) {
    await this.#assertReadable(input);
    if (!this.config.media.demucsEnabled) {
      await ensureDir(path.dirname(output));
      await fsp.copyFile(input, output);
      return {
        ...(await this.#describeOutput(output, { kind: 'audio' })),
        separated: false,
        reason: 'Vocal separation is disabled (set DUB_DEMUCS_ENABLED=true to enable Demucs).',
      };
    }

    const workDir = options.workDir ?? path.join(path.dirname(output), 'demucs');
    await ensureDir(workDir);
    const command = this.config.media.demucsCommand;
    // Demucs writes predictable stems into its output directory; we request the
    // vocals and no_vocals stems then move them into the job's artifact layout.
    await runCommand(
      command,
      ['--two-stems=vocals', '-o', workDir, path.resolve(input)],
      { ...this.#runOptions(options), toolName: command, allowMissing: false, stage: options.stage },
    );

    const stems = await this.#locateStems(workDir);
    if (!stems.vocals) {
      throw new MediaError('Vocal separation produced no vocals stem', {
        code: ErrorCode.MEDIA_ERROR,
        retryable: true,
        recoveryScope: 'stage',
        details: { workDir },
      });
    }
    await ensureDir(path.dirname(output));
    await fsp.copyFile(stems.vocals, output);
    const produced = await this.#describeOutput(output, { kind: 'audio' });
    return {
      ...produced,
      separated: true,
      vocalsPath: output,
      accompanimentPath: stems.accompaniment ?? null,
      model: 'demucs-htdemucs',
    };
  }

  async trimAudio(input, output, options = {}) {
    await this.#assertReadable(input);
    const start = Number(options.startSeconds ?? 0);
    const duration = Number(options.durationSeconds ?? 0);
    if (!(duration > 0)) {
      throw new MediaError('trimAudio requires a positive durationSeconds', {
        details: { start, duration },
      });
    }
    await ensureDir(path.dirname(output));
    await runCommand(
      this.ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-ss', String(Math.max(0, start)),
        '-t', String(duration),
        '-i', path.resolve(input),
        '-vn',
        '-c:a', 'pcm_s16le',
        '-ar', String(options.sampleRate ?? this.config.pipeline.targetSampleRate),
        path.resolve(output),
      ],
      { ...this.#runOptions(options), toolName: 'ffmpeg', stage: options.stage },
    );
    return this.#describeOutput(output, { kind: 'audio', durationSeconds: duration });
  }

  async normalizeAudio(input, output, options = {}) {
    await this.#assertReadable(input);
    await ensureDir(path.dirname(output));
    const filters = [`loudnorm=I=${options.targetLufs ?? -16}:TP=-1.5:LRA=11`];
    await runCommand(
      this.ffmpeg,
      [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', path.resolve(input),
        '-af', filters.join(','),
        '-ar', String(options.sampleRate ?? this.config.pipeline.targetSampleRate),
        '-ac', String(options.channels ?? 2),
        '-c:a', 'pcm_s16le',
        path.resolve(output),
      ],
      { ...this.#runOptions(options), toolName: 'ffmpeg', stage: options.stage },
    );
    return this.#describeOutput(output, { kind: 'audio' });
  }

  async concatAudio(inputs, output, options = {}) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      throw new MediaError('concatAudio requires at least one input');
    }
    for (const input of inputs) await this.#assertReadable(input);
    await ensureDir(path.dirname(output));

    // The concat demuxer needs a list file. It lives inside the job's temp dir,
    // and every path written into it is absolute, so it cannot be influenced by
    // an attacker-controlled relative path.
    const listFile = path.join(path.dirname(output), `.concat-${Date.now()}.txt`);
    const listing = inputs
      .map((input) => `file '${path.resolve(input).replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fsp.writeFile(listFile, `${listing}\n`, 'utf8');

    try {
      await runCommand(
        this.ffmpeg,
        [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
          '-f', 'concat', '-safe', '0',
          '-i', listFile,
          '-c:a', 'pcm_s16le',
          '-ar', String(options.sampleRate ?? this.config.pipeline.targetSampleRate),
          path.resolve(output),
        ],
        { ...this.#runOptions(options), toolName: 'ffmpeg', stage: options.stage },
      );
    } finally {
      await fsp.rm(listFile, { force: true }).catch(() => {});
    }
    return this.#describeOutput(output, { kind: 'audio' });
  }

  /** Mixes a dialogue track with an optional background bed at given gains. */
  async mixAudio(sources, output, options = {}) {
    if (!Array.isArray(sources) || sources.length === 0) {
      throw new MediaError('mixAudio requires at least one source');
    }
    for (const source of sources) await this.#assertReadable(source.path);
    await ensureDir(path.dirname(output));

    const args = ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y'];
    for (const source of sources) {
      if (options.loopBackground && source.role === 'background') args.push('-stream_loop', '-1');
      args.push('-i', path.resolve(source.path));
    }

    const mixInputs = sources.map((s, i) => `[${i}:a]volume=${s.gain ?? 1}[a${i}]`).join(';');
    const labels = sources.map((_, i) => `[a${i}]`).join('');
    const filter = `${mixInputs};${labels}amix=inputs=${sources.length}:duration=first:dropout_transition=0[out]`;

    args.push(
      '-filter_complex', filter,
      '-map', '[out]',
      '-ar', String(options.sampleRate ?? this.config.pipeline.targetSampleRate),
      '-ac', String(options.channels ?? 2),
      '-c:a', 'pcm_s16le',
    );
    if (options.durationSeconds) args.push('-t', String(options.durationSeconds));
    args.push(path.resolve(output));

    await runCommand(this.ffmpeg, args, { ...this.#runOptions(options), toolName: 'ffmpeg', stage: options.stage });
    return this.#describeOutput(output, {
      kind: 'audio',
      durationSeconds: options.durationSeconds,
      sources: sources.length,
    });
  }

  /**
   * Renders the final video. Stream copy is used when the source video and the
   * new audio can be muxed without re-encoding, which is the common case; a
   * re-encode happens only when the caller asks for it or the copy is rejected.
   */
  async renderVideo(input, audioPath, output, options = {}) {
    await this.#assertReadable(input);
    await this.#assertReadable(audioPath);
    await ensureDir(path.dirname(output));

    const pipeline = this.config.pipeline;
    const container = options.container ?? pipeline.outputContainer;
    const reencode = options.reencode ?? false;

    const buildArgs = (copyVideo) => {
      const args = [
        '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-i', path.resolve(input),
        '-i', path.resolve(audioPath),
        '-map', '0:v:0?',
        '-map', '1:a:0',
      ];
      if (copyVideo) {
        args.push('-c:v', 'copy');
      } else {
        args.push(
          '-c:v', options.videoCodec ?? pipeline.outputVideoCodec,
          '-preset', options.preset ?? 'veryfast',
          '-crf', String(options.crf ?? 20),
          '-pix_fmt', 'yuv420p',
        );
      }
      args.push(
        '-c:a', options.audioCodec ?? pipeline.outputAudioCodec,
        '-b:a', options.audioBitrate ?? pipeline.outputAudioBitrate,
        '-ar', String(pipeline.targetSampleRate),
        '-ac', String(pipeline.outputChannels),
        '-movflags', '+faststart',
        '-shortest',
        path.resolve(output),
      );
      return args;
    };

    const wantCopy = options.copyVideo ?? !reencode;
    try {
      await runCommand(this.ffmpeg, buildArgs(wantCopy), {
        ...this.#runOptions(options),
        toolName: 'ffmpeg',
        stage: options.stage,
      });
      return { ...(await this.#describeOutput(output, { kind: 'video' })), videoReencoded: !wantCopy };
    } catch (err) {
      if (!wantCopy) throw err;
      // A stream copy can fail when the source codec is incompatible with the
      // container; re-encoding is the documented fallback.
      this.logger.warn('Stream copy mux failed; retrying render with re-encode', {
        error: err?.message,
      });
      await runCommand(this.ffmpeg, buildArgs(false), {
        ...this.#runOptions(options),
        toolName: 'ffmpeg',
        stage: options.stage,
      });
      return { ...(await this.#describeOutput(output, { kind: 'video' })), videoReencoded: true };
    }
  }

  #runOptions(options) {
    return {
      timeoutMs: options.timeoutMs ?? this.config.media.commandTimeoutMs,
      signal: options.signal,
      stage: options.stage,
    };
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
    if (stat.size === 0) {
      throw new MediaError('Media input is empty', {
        code: ErrorCode.CORRUPT_ARTIFACT,
        details: { input },
        recoveryScope: 'stage',
      });
    }
    return stat;
  }

  async #describeOutput(output, extra = {}) {
    const stat = await statSafe(output);
    if (!stat || stat.size === 0) {
      throw new MediaError('Media tool produced no output', {
        code: ErrorCode.CORRUPT_ARTIFACT,
        details: { output },
        recoveryScope: 'stage',
      });
    }
    let durationSeconds = extra.durationSeconds ?? null;
    if (durationSeconds == null && (output.endsWith('.wav') || output.endsWith('.mp3'))) {
      const probed = await this.probe(output).catch(() => null);
      durationSeconds = probed?.durationSeconds ?? null;
    }
    return {
      path: output,
      sizeBytes: stat.size,
      durationSeconds,
      ...extra,
    };
  }

  async #locateStems(workDir) {
    const found = { vocals: null, accompaniment: null };
    async function walk(dir) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.name.includes('vocals') && !entry.name.includes('no_vocals')) {
          found.vocals = found.vocals ?? full;
        } else if (entry.name.includes('no_vocals')) {
          found.accompaniment = found.accompaniment ?? full;
        }
      }
    }
    await walk(workDir);
    return found;
  }
}

/** Returns true when both ffmpeg and ffprobe resolve to working binaries. */
export async function ffmpegAvailable(config) {
  const { probeTool } = await import('./command.js');
  const [ffmpeg, ffprobe] = await Promise.all([
    probeTool(config.media.ffmpegPath),
    probeTool(config.media.ffprobePath, ['-version']),
  ]);
  return { ffmpeg, ffprobe, available: ffmpeg.available && ffprobe.available };
}
