import { StageName, StageStatus } from '../core/job-model.js';
import { enforceMediaLimits } from '../media/ingest.js';
import { extensionOf } from '../core/fsutil.js';
import { MediaError, ErrorCode, ValidationError } from '../core/errors.js';
import { contentHash } from '../core/ids.js';

/**
 * Ingest verifies that the stored source is actually usable and caches the probe
 * result on the job. Running it as a stage (rather than only at upload time)
 * means a resumed job re-validates a source that may have been replaced or
 * truncated while the server was down, instead of failing later inside ffmpeg.
 */
export const ingestStage = {
  name: StageName.INGEST,

  async run(context) {
    return context.runStage(StageName.INGEST, async (ctx) => {
      const job = ctx.job;
      const sourcePath = ctx.artifacts.resolve(ctx.jobId, job.source.relativePath);

      const probe = await ctx.engine.probe(sourcePath, { signal: ctx.signal, stage: StageName.INGEST });
      await enforceMediaLimits(ctx.config, ctx.engine, sourcePath, probe);

      if (probe.durationSeconds <= 0) {
        throw new MediaError('Source media has no measurable duration', {
          code: ErrorCode.VALIDATION,
          retryable: false,
          recoveryScope: 'none',
          recommendedAction: 'Re-upload a source file that contains playable audio.',
        });
      }

      job.source.probe = probe;
      job.source.durationSeconds = probe.durationSeconds;
      job.source.sizeBytes = probe.sizeBytes;
      job.source.hasVideo = probe.hasVideo;

      const fingerprint = contentHash(job.source.relativePath, probe.sizeBytes, probe.durationSeconds);
      job.stages[StageName.INGEST].metadata = {
        durationSeconds: probe.durationSeconds,
        hasVideo: probe.hasVideo,
        hasAudio: probe.hasAudio,
        audioCodec: probe.audio?.codec ?? null,
        videoCodec: probe.video?.codec ?? null,
        fingerprint,
      };
      ctx.stageLogger(StageName.INGEST).info('Source validated', {
        durationSeconds: probe.durationSeconds,
        hasVideo: probe.hasVideo,
      });
      return { metadata: job.stages[StageName.INGEST].metadata };
    });
  },
};

/**
 * Extracts a mono 16-bit PCM working track. If the source is already a 16-bit
 * mono WAV at the target rate it is copied rather than re-encoded, which both
 * saves time and avoids a needless generation loss.
 */
export const audioExtractStage = {
  name: StageName.AUDIO_EXTRACT,

  async run(context) {
    return context.runStage(StageName.AUDIO_EXTRACT, async (ctx) => {
      const job = ctx.job;
      const relative = ctx.artifacts.relativePath('audio', 'source.wav');
      const outputPath = ctx.artifacts.resolve(ctx.jobId, relative);
      const sourcePath = ctx.artifacts.resolve(ctx.jobId, job.source.relativePath);
      const sampleRate = ctx.config.pipeline.targetSampleRate;

      const probe = job.source.probe ?? {};
      // Audio-only sources already in the exact working format need no
      // conversion. The extension check matters: a video container may report a
      // PCM audio stream, and copying it under a .wav name would produce a file
      // whose header does not match its extension.
      const alreadyUsable = extensionOf(job.source.relativePath) === '.wav'
        && probe.audio?.codec === 'pcm_s16le'
        && probe.audio?.sampleRate === sampleRate
        && probe.audio?.channels === 1;

      if (alreadyUsable) {
        const copy = await ctx.artifacts.copyIn(ctx.jobId, sourcePath, relative);
        job.artifacts.extractedAudio = relative;
        return {
          artifact: relative,
          metadata: { copied: true, sampleRate, durationSeconds: probe.durationSeconds, sizeBytes: copy.sizeBytes },
        };
      }

      const result = await ctx.engine.extractAudio(sourcePath, outputPath, {
        sampleRate,
        channels: 1,
        durationSeconds: job.source.durationSeconds,
        signal: ctx.signal,
        stage: StageName.AUDIO_EXTRACT,
      });

      const verification = await ctx.artifacts.verify(ctx.jobId, relative, { expectWav: true });
      if (!verification.valid) {
        throw new MediaError('Extracted audio failed validation', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
          details: { reason: verification.reason },
        });
      }

      job.artifacts.extractedAudio = relative;
      const metadata = {
        copied: false,
        sampleRate,
        durationSeconds: result.durationSeconds ?? job.source.durationSeconds,
        sizeBytes: verification.sizeBytes,
      };
      ctx.stageLogger(StageName.AUDIO_EXTRACT).info('Audio extracted', metadata);
      return { artifact: relative, metadata };
    });
  },
};

/**
 * Optional vocal separation. When the job did not request it, the stage is
 * marked skipped with a reason (not failed) so the pipeline continues and the UI
 * can explain the choice.
 */
export const vocalSeparationStage = {
  name: StageName.VOCAL_SEPARATION,

  async run(context) {
    return context.runStage(StageName.VOCAL_SEPARATION, async (ctx) => {
      const job = ctx.job;
      const requested = job.settings.separateVocals === true;

      if (!requested) {
        return {
          skipReason: 'Vocal separation was not requested for this job.',
          metadata: { requested: false },
        };
      }
      if (!job.artifacts.extractedAudio) {
        throw new ValidationError('No extracted audio is available to separate', {
          recoveryScope: 'stage',
          retryable: true,
        });
      }

      const inputPath = ctx.artifacts.resolve(ctx.jobId, job.artifacts.extractedAudio);
      const vocalsRel = ctx.artifacts.relativePath('audio', 'vocals.wav');
      const accompanimentRel = ctx.artifacts.relativePath('audio', 'accompaniment.wav');

      const result = await ctx.engine.separateVocals(inputPath, ctx.artifacts.resolve(ctx.jobId, vocalsRel), {
        accompanimentPath: ctx.artifacts.resolve(ctx.jobId, accompanimentRel),
        workDir: ctx.artifacts.resolve(ctx.jobId, 'audio', 'separation'),
        signal: ctx.signal,
        stage: StageName.VOCAL_SEPARATION,
      });

      const verification = await ctx.artifacts.verify(ctx.jobId, vocalsRel, { expectWav: true });
      if (!verification.valid) {
        throw new MediaError('Vocal separation produced an invalid stem', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
          details: { reason: verification.reason },
        });
      }

      job.artifacts.vocals = vocalsRel;
      const metadata = {
        requested: true,
        separated: result.separated,
        model: result.model ?? null,
        reason: result.reason ?? null,
        sizeBytes: verification.sizeBytes,
      };
      if (result.accompanimentPath) {
        const accompanimentExists = await ctx.artifacts.exists(ctx.jobId, accompanimentRel);
        metadata.hasAccompaniment = accompanimentExists;
        if (accompanimentExists) job.artifacts.accompaniment = accompanimentRel;
      }
      return { artifact: vocalsRel, metadata };
    });
  },
};

export function transcriptionInputPath(job) {
  // Speech detection runs against the separated vocals when available, since
  // background music confuses transcription on busy mixes.
  return job.artifacts.vocals ?? job.artifacts.extractedAudio;
}

export { StageStatus };
