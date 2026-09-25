import { StageName, StageStatus, SegmentStatus, createSegmentRecord } from '../core/job-model.js';
import { AUTO_DETECT_LANGUAGE, isLanguageCode } from '../core/languages.js';
import { segmentWords, segmentFingerprint } from './segmentation.js';
import { PipelineContext, recordSegmentFailure, clearSegmentFailure } from './context.js';
import { transcriptionInputPath } from './stages-media.js';
import {
  MediaError, ProviderError, ErrorCode, ValidationError, CancelledError, toAppError,
} from '../core/errors.js';
import { isCancellation } from '../core/cancellation.js';
import { mapLimit, chunk } from '../core/concurrency.js';
import { contentHash } from '../core/ids.js';
import { decodeWav, encodeWav } from '../core/wav.js';
import fsp from 'node:fs/promises';

/**
 * Long sources are transcribed in windows so no single request exceeds the
 * provider's inline-audio limit. Overlapping windows keep words at the boundary
 * from being lost; the stitch step drops duplicates in the overlap.
 */
const TRANSCRIPTION_WINDOW_SECONDS = 240;
const TRANSCRIPTION_OVERLAP_SECONDS = 5;

export const transcriptionStage = {
  name: StageName.TRANSCRIPTION,

  async run(context) {
    return context.runStage(StageName.TRANSCRIPTION, async (ctx) => {
      const job = ctx.job;
      const inputRel = transcriptionInputPath(job);
      if (!inputRel) {
        throw new ValidationError('No audio is available for transcription', { retryable: true, recoveryScope: 'stage' });
      }

      const inputPath = ctx.artifacts.resolve(ctx.jobId, inputRel);
      const verification = await ctx.artifacts.verify(ctx.jobId, inputRel, { expectWav: true });
      if (!verification.valid) {
        throw new MediaError('Transcription input audio is invalid', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
          details: { reason: verification.reason },
        });
      }

      const durationSeconds = job.source.durationSeconds ?? 0;
      const windows = buildWindows(durationSeconds, TRANSCRIPTION_WINDOW_SECONDS, TRANSCRIPTION_OVERLAP_SECONDS);
      const audioBuffer = await fsp.readFile(inputPath);

      const log = ctx.stageLogger(StageName.TRANSCRIPTION);
      log.info('Transcribing', { windows: windows.length, durationSeconds });

      const parts = [];
      for (const [index, window] of windows.entries()) {
        ctx.throwIfCancelled();
        const slice = extractWindowAudio(audioBuffer, window, ctx.config.pipeline.targetSampleRate);
        const result = await ctx.provider.transcribe(slice.base64, {
          mimeType: 'audio/wav',
          language: job.languages.source,
          durationSeconds: window.duration,
          signal: ctx.signal,
          stage: StageName.TRANSCRIPTION,
        });
        parts.push({ window, words: result.words ?? [], language: result.language });
        log.debug('Transcription window complete', {
          window: index + 1, of: windows.length, words: result.words?.length ?? 0,
          language: result.language ?? null,
        });
      }

      const words = stitchWindows(parts);
      if (!words.length) {
        throw new ProviderError('Transcription produced no words', {
          code: ErrorCode.PROVIDER_ERROR,
          retryable: true,
          recoveryScope: 'stage',
          recommendedAction: 'Retry transcription; the source may contain no audible speech.',
        });
      }

      const detectedLanguage = selectDetectedLanguage(parts, job.languages.source);
      job.languages.detectedSource = detectedLanguage;
      const sourceLanguage = effectiveSourceLanguage(job);
      const relative = ctx.artifacts.relativePath('transcript', 'words.json');
      const transcript = {
        language: sourceLanguage,
        requestedLanguage: job.languages.source,
        durationSeconds,
        words,
        text: words.map((w) => w.text).join(' '),
        provider: ctx.provider.name,
        windows: windows.length,
      };
      await ctx.artifacts.writeJson(ctx.jobId, relative, transcript);

      job.artifacts.transcript = relative;
      const metadata = {
        wordCount: words.length,
        language: sourceLanguage,
        detectedLanguage,
        provider: transcript.provider,
        windows: windows.length,
        fingerprint: contentHash(transcript.text, words.length),
      };
      log.info('Transcription complete', { words: words.length, language: sourceLanguage });
      return { artifact: relative, metadata };
    });
  },
};

/**
 * Groups transcribed words into dubbing segments. Segment ids and timings are
 * derived from content, so re-running this stage on the same transcript produces
 * identical ids and previously generated audio stays reusable.
 */
export const segmentationStage = {
  name: StageName.SEGMENTATION,

  async run(context) {
    return context.runStage(StageName.SEGMENTATION, async (ctx) => {
      const job = ctx.job;
      if (!job.artifacts.transcript) {
        throw new ValidationError('Transcription must succeed before segmentation', {
          retryable: true, recoveryScope: 'stage',
        });
      }
      const transcript = await ctx.artifacts.readJson(ctx.jobId, job.artifacts.transcript);
      const pipeline = ctx.config.pipeline;

      const groups = segmentWords(transcript.words, {
        targetSeconds: pipeline.targetSegmentSeconds,
        minSeconds: pipeline.minSegmentSeconds,
        maxSeconds: pipeline.maxSegmentSeconds,
      });
      if (!groups.length) {
        throw new ValidationError('Segmentation produced no segments', {
          retryable: false,
          recoveryScope: 'none',
          recommendedAction: 'The transcript contained no usable words; re-run transcription.',
        });
      }

      // Preserve work already done on segments whose content is unchanged. This
      // is what makes a re-run of segmentation cheap after a resume.
      const previous = new Map(job.segments.map((s) => [s.segmentId, s]));
      job.segments = groups.map((group, index) => {
        const existing = previous.get(group.segmentId);
        const fingerprint = contentHash(group.text, group.start.toFixed(3), group.end.toFixed(3));
        const base = existing ?? createSegmentRecord(index, group);
        const contentChanged = existing && existing.fingerprints?.source !== fingerprint;
        return {
          ...base,
          segmentId: group.segmentId,
          index,
          start: group.start,
          end: group.end,
          durationSeconds: group.durationSeconds,
          sourceText: group.text,
          words: group.words,
          fingerprints: { ...(base.fingerprints ?? {}), source: fingerprint },
          // A changed source text invalidates downstream artifacts.
          ...(contentChanged ? resetDownstream(base) : {}),
        };
      });

      await ctx.artifacts.writeJson(ctx.jobId, ctx.artifacts.relativePath('segments', 'segments.json'), {
        segments: job.segments.map((s) => ({
          segmentId: s.segmentId, index: s.index, start: s.start, end: s.end, sourceText: s.sourceText,
        })),
      });

      const metadata = {
        segmentCount: job.segments.length,
        targetSeconds: pipeline.targetSegmentSeconds,
        averageSeconds: round(job.segments.reduce((sum, s) => sum + s.durationSeconds, 0) / job.segments.length, 3),
        reusedSegments: job.segments.filter((s) => previous.has(s.segmentId)).length,
      };
      job.metrics.segmentsTotal = job.segments.length;
      ctx.stageLogger(StageName.SEGMENTATION).info('Segmentation complete', metadata);
      return { artifact: 'segments/segments.json', metadata };
    });
  },
};

/**
 * Translates segments in batches so the model can use surrounding context while
 * still bounding request size. Batches run sequentially because context for a
 * batch is improved by having translated the previous one.
 */
export const translationStage = {
  name: StageName.TRANSLATION,

  async run(context) {
    return context.runStage(StageName.TRANSLATION, async (ctx) => {
      const job = ctx.job;
      const batchSize = ctx.config.pipeline.translationBatchSize;
      const tone = job.settings.translationTone ?? 'neutral';
      const sourceLanguage = effectiveSourceLanguage(job);

      const pending = job.segments.filter((segment) => {
        const stage = segment.stages.translation;
        if (stage?.status === StageStatus.SUCCEEDED && segment.translatedText) {
          // Reuse is allowed only when the source text is unchanged.
          return segment.fingerprints?.translation !== translationFingerprint(ctx, segment);
        }
        return true;
      });

      const log = ctx.stageLogger(StageName.TRANSLATION);
      log.info('Translating segments', { pending: pending.length, total: job.segments.length, batchSize });

      const batches = chunk(pending, batchSize);
      let translated = 0;
      let reused = 0;

      for (const batch of batches) {
        ctx.throwIfCancelled();
        try {
          const results = await ctx.provider.translate(
            batch.map((s) => ({ segmentId: s.segmentId, text: s.sourceText, context: tone })),
            {
              sourceLanguage,
              targetLanguage: job.languages.target,
              signal: ctx.signal,
              stage: StageName.TRANSLATION,
            },
          );
          const byId = new Map(results.map((r) => [r.segmentId, r]));
          for (const segment of batch) {
            const result = byId.get(segment.segmentId);
            if (!result) {
              throw new ProviderError(`Translation missing for ${segment.segmentId}`, {
                code: ErrorCode.PROVIDER_ERROR, retryable: true, recoveryScope: 'segment',
                segmentId: segment.segmentId,
              });
            }
            segment.translatedText = result.text;
            segment.status = SegmentStatus.TRANSLATED;
            segment.fingerprints.translation = translationFingerprint(ctx, segment);
            clearSegmentFailure(segment, 'translation');
            translated += 1;
          }
        } catch (err) {
          const appErr = toAppError(err, { stage: StageName.TRANSLATION });
          if (isCancellation(appErr)) throw appErr;
          // A failed batch is not fatal: mark those segments failed and let the
          // operator retry them individually. Before degradation, try once per
          // segment so one bad item does not take its batch down with it.
          log.warn('Translation batch failed; retrying segments individually', {
            batchSize: batch.length, error: appErr.message,
          });
          const outcomes = await mapLimit(batch, 1, async (segment) => {
            ctx.throwIfCancelled();
            try {
              const [result] = await ctx.provider.translate(
                [{ segmentId: segment.segmentId, text: segment.sourceText, context: tone }],
                {
                  sourceLanguage,
                  targetLanguage: job.languages.target,
                  signal: ctx.signal,
                  stage: StageName.TRANSLATION,
                },
              );
              segment.translatedText = result.text;
              segment.status = SegmentStatus.TRANSLATED;
              segment.fingerprints.translation = translationFingerprint(ctx, segment);
              clearSegmentFailure(segment, 'translation');
              return 'ok';
            } catch (segmentErr) {
              recordSegmentFailure(ctx, segment, segmentErr, 'translation');
              return 'failed';
            }
          });
          translated += outcomes.filter((o) => o.status === 'fulfilled' && o.value === 'ok').length;
          for (const outcome of outcomes) {
            if (outcome.status === 'rejected' && outcome.reason && !isCancellation(outcome.reason)) {
              log.warn('Segment translation errored', { error: outcome.reason.message });
            }
          }
        }
        await ctx.save();
      }

      reused = job.segments.filter(
        (s) => s.status !== SegmentStatus.FAILED && s.translatedText
          && s.fingerprints?.translation === translationFingerprint(ctx, s),
      ).length - translated;

      const failed = job.segments.filter((s) => s.status === SegmentStatus.FAILED).length;
      await ctx.artifacts.writeJson(ctx.jobId, ctx.artifacts.relativePath('transcript', 'translations.json'), {
        sourceLanguage,
        targetLanguage: job.languages.target,
        segments: job.segments.map((s) => ({
          segmentId: s.segmentId, start: s.start, end: s.end,
          sourceText: s.sourceText, translatedText: s.translatedText, status: s.status,
        })),
      });
      job.artifacts.translations = 'transcript/translations.json';

      const metadata = {
        translated,
        reused: Math.max(0, reused),
        failed,
        total: job.segments.length,
        provider: ctx.provider.name,
      };
      log.info('Translation complete', metadata);
      return { artifact: job.artifacts.translations, metadata };
    });
  },
};

function translationFingerprint(ctx, segment) {
  return contentHash(
    segment.sourceText,
    effectiveSourceLanguage(ctx.job),
    ctx.job.languages.target,
    ctx.job.settings.translationTone ?? 'neutral',
  );
}

/** Drops downstream results for a segment whose source content changed. */
function resetDownstream(segment) {
  return {
    translatedText: '',
    status: SegmentStatus.PENDING,
    stages: {
      translation: { status: StageStatus.PENDING, error: null, attempts: 0 },
      tts: { status: StageStatus.PENDING, error: null, attempts: 0 },
      alignment: { status: StageStatus.PENDING, error: null, attempts: 0 },
      timing: { status: StageStatus.PENDING, error: null, attempts: 0 },
      mixing: { status: StageStatus.PENDING, error: null, attempts: 0 },
    },
    artifacts: { tts: null, aligned: null, fitted: null, mixed: null },
    alignment: null,
    timing: null,
    quality: null,
    error: null,
  };
}

function effectiveSourceLanguage(job) {
  if (job.languages.source !== AUTO_DETECT_LANGUAGE) return job.languages.source;
  const detected = job.languages.detectedSource;
  if (!isLanguageCode(detected)) {
    throw new ValidationError('Automatic source-language detection has not completed', {
      retryable: true,
      recoveryScope: 'stage',
      recommendedAction: 'Re-run transcription so the provider can detect the source language.',
    });
  }
  return detected;
}

function selectDetectedLanguage(parts, requestedLanguage) {
  // Explicit source choices are authoritative; provider-reported labels are
  // still recorded separately by the transcription provider, but must not make
  // a manually selected job ambiguous.
  if (requestedLanguage !== AUTO_DETECT_LANGUAGE) return requestedLanguage;

  const candidates = parts
    .map((part) => String(part.language ?? '').trim())
    .filter((language) => isLanguageCode(language));
  if (!candidates.length) {
    throw new ProviderError('Transcription did not report a detectable source language', {
      code: ErrorCode.PROVIDER_ERROR,
      retryable: true,
      recoveryScope: 'stage',
      recommendedAction: 'Retry transcription and ensure the provider returns a BCP-47 language code.',
    });
  }

  const counts = new Map();
  for (const language of candidates) counts.set(language, (counts.get(language) ?? 0) + 1);
  const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    throw new ProviderError('Transcription detected conflicting source languages', {
      code: ErrorCode.PROVIDER_ERROR,
      retryable: true,
      recoveryScope: 'stage',
      details: { detections: ranked.map(([language, count]) => ({ language, count })) },
      recommendedAction: 'Select the source language explicitly, then retry transcription.',
    });
  }
  return ranked[0][0];
}

export function buildWindows(durationSeconds, windowSeconds, overlapSeconds) {
  if (!(durationSeconds > 0)) return [{ index: 0, start: 0, end: 0, duration: 0 }];
  const windows = [];
  const step = Math.max(1, windowSeconds - overlapSeconds);
  for (let start = 0; start < durationSeconds; start += step) {
    const end = Math.min(durationSeconds, start + windowSeconds);
    windows.push({ index: windows.length, start, end, duration: end - start });
    if (end >= durationSeconds) break;
  }
  return windows;
}

/**
 * Slices a WAV buffer to a time window and returns it base64-encoded. Slicing
 * here (rather than re-encoding with ffmpeg) avoids a subprocess per window.
 */
export function extractWindowAudio(wavBuffer, window) {
  let samples;
  try {
    const decoded = decodeWav(wavBuffer);
    const startFrame = Math.max(0, Math.round(window.start * decoded.sampleRate));
    const endFrame = Math.min(
      Math.floor(decoded.samples.length / decoded.channels),
      Math.round(window.end * decoded.sampleRate),
    );
    samples = decoded.samples.subarray(startFrame * decoded.channels, endFrame * decoded.channels);
    const buffer = encodeWav({
      samples: Int16Array.from(samples),
      sampleRate: decoded.sampleRate,
      channels: decoded.channels,
    });
    return { base64: buffer.toString('base64'), sampleRate: decoded.sampleRate, duration: window.duration };
  } catch (err) {
    throw new MediaError('Could not slice audio for transcription', {
      code: ErrorCode.CORRUPT_ARTIFACT,
      retryable: true,
      recoveryScope: 'stage',
      cause: err,
    });
  }
}

/**
 * Concatenates per-window words, discarding words that fall inside the overlap
 * of the following window so no phrase is transcribed twice.
 */
export function stitchWindows(parts) {
  const out = [];
  for (let i = 0; i < parts.length; i += 1) {
    const { window, words } = parts[i];
    const nextWindowStart = parts[i + 1]?.window?.start ?? Number.POSITIVE_INFINITY;
    for (const word of words) {
      const start = word.start + window.start;
      const end = word.end + window.start;
      // The overlap region belongs to the next window, which has more context.
      if (start >= nextWindowStart) continue;
      if (out.length && start < out[out.length - 1].end - 0.001) continue;
      out.push({ text: word.text, start: round(start, 3), end: round(end, 3), confidence: word.confidence ?? null });
    }
  }
  return out;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export { PipelineContext, segmentFingerprint, CancelledError };
