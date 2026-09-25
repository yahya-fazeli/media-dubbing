import { StageName, StageStatus, SegmentStatus } from '../core/job-model.js';
import { PipelineContext, recordSegmentFailure, clearSegmentFailure } from './context.js';
import { alignSegment, fitSegmentToWindow, gradeFit } from './alignment.js';
import { decodeWav, encodeWav, toMono, resample, mixInto } from '../core/wav.js';
import { mapLimit } from '../core/concurrency.js';
import { ValidationError, MediaError, ErrorCode, ProviderError, toAppError } from '../core/errors.js';
import { isCancellation } from '../core/cancellation.js';
import { contentHash } from '../core/ids.js';
import { voiceForSegment, ttsFingerprint } from './voice.js';
import fsp from 'node:fs/promises';

/**
 * Synthesizes speech for every translated segment, with bounded concurrency.
 *
 * Two properties matter most here:
 *  - Partial completion: each segment's audio is written and recorded
 *    independently, so a run that fails halfway keeps everything it produced.
 *  - Reuse: a segment whose text, voice, and language are unchanged is not
 *    re-synthesized, which is what makes retrying a job cheap.
 */
export const ttsStage = {
  name: StageName.TTS,

  async run(context) {
    return context.runStage(StageName.TTS, async (ctx) => {
      const job = ctx.job;
      const concurrency = job.settings.ttsConcurrency ?? ctx.config.pipeline.ttsConcurrency;
      const maxAttempts = ctx.config.pipeline.maxSegmentAttempts;
      const log = ctx.stageLogger(StageName.TTS);

      const work = job.segments.filter((segment) => !isSegmentTerminal(segment));
      const skippedForMissingTranslation = job.segments.filter(
        (segment) => !segment.translatedText?.trim() && segment.status !== SegmentStatus.FAILED,
      );
      for (const segment of skippedForMissingTranslation) {
        segment.status = SegmentStatus.SKIPPED;
        segment.stages.tts = { status: StageStatus.SKIPPED, error: null, attempts: 0, reason: 'No translation available.' };
      }

      // Reuse existing audio wherever the inputs have not changed.
      let reused = 0;
      for (const segment of job.segments) {
        const expected = ttsFingerprint(ctx, segment);
        if (segment.fingerprints?.tts === expected && segment.artifacts.tts) {
          const check = await ctx.artifacts.verify(ctx.jobId, segment.artifacts.tts, { expectWav: true });
          if (check.valid) {
            segment.stages.tts = { status: StageStatus.SUCCEEDED, error: null, attempts: segment.stages.tts?.attempts ?? 0 };
            if (segment.status === SegmentStatus.PENDING) segment.status = SegmentStatus.TRANSLATED;
            reused += 1;
            continue;
          }
          segment.artifacts.tts = null;
        }
      }
      job.metrics.segmentsReused = reused;

      log.info('Synthesizing segments', { pending: work.length, concurrency, reused });
      let synthesized = 0;
      let audioSeconds = 0;

      const outcomes = await mapLimit(work, concurrency, async (segment) => {
        ctx.throwIfCancelled();
        const segmentLog = ctx.segmentLogger(StageName.TTS, segment.segmentId);

        const expected = ttsFingerprint(ctx, segment);
        if (segment.fingerprints?.tts === expected && segment.artifacts.tts) {
          return { segmentId: segment.segmentId, outcome: 'reused' };
        }
        if (!segment.translatedText?.trim()) {
          segment.status = SegmentStatus.SKIPPED;
          segment.stages.tts = { status: StageStatus.SKIPPED, error: null, attempts: 0, reason: 'Empty translation.' };
          return { segmentId: segment.segmentId, outcome: 'skipped' };
        }

        const voice = voiceForSegment(ctx, segment);
        segment.voice = voice;
        segment.status = SegmentStatus.SYNTHESIZING;
        segment.stages.tts = {
          ...(segment.stages.tts ?? {}),
          status: StageStatus.RUNNING,
          attempts: (segment.stages.tts?.attempts ?? 0) + 1,
        };
        const started = Date.now();

        try {
          const result = await synthesizeWithRetries(ctx, segment, voice, maxAttempts);
          const relative = ctx.artifacts.relativePath('tts', `${segment.segmentId}.wav`);
          await ctx.artifacts.writeBuffer(ctx.jobId, relative, result.audio);
          const verification = await ctx.artifacts.verify(ctx.jobId, relative, { expectWav: true });
          if (!verification.valid) {
            // A truncated write is a corrupt artifact: remove it so the retry
            // path does not mistake the leftover file for reusable work.
            await ctx.artifacts.remove(ctx.jobId, relative);
            throw new MediaError('Synthesized audio failed validation', {
              code: ErrorCode.CORRUPT_ARTIFACT,
              retryable: true,
              recoveryScope: 'segment',
              segmentId: segment.segmentId,
              details: { reason: verification.reason },
            });
          }

          const decoded = decodeWav(result.audio);
          segment.artifacts.tts = relative;
          segment.fingerprints.tts = expected;
          segment.durationMs = Date.now() - started;
          segment.stages.tts = { status: StageStatus.SUCCEEDED, error: null, attempts: segment.stages.tts.attempts };
          segment.status = SegmentStatus.SYNTHESIZED;
          segment.error = null;
          if (segment.alignment) segment.alignment = null;
          audioSeconds += decoded.durationSeconds;
          ctx.metrics?.increment('dub_tts_calls_total', 1, { provider: ctx.provider.name, outcome: 'ok' });
          ctx.metrics?.observe('dub_tts_duration_ms', segment.durationMs, { provider: ctx.provider.name });
          ctx.metrics?.observe('dub_tts_audio_seconds_total', decoded.durationSeconds, {});
          segmentLog.debug('Segment synthesized', {
            durationMs: segment.durationMs, audioSeconds: round(decoded.durationSeconds, 3), voice,
          });
          return { segmentId: segment.segmentId, outcome: 'synthesized', audioSeconds: decoded.durationSeconds };
        } catch (err) {
          const appErr = toAppError(err, { stage: StageName.TTS, segmentId: segment.segmentId });
          if (isCancellation(appErr)) throw appErr;
          ctx.metrics?.increment('dub_tts_errors_total', 1, { provider: ctx.provider.name, code: appErr.code });
          recordSegmentFailure(ctx, segment, appErr, 'tts');
          segmentLog.warn('Segment synthesis failed', { code: appErr.code, error: appErr.message });
          return { segmentId: segment.segmentId, outcome: 'failed', error: appErr.toJSON() };
        }
      }, {
        onSettled: async () => { await ctx.save(); },
      });

      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          if (isCancellation(outcome.reason)) throw outcome.reason;
          log.warn('Segment worker errored', { error: outcome.reason?.message });
        } else if (outcome.value?.outcome === 'synthesized') {
          synthesized += 1;
          audioSeconds += outcome.value.audioSeconds ?? 0;
        }
      }

      job.metrics.ttsAudioSeconds = round(audioSeconds, 3);
      const failed = job.segments.filter((s) => s.status === SegmentStatus.FAILED).length;
      const metadata = {
        total: job.segments.length,
        synthesized,
        reused,
        failed,
        skipped: skippedForMissingTranslation.length,
        audioSeconds: round(audioSeconds, 3),
        concurrency,
        provider: ctx.provider.name,
      };
      log.info('Synthesis complete', metadata);
      return { artifact: 'tts/', metadata };
    });
  },
};

async function synthesizeWithRetries(ctx, segment, voice, maxAttempts) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    ctx.throwIfCancelled();
    try {
      return await ctx.provider.synthesize(segment.translatedText, {
        segmentId: segment.segmentId,
        targetLanguage: ctx.job.languages.target,
        voice,
        sampleRate: ctx.config.pipeline.targetSampleRate,
        signal: ctx.signal,
        stage: StageName.TTS,
      });
    } catch (err) {
      const appErr = toAppError(err, { stage: StageName.TTS, segmentId: segment.segmentId });
      if (isCancellation(appErr)) throw appErr;
      lastError = appErr;
      if (!appErr.retryable || attempt === maxAttempts) break;
      ctx.metrics?.increment('dub_segment_retries_total', 1, { stage: StageName.TTS, code: appErr.code });
      const delay = Math.min(8000, 400 * 2 ** (attempt - 1));
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError ?? new ProviderError('Synthesis failed', { code: ErrorCode.TTS_ERROR, segmentId: segment.segmentId });
}

/**
 * Measures each synthesized segment against its source window. This stage does
 * not change audio; it records drift and feasibility so the timeline view and the
 * timing stage both have a shared basis.
 */
export const alignmentStage = {
  name: StageName.ALIGNMENT,

  async run(context) {
    return context.runStage(StageName.ALIGNMENT, async (ctx) => {
      const job = ctx.job;
      const pipeline = ctx.config.pipeline;
      const log = ctx.stageLogger(StageName.ALIGNMENT);
      const targets = job.segments.filter((s) => s.artifacts.tts && s.status !== SegmentStatus.FAILED);

      const outcomes = await mapLimit(targets, pipeline.segmentConcurrency, async (segment) => {
        ctx.throwIfCancelled();
        try {
          const buffer = await ctx.artifacts.readBuffer(ctx.jobId, segment.artifacts.tts);
          const alignment = alignSegment(decodeWav(buffer), {
            windowStart: segment.start,
            windowEnd: segment.end,
            sampleRate: pipeline.targetSampleRate,
            minTempo: pipeline.minTempo,
            maxTempo: pipeline.maxTempo,
          });
          const grade = gradeFit(alignment);
          segment.alignment = {
            speechSeconds: alignment.speechSeconds,
            windowSeconds: alignment.windowSeconds,
            driftSeconds: alignment.driftSeconds,
            fitRatio: alignment.fitRatio,
            requiredTempo: alignment.requiredTempo,
            feasible: alignment.feasible,
            quality: alignment.quality,
            grade: grade.grade,
            reason: grade.reason,
          };
          segment.quality = { ...(segment.quality ?? {}), alignment: grade };
          segment.stages.alignment = { status: StageStatus.SUCCEEDED, error: null, attempts: (segment.stages.alignment?.attempts ?? 0) };
          segment.status = SegmentStatus.ALIGNED;
          return { segmentId: segment.segmentId, grade: grade.grade };
        } catch (err) {
          const appErr = toAppError(err, { stage: StageName.ALIGNMENT, segmentId: segment.segmentId });
          if (isCancellation(appErr)) throw appErr;
          recordSegmentFailure(ctx, segment, appErr, 'alignment');
          return { segmentId: segment.segmentId, grade: 'fail' };
        }
      }, { onSettled: async () => { await ctx.save(); } });

      const grades = { ok: 0, warn: 0, fail: 0, unknown: 0 };
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          if (isCancellation(outcome.reason)) throw outcome.reason;
          continue;
        }
        grades[outcome.value?.grade ?? 'unknown'] = (grades[outcome.value?.grade ?? 'unknown'] ?? 0) + 1;
      }

      const metadata = { aligned: targets.length, grades };
      log.info('Alignment complete', metadata);
      if (grades.fail > 0) {
        ctx.metrics?.increment('dub_quality_failures_total', grades.fail, { stage: StageName.ALIGNMENT });
      }
      return { artifact: null, metadata };
    });
  },
};

/**
 * Fits each aligned segment into its window by adjusting tempo within bounds,
 * trimming, or padding. The fitted audio is what the mixer consumes.
 */
export const timingStage = {
  name: StageName.TIMING,

  async run(context) {
    return context.runStage(StageName.TIMING, async (ctx) => {
      const job = ctx.job;
      const pipeline = ctx.config.pipeline;
      const log = ctx.stageLogger(StageName.TIMING);
      const targets = job.segments.filter((s) => s.artifacts.tts && s.status !== SegmentStatus.FAILED);

      const outcomes = await mapLimit(targets, pipeline.segmentConcurrency, async (segment) => {
        ctx.throwIfCancelled();
        try {
          const buffer = await ctx.artifacts.readBuffer(ctx.jobId, segment.artifacts.tts);
          const fitted = fitSegmentToWindow(decodeWav(buffer), {
            windowSeconds: segment.durationSeconds,
            sampleRate: pipeline.targetSampleRate,
            minTempo: pipeline.minTempo,
            maxTempo: pipeline.maxTempo,
          });
          const relative = ctx.artifacts.relativePath('fitted', `${segment.segmentId}.wav`);
          await ctx.artifacts.writeBuffer(ctx.jobId, relative, fitted.wav);
          segment.artifacts.fitted = relative;
          segment.timing = {
            appliedTempo: fitted.appliedTempo,
            action: fitted.action,
            speechSeconds: fitted.speechSeconds,
            finalSeconds: fitted.finalSeconds,
            trimmedSeconds: fitted.trimmedSeconds,
            paddedSeconds: fitted.paddedSeconds,
            fits: fitted.fits,
          };
          segment.stages.timing = { status: StageStatus.SUCCEEDED, error: null, attempts: (segment.stages.timing?.attempts ?? 0) };
          segment.status = SegmentStatus.FITTED;
          return { segmentId: segment.segmentId, fits: fitted.fits, action: fitted.action };
        } catch (err) {
          const appErr = toAppError(err, { stage: StageName.TIMING, segmentId: segment.segmentId });
          if (isCancellation(appErr)) throw appErr;
          recordSegmentFailure(ctx, segment, appErr, 'timing');
          return { segmentId: segment.segmentId, fits: false };
        }
      }, { onSettled: async () => { await ctx.save(); } });

      const actions = {};
      let trimmed = 0;
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          if (isCancellation(outcome.reason)) throw outcome.reason;
          continue;
        }
        const { action, fits } = outcome.value ?? {};
        if (action) actions[action] = (actions[action] ?? 0) + 1;
        if (!fits) trimmed += 1;
      }

      const metadata = { fitted: targets.length, actions, segmentsNeedingTrim: trimmed };
      log.info('Timing complete', metadata);
      if (trimmed > 0) {
        log.warn('Some segments did not fit their window', { count: trimmed });
      }
      return { artifact: 'fitted/', metadata };
    });
  },
};

/**
 * Mixes fitted dialogue onto the timeline, optionally over a background bed.
 *
 * A single timeline buffer is built in memory rather than concatenating clips,
 * because segments must land at their original timestamps — gaps between
 * segments are part of the original timing and must be preserved.
 */
export const mixingStage = {
  name: StageName.MIXING,

  async run(context) {
    return context.runStage(StageName.MIXING, async (ctx) => {
      const job = ctx.job;
      const pipeline = ctx.config.pipeline;
      const log = ctx.stageLogger(StageName.MIXING);
      const sampleRate = pipeline.targetSampleRate;
      const channels = pipeline.outputChannels;

      const duration = job.source.durationSeconds
        ?? Math.max(...job.segments.map((s) => s.end), 0);
      if (!(duration > 0)) {
        throw new ValidationError('Cannot mix audio without a known duration', { retryable: false, recoveryScope: 'none' });
      }

      const timeline = new Int16Array(Math.round(duration * sampleRate) * channels);
      const dialogueGain = dbToGain(job.settings.dialogueGainDb ?? pipeline.dialogueGainDb);
      const bedGain = dbToGain(job.settings.musicBedGainDb ?? pipeline.musicBedGainDb);

      let mixed = 0;
      let skipped = 0;

      for (const segment of job.segments) {
        ctx.throwIfCancelled();
        const source = segment.artifacts.fitted ?? segment.artifacts.tts;
        if (!source || segment.status === SegmentStatus.FAILED) {
          if (segment.status !== SegmentStatus.FAILED) {
            segment.stages.mixing = { status: StageStatus.SKIPPED, error: null, attempts: 0, reason: 'No fitted audio.' };
            if (segment.status !== SegmentStatus.SKIPPED) segment.status = SegmentStatus.SKIPPED;
            skipped += 1;
          }
          continue;
        }
        try {
          const buffer = await ctx.artifacts.readBuffer(ctx.jobId, source);
          const decoded = decodeWav(buffer);
          const mono = toMono(decoded.samples, decoded.channels);
          const atRate = decoded.sampleRate === sampleRate ? mono : resample(mono, decoded.sampleRate, sampleRate, 1);
          const startFrame = Math.round(segment.start * sampleRate) * channels;
          const patch = new Int16Array(atRate.length * channels);
          for (let i = 0; i < atRate.length; i += 1) {
            for (let c = 0; c < channels; c += 1) patch[i * channels + c] = atRate[i];
          }
          mixInto(timeline, patch, startFrame, dialogueGain);
          segment.stages.mixing = { status: StageStatus.SUCCEEDED, error: null, attempts: (segment.stages.mixing?.attempts ?? 0) };
          segment.status = SegmentStatus.MIXED;
          mixed += 1;
        } catch (err) {
          const appErr = toAppError(err, { stage: StageName.MIXING, segmentId: segment.segmentId });
          if (isCancellation(appErr)) throw appErr;
          recordSegmentFailure(ctx, segment, appErr, 'mixing');
        }
      }

      // Lay the original background underneath the dialogue when separation
      // produced a bed, or when the job asked to keep the source audio.
      let backgroundUsed = null;
      const bedRelative = job.artifacts.accompaniment
        ?? (job.settings.keepSourceAudio && !job.artifacts.vocals ? job.artifacts.extractedAudio : null);
      if (bedRelative) {
        try {
          const bedBuffer = await ctx.artifacts.readBuffer(ctx.jobId, bedRelative);
          const bed = decodeWav(bedBuffer);
          const bedMono = toMono(bed.samples, bed.channels);
          const bedAtRate = bed.sampleRate === sampleRate
            ? bedMono
            : resample(bedMono, bed.sampleRate, sampleRate, 1);
          const totalFrames = timeline.length / channels;
          for (let i = 0; i < Math.min(bedAtRate.length, totalFrames); i += 1) {
            const value = bedAtRate[i] * bedGain;
            for (let c = 0; c < channels; c += 1) {
              const idx = i * channels + c;
              timeline[idx] = clamp16(timeline[idx] + value);
            }
          }
          backgroundUsed = { relative: bedRelative, gainDb: bedGain === 0 ? null : gainToDb(bedGain) };
          log.info('Background bed mixed under dialogue', { relative: bedRelative });
        } catch (err) {
          // A missing bed degrades the mix but should not fail the stage; the
          // dialogue track alone is still a valid dub.
          log.warn('Background bed could not be mixed; continuing with dialogue only', {
            relative: bedRelative, error: err.message,
          });
        }
      }

      const relative = ctx.artifacts.relativePath('audio', 'dubbed.wav');
      await ctx.artifacts.writeBuffer(ctx.jobId, relative, encodeWav({ samples: timeline, sampleRate, channels }));
      const verification = await ctx.artifacts.verify(ctx.jobId, relative, { expectWav: true });
      if (!verification.valid) {
        throw new MediaError('Mixed audio failed validation', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
          details: { reason: verification.reason },
        });
      }
      job.artifacts.dubbedAudio = relative;

      // Optional loudness normalization on the finished mix. Runs through the
      // engine (ffmpeg loudnorm, or the mock's RMS gain) so the pure-JS mixer and
      // the ffmpeg path converge on comparable output levels.
      let normalized = null;
      if (job.settings.normalizeLoudness ?? pipeline.normalizeLoudness) {
        const normalizedRelative = ctx.artifacts.relativePath('audio', 'dubbed-normalized.wav');
        const normalizedPath = ctx.artifacts.resolve(ctx.jobId, normalizedRelative);
        try {
          const result = await ctx.engine.normalizeAudio(
            ctx.artifacts.resolve(ctx.jobId, relative),
            normalizedPath,
            {
              targetLufs: job.settings.targetLufs ?? pipeline.targetLufs,
              sampleRate,
              channels,
              signal: ctx.signal,
              stage: StageName.MIXING,
            },
          );
          const check = await ctx.artifacts.verify(ctx.jobId, normalizedRelative, { expectWav: true });
          if (!check.valid) throw new MediaError('Normalized audio failed validation', { code: ErrorCode.CORRUPT_ARTIFACT });
          job.artifacts.dubbedAudio = normalizedRelative;
          normalized = {
            relative: normalizedRelative,
            targetLufs: job.settings.targetLufs ?? pipeline.targetLufs,
            appliedGain: result?.appliedGain ?? null,
          };
          log.info('Loudness normalized', { relative: normalizedRelative });
        } catch (err) {
          // Normalization is a refinement; a failure leaves the validated mix in
          // place rather than failing an otherwise complete dub.
          log.warn('Loudness normalization failed; keeping the un-normalized mix', { error: err.message });
        }
      }

      const failed = job.segments.filter((s) => s.status === SegmentStatus.FAILED).length;
      const metadata = {
        durationSeconds: round(duration, 3),
        mixed,
        skipped,
        failed,
        background: backgroundUsed,
        normalized,
        sampleRate,
        channels,
        sizeBytes: verification.sizeBytes,
        fingerprint: contentHash(relative, mixed, duration.toFixed(3)),
      };
      log.info('Mixing complete', { mixed, skipped, failed });
      return { artifact: relative, metadata };
    });
  },
};

function isSegmentTerminal(segment) {
  return [SegmentStatus.SKIPPED, SegmentStatus.FAILED].includes(segment.status)
    && segment.stages.tts?.status !== StageStatus.PENDING;
}

function dbToGain(db) {
  if (!Number.isFinite(db) || db === 0) return 1;
  return 10 ** (db / 20);
}

function gainToDb(gain) {
  if (!gain || gain === 1) return 0;
  return round(20 * Math.log10(gain), 2);
}

function clamp16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export { PipelineContext };
