import { AUTO_DETECT_LANGUAGE } from './languages.js';

/**
 * Canonical job schema, state machine, and factory helpers. The job record is
 * the single source of truth for resumability: every stage writes its status and
 * artifact paths here, and a restart replays only what is not `succeeded`.
 *
 * Nothing secret is ever stored in a job. Source media lives beside the record
 * as files referenced by relative names; credentials live only in the server
 * environment.
 */

export const JobStatus = {
  CREATED: 'created',
  RUNNING: 'running',
  CANCELLING: 'cancelling',
  CANCELLED: 'cancelled',
  FAILED: 'failed',
  COMPLETED: 'completed',
};

export const StageName = {
  INGEST: 'ingest',
  AUDIO_EXTRACT: 'audio_extract',
  VOCAL_SEPARATION: 'vocal_separation',
  TRANSCRIPTION: 'transcription',
  SEGMENTATION: 'segmentation',
  TRANSLATION: 'translation',
  TTS: 'tts',
  ALIGNMENT: 'alignment',
  TIMING: 'timing',
  MIXING: 'mixing',
  RENDERING: 'rendering',
  QUALITY: 'quality',
};

/** Ordered pipeline. The orchestrator walks this list top to bottom. */
export const PIPELINE_ORDER = [
  StageName.INGEST,
  StageName.AUDIO_EXTRACT,
  StageName.VOCAL_SEPARATION,
  StageName.TRANSCRIPTION,
  StageName.SEGMENTATION,
  StageName.TRANSLATION,
  StageName.TTS,
  StageName.ALIGNMENT,
  StageName.TIMING,
  StageName.MIXING,
  StageName.RENDERING,
  StageName.QUALITY,
];

export const StageStatus = {
  PENDING: 'pending',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  CANCELLED: 'cancelled',
};

export const SegmentStatus = {
  PENDING: 'pending',
  TRANSLATING: 'translating',
  TRANSLATED: 'translated',
  SYNTHESIZING: 'synthesizing',
  SYNTHESIZED: 'synthesized',
  ALIGNED: 'aligned',
  FITTED: 'fitted',
  MIXED: 'mixed',
  FAILED: 'failed',
  SKIPPED: 'skipped',
};

/** Stages that fan out over segments and therefore participate in recovery. */
export const SEGMENT_STAGES = [
  StageName.TRANSLATION,
  StageName.TTS,
  StageName.ALIGNMENT,
  StageName.TIMING,
  StageName.MIXING,
];

const TERMINAL = new Set([JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED]);

/** Legal status transitions. Anything else is a programming error. */
const TRANSITIONS = {
  [JobStatus.CREATED]: [JobStatus.RUNNING, JobStatus.CANCELLED, JobStatus.FAILED],
  [JobStatus.RUNNING]: [JobStatus.CANCELLING, JobStatus.COMPLETED, JobStatus.FAILED],
  [JobStatus.CANCELLING]: [JobStatus.CANCELLED, JobStatus.FAILED],
  [JobStatus.CANCELLED]: [JobStatus.RUNNING],
  [JobStatus.FAILED]: [JobStatus.RUNNING],
  [JobStatus.COMPLETED]: [JobStatus.RUNNING],
};

export function canTransition(from, to) {
  if (from === to) return true;
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    const err = new Error(`Illegal job transition ${from} -> ${to}`);
    err.code = 'CONFLICT';
    err.status = 409;
    throw err;
  }
}

export function isTerminal(status) {
  return TERMINAL.has(status);
}

export function isResumable(status) {
  return [JobStatus.CANCELLED, JobStatus.FAILED, JobStatus.CREATED].includes(status);
}

export function createStageRecord(name, overrides = {}) {
  return {
    name,
    status: StageStatus.PENDING,
    attempts: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
    artifact: null,
    metadata: null,
    /** Set when a stage is skipped on purpose, with the reason. */
    skipReason: null,
    ...overrides,
  };
}

export function createSegmentRecord(index, timing, overrides = {}) {
  return {
    segmentId: `seg_${String(index).padStart(5, '0')}`,
    index,
    start: timing.start,
    end: timing.end,
    durationSeconds: timing.end - timing.start,
    sourceText: '',
    translatedText: '',
    status: SegmentStatus.PENDING,
    attempts: 0,
    /** Individual stage completion, so partial work survives a restart. */
    stages: {
      translation: { status: StageStatus.PENDING, error: null, attempts: 0 },
      tts: { status: StageStatus.PENDING, error: null, attempts: 0 },
      alignment: { status: StageStatus.PENDING, error: null, attempts: 0 },
      timing: { status: StageStatus.PENDING, error: null, attempts: 0 },
      mixing: { status: StageStatus.PENDING, error: null, attempts: 0 },
    },
    artifacts: {
      tts: null,
      aligned: null,
      fitted: null,
      mixed: null,
    },
    /** Content hashes keyed by stage, used to decide whether reuse is safe. */
    fingerprints: {},
    alignment: null,
    timing: null,
    quality: null,
    error: null,
    /** Voice assigned to this segment; stable across retries. */
    voice: null,
    lastAttemptAt: null,
    durationMs: null,
    ...overrides,
  };
}

export function createJobRecord(options) {
  const now = new Date().toISOString();
  const {
    jobId,
    sourceName,
    sourcePath,
    sourceProbe = null,
    sourceLanguage,
    targetLanguage,
    settings = {},
    voices = [],
    origin = 'studio',
  } = options;

  return {
    schemaVersion: 3,
    jobId,
    status: JobStatus.CREATED,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    origin,
    source: {
      originalName: sourceName,
      /** Relative to the job directory; never an absolute host path. */
      relativePath: sourcePath,
      sizeBytes: sourceProbe?.sizeBytes ?? null,
      durationSeconds: sourceProbe?.durationSeconds ?? null,
      hasVideo: sourceProbe?.hasVideo ?? null,
      probe: sourceProbe,
    },
    languages: {
      source: sourceLanguage,
      target: targetLanguage,
      // `source` remains the requested value (including `auto`) so the UI can
      // show what the user selected. For auto mode this is filled with the
      // provider's detected BCP-47 code during transcription.
      detectedSource: null,
    },
    settings: {
      autoDetectSourceLanguage: sourceLanguage === AUTO_DETECT_LANGUAGE,
      separateVocals: settings.separateVocals ?? false,
      ttsConcurrency: settings.ttsConcurrency ?? null,
      segmentConcurrency: settings.segmentConcurrency ?? null,
      voices: voices.length ? voices : (settings.voices ?? []),
      translationTone: settings.translationTone ?? 'neutral',
      keepSourceAudio: settings.keepSourceAudio ?? true,
      musicBedGainDb: settings.musicBedGainDb ?? null,
      reencodeVideo: settings.reencodeVideo ?? false,
      normalizeLoudness: settings.normalizeLoudness ?? null,
      targetLufs: settings.targetLufs ?? null,
    },
    stages: Object.fromEntries(PIPELINE_ORDER.map((name) => [name, createStageRecord(name)])),
    stageHistory: [],
    segments: [],
    segmentSummary: {
      total: 0,
      pending: 0,
      translated: 0,
      synthesized: 0,
      aligned: 0,
      fitted: 0,
      mixed: 0,
      failed: 0,
      skipped: 0,
    },
    failures: [],
    quality: null,
    resume: {
      lastCompletedStage: null,
      nextStage: PIPELINE_ORDER[0],
      resumeCount: 0,
    },
    cancellation: null,
    artifacts: {
      extractedAudio: null,
      vocals: null,
      accompaniment: null,
      transcript: null,
      translations: null,
      dubbedAudio: null,
      finalVideo: null,
    },
    providerInfo: null,
    metrics: {
      totalDurationMs: null,
      segmentsTotal: 0,
      segmentsReused: 0,
      providerCalls: 0,
      ttsAudioSeconds: 0,
    },
    logs: [],
  };
}

/** Recomputes the segment summary from the segment list. */
export function recomputeSegmentSummary(job) {
  const summary = {
    total: job.segments.length,
    pending: 0, translated: 0, synthesized: 0, aligned: 0,
    fitted: 0, mixed: 0, failed: 0, skipped: 0,
  };
  for (const segment of job.segments) {
    switch (segment.status) {
      case SegmentStatus.PENDING: summary.pending += 1; break;
      case SegmentStatus.TRANSLATING:
      case SegmentStatus.TRANSLATED: summary.translated += 1; break;
      case SegmentStatus.SYNTHESIZING:
      case SegmentStatus.SYNTHESIZED: summary.synthesized += 1; break;
      case SegmentStatus.ALIGNED: summary.aligned += 1; break;
      case SegmentStatus.FITTED: summary.fitted += 1; break;
      case SegmentStatus.MIXED: summary.mixed += 1; break;
      case SegmentStatus.FAILED: summary.failed += 1; break;
      case SegmentStatus.SKIPPED: summary.skipped += 1; break;
      default: break;
    }
  }
  job.segmentSummary = summary;
  return summary;
}

/** Records a structured failure and keeps the list bounded. */
export function recordFailure(job, failure, limit = 200) {
  job.failures.push({ at: new Date().toISOString(), ...failure });
  if (job.failures.length > limit) {
    job.failures.splice(0, job.failures.length - limit);
  }
  return job.failures;
}

/** Advances the pipeline cursor so a restart knows where to continue. */
export function markStageComplete(job, stageName) {
  job.resume.lastCompletedStage = stageName;
  const index = PIPELINE_ORDER.indexOf(stageName);
  job.resume.nextStage = PIPELINE_ORDER[index + 1] ?? null;
  return job.resume;
}

/**
 * Determines the stage a run should start from. Reuses the furthest fully
 * succeeded position so a resume never redoes completed work.
 */
export function computeResumePoint(job) {
  for (const name of PIPELINE_ORDER) {
    const stage = job.stages[name];
    if (!stage || stage.status !== StageStatus.SUCCEEDED) return name;
  }
  return null; // everything succeeded
}

export function summarizeJob(job, { includeSegments = false, segmentPage } = {}) {
  const base = {
    schemaVersion: job.schemaVersion,
    jobId: job.jobId,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    origin: job.origin,
    source: {
      originalName: job.source.originalName,
      durationSeconds: job.source.durationSeconds,
      sizeBytes: job.source.sizeBytes,
      hasVideo: job.source.hasVideo,
    },
    languages: job.languages,
    settings: job.settings,
    stages: Object.fromEntries(
      Object.entries(job.stages).map(([name, stage]) => [name, {
        name: stage.name,
        status: stage.status,
        attempts: stage.attempts,
        startedAt: stage.startedAt,
        finishedAt: stage.finishedAt,
        durationMs: stage.durationMs,
        error: stage.error,
        skipReason: stage.skipReason,
        metadata: stage.metadata,
      }]),
    ),
    stageHistory: job.stageHistory.slice(-50),
    segmentSummary: job.segmentSummary,
    failures: job.failures.slice(-50),
    quality: job.quality,
    resume: job.resume,
    cancellation: job.cancellation,
    // Artifact paths are exposed as-is rather than as booleans: they are
    // relative, job-scoped, server-generated strings, and the client needs them
    // to build artifact URLs. They are re-validated on every read, so knowing a
    // path grants no access that authorization would otherwise deny.
    artifacts: { ...job.artifacts },
    providerInfo: job.providerInfo,
    metrics: job.metrics,
  };

  if (includeSegments) {
    const segments = segmentPage
      ? job.segments.slice(segmentPage.offset, segmentPage.offset + segmentPage.limit)
      : job.segments;
    base.segments = segments.map(publicSegmentView);
    base.segmentPage = segmentPage
      ? { ...segmentPage, total: job.segments.length }
      : { offset: 0, limit: job.segments.length, total: job.segments.length };
  }
  return base;
}

/** Strips absolute paths from a segment before it leaves the server. */
export function publicSegmentView(segment) {
  return {
    segmentId: segment.segmentId,
    index: segment.index,
    start: segment.start,
    end: segment.end,
    durationSeconds: segment.durationSeconds,
    sourceText: segment.sourceText,
    translatedText: segment.translatedText,
    status: segment.status,
    attempts: segment.attempts,
    stages: segment.stages,
    alignment: segment.alignment,
    timing: segment.timing,
    quality: segment.quality,
    error: segment.error,
    voice: segment.voice,
    hasTtsAudio: Boolean(segment.artifacts?.tts),
    hasAlignedAudio: Boolean(segment.artifacts?.aligned),
    hasMixedAudio: Boolean(segment.artifacts?.mixed),
    lastAttemptAt: segment.lastAttemptAt,
    durationMs: segment.durationMs,
  };
}
