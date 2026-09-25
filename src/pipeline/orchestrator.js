import {
  JobStatus, StageName, StageStatus, SegmentStatus, PIPELINE_ORDER,
  assertTransition, isTerminal, computeResumePoint, recomputeSegmentSummary,
  createJobRecord, summarizeJob, publicSegmentView,
} from '../core/job-model.js';
import { PipelineContext } from './context.js';
import { CancelToken, isCancellation } from '../core/cancellation.js';
import { toAppError, AppError, ErrorCode, ConflictError, NotFoundError, RecoveryScope } from '../core/errors.js';
import { ingestStage, audioExtractStage, vocalSeparationStage } from './stages-media.js';
import { transcriptionStage, segmentationStage, translationStage } from './stages-ai.js';
import { ttsStage, alignmentStage, timingStage, mixingStage } from './stages-tts.js';
import { renderingStage, qualityStage } from './stages-output.js';
import { newJobId, newRequestId, contentHash } from '../core/ids.js';
import { safeFilename, ensureDir } from '../core/fsutil.js';
import { mapLimit } from '../core/concurrency.js';
import path from 'node:path';
import fsp from 'node:fs/promises';

const STAGES = {
  [StageName.INGEST]: ingestStage,
  [StageName.AUDIO_EXTRACT]: audioExtractStage,
  [StageName.VOCAL_SEPARATION]: vocalSeparationStage,
  [StageName.TRANSCRIPTION]: transcriptionStage,
  [StageName.SEGMENTATION]: segmentationStage,
  [StageName.TRANSLATION]: translationStage,
  [StageName.TTS]: ttsStage,
  [StageName.ALIGNMENT]: alignmentStage,
  [StageName.TIMING]: timingStage,
  [StageName.MIXING]: mixingStage,
  [StageName.RENDERING]: renderingStage,
  [StageName.QUALITY]: qualityStage,
};

/**
 * Owns job lifecycle. It is the only place that starts, resumes, cancels, and
 * retries runs, and it guarantees that at most one runner is active per job.
 *
 * Recovery model:
 *   - Every stage records its status and artifacts on the job before the next
 *     starts, so a crash leaves a resumable record rather than lost work.
 *   - Resume replays from the first stage that is not `succeeded`, reusing every
 *     artifact whose fingerprint still matches.
 *   - Cancel flips the job to `cancelling` and aborts the run's token, which
 *     tears down in-flight provider requests and media subprocesses.
 *   - Retry at segment level reopens only the failed segments' downstream stages.
 */
export class JobOrchestrator {
  #config;
  #store;
  #artifacts;
  #engine;
  #provider;
  #logger;
  #metrics;
  #telemetry;
  #services;
  #runners = new Map();
  #listeners = new Set();

  constructor({ config, store, artifacts, engine, provider, logger, metrics, telemetry, services }) {
    this.#config = config;
    this.#store = store;
    this.#artifacts = artifacts;
    this.#engine = engine;
    this.#provider = provider;
    this.#logger = logger;
    this.#metrics = metrics;
    this.#telemetry = telemetry;
    this.#services = services ?? {};
  }

  get providerName() { return this.#provider?.name ?? 'unknown'; }
  get engineName() { return this.#engine?.name ?? 'unknown'; }

  /** Subscribes to job-level progress events; used to push updates to the UI. */
  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (err) {
        this.#logger.warn('Job event listener threw', { error: err.message });
      }
    }
  }

  /**
   * Creates a job and stores its source. The source may arrive as a buffer (an
   * HTTP upload), as a path to a file outside the store (CLI), or already in
   * place inside the job directory (a caller that staged it itself).
   *
   * The file is always written through `ArtifactStore`, so it lands inside the
   * job's own directory with a sanitized name no matter how it arrived.
   */
  async createJob(options) {
    const jobId = options.jobId ?? newJobId();
    const sourceName = safeFilename(options.sourceName ?? 'source.bin');

    const jobDir = this.#store.jobDir(jobId);
    await ensureDir(jobDir);
    await ensureDir(path.join(jobDir, 'artifacts'));

    let relativePath = options.relativePath ?? this.#artifacts.relativePath('input', sourceName);

    if (options.sourceBuffer) {
      // Buffer upload: write it into the job directory ourselves.
      await this.#artifacts.writeBuffer(jobId, relativePath, options.sourceBuffer);
    } else if (options.sourcePath) {
      // A path outside the store: copy it in rather than referencing it, so the
      // job remains self-contained and cannot be affected by later edits.
      await this.#artifacts.copyIn(jobId, options.sourcePath, relativePath);
    }

    const absoluteSource = this.#artifacts.resolve(jobId, relativePath);
    const stat = await fsp.stat(absoluteSource).catch(() => null);
    if (!stat || !stat.isFile() || stat.size === 0) {
      throw new AppError('Source file was not found in the job directory', {
        code: ErrorCode.VALIDATION,
        status: 400,
        recoveryScope: RecoveryScope.NONE,
        recommendedAction: 'Provide the source media as sourceBuffer, sourcePath, or a staged relativePath.',
      });
    }

    const record = createJobRecord({
      jobId,
      sourceName,
      sourcePath: relativePath,
      sourceProbe: null,
      sourceLanguage: options.sourceLanguage,
      targetLanguage: options.targetLanguage,
      settings: options.settings ?? {},
      voices: options.voices ?? options.settings?.voices ?? [],
      origin: options.origin ?? 'studio',
    });
    record.providerInfo = { provider: this.providerName, engine: this.engineName, configuredAt: new Date().toISOString() };
    record.metrics.segmentsTotal = 0;
    await this.#store.create(record);

    this.#metrics?.increment('dub_jobs_created_total', 1, { origin: record.origin });
    this.#metrics?.increment('dub_jobs_created_total', 0, { origin: record.origin, status: 'created' });
    this.#logger.info('Job created', { jobId, origin: record.origin, target: options.targetLanguage });
    this.#emit({ type: 'job:created', jobId });
    return record;
  }

  /** True when a runner is currently executing this job. */
  isRunning(jobId) {
    return this.#runners.has(jobId);
  }

  /**
   * Starts or resumes a job. Returns immediately after registering the runner;
   * callers that need to wait can poll the job or subscribe to events.
   */
  async startJob(jobId, { resume = false } = {}) {
    if (this.#runners.has(jobId)) {
      throw new ConflictError(`Job ${jobId} is already running`);
    }
    const job = await this.#store.read(jobId, { fresh: true });

    if (job.status === JobStatus.COMPLETED && !resume) {
      throw new ConflictError(`Job ${jobId} is already completed`);
    }
    if (job.status === JobStatus.CANCELLING) {
      throw new ConflictError(`Job ${jobId} is still cancelling`);
    }
    if (![JobStatus.CREATED, JobStatus.CANCELLED, JobStatus.FAILED, JobStatus.COMPLETED].includes(job.status)) {
      throw new ConflictError(`Job ${jobId} cannot start from status ${job.status}`);
    }

    const token = new CancelToken();

    // Register before awaiting so a second start cannot slip through.
    const runner = this.#execute(jobId, token, { resume })
      .catch((err) => {
        this.#logger.error('Job runner crashed', { jobId, error: err?.message, code: err?.code });
      })
      .finally(() => {
        this.#runners.delete(jobId);
        this.#emit({ type: 'job:finished', jobId });
      });

    this.#runners.set(jobId, { token, runner });
    this.#metrics?.gauge('dub_active_jobs', this.#runners.size);
    return job;
  }

  /**
   * The main run loop. It walks the pipeline from the computed resume point,
   * stopping at the first stage that throws. Cancellation is checked between
   * stages as well as inside them.
   */
  async #execute(jobId, token, { resume }) {
    const job = await this.#store.read(jobId, { fresh: true });
    const previousStatus = job.status;
    const startStage = resume ? computeResumePoint(job) : null;
    const requestId = newRequestId();

    if (previousStatus === JobStatus.CANCELLED || previousStatus === JobStatus.FAILED) {
      this.#metrics?.increment('dub_jobs_resumed_total', 1, {});
      job.resume.resumeCount = (job.resume.resumeCount ?? 0) + 1;
    }
    job.cancellation = null;

    await this.#store.mutate(jobId, (record) => {
      assertTransition(record.status, JobStatus.RUNNING);
      record.status = JobStatus.RUNNING;
      record.startedAt = record.startedAt ?? new Date().toISOString();
      record.finishedAt = null;
      // A resumed process can have a different provider configuration (for
      // example, the key may have been removed and the deterministic offline
      // provider selected). Record the provider actually used by this run rather
      // than leaving the creation-time value stale in job status.
      record.providerInfo = {
        provider: this.providerName,
        engine: this.engineName,
        configuredAt: new Date().toISOString(),
      };
      if (startStage) {
        // Stages from the resume point onward are reopened so their state
        // reflects that they are about to run again.
        const from = PIPELINE_ORDER.indexOf(startStage);
        for (const name of PIPELINE_ORDER.slice(from)) {
          const stage = record.stages[name];
          if (stage.status === StageStatus.FAILED || stage.status === StageStatus.CANCELLED) {
            stage.status = StageStatus.PENDING;
            stage.error = null;
          }
        }
      }
    });

    const log = this.#logger.child({ jobId, requestId });
    const startedAt = Date.now();
    log.info('Job run started', {
      resume: Boolean(startStage),
      from: startStage ?? PIPELINE_ORDER[0],
      provider: this.providerName,
      engine: this.engineName,
    });

    const freshJob = await this.#store.read(jobId, { fresh: true });
    const context = new PipelineContext({
      config: this.#config,
      job: freshJob,
      store: this.#store,
      artifacts: this.#artifacts,
      engine: this.#engine,
      provider: this.#provider,
      logger: this.#logger,
      metrics: this.#metrics,
      telemetry: this.#telemetry,
      signal: token,
      services: this.#services,
    });

    const stagesToRun = startStage
      ? PIPELINE_ORDER.slice(PIPELINE_ORDER.indexOf(startStage))
      : PIPELINE_ORDER;

    try {
      for (const name of stagesToRun) {
        token.throwIfCancelled();

        // Stages are idempotent, but skip succeeded ones outright when resuming
        // so a resume never re-runs work whose artifacts are still valid.
        const stage = context.job.stages[name];
        if (startStage && stage?.status === StageStatus.SUCCEEDED) {
          log.debug('Skipping already-succeeded stage', { stage: name });
          continue;
        }

        this.#emit({ type: 'stage:started', jobId, stage: name });
        await STAGES[name].run(context);
        this.#emit({ type: 'stage:finished', jobId, stage: name, status: context.job.stages[name].status });
      }

      token.throwIfCancelled();

      // Quality is the gate: a failing check means the job is failed, not completed.
      const quality = context.job.quality;
      const qualityFailed = quality?.overall === 'fail';

      await this.#store.mutate(jobId, (record) => {
        record.metrics.totalDurationMs = Date.now() - startedAt;
        record.finishedAt = new Date().toISOString();
        if (qualityFailed) {
          assertTransition(record.status, JobStatus.FAILED);
          record.status = JobStatus.FAILED;
          record.resume.nextStage = StageName.QUALITY;
          record.failures.push({
            at: new Date().toISOString(),
            stage: StageName.QUALITY,
            segmentId: null,
            error: {
              code: ErrorCode.INTERNAL,
              message: quality.summary,
              retryable: true,
              recoveryScope: RecoveryScope.JOB,
              recommendedAction: 'Inspect the failed quality checks and retry the affected stage.',
            },
          });
        } else {
          assertTransition(record.status, JobStatus.COMPLETED);
          record.status = JobStatus.COMPLETED;
          record.resume.nextStage = null;
        }
      });

      if (qualityFailed) {
        this.#metrics?.increment('dub_jobs_failed_total', 1, { reason: 'quality' });
        log.warn('Job finished but failed quality validation', { summary: quality.summary });
      } else {
        this.#metrics?.increment('dub_jobs_completed_total', 1, {});
        log.info('Job completed', { durationMs: Date.now() - startedAt });
      }
    } catch (err) {
      const appErr = toAppError(err, { jobId });

      if (isCancellation(appErr)) {
        await this.#finishCancelled(jobId, log);
        return;
      }

      await this.#store.mutate(jobId, (record) => {
        record.status = JobStatus.FAILED;
        record.finishedAt = new Date().toISOString();
        record.metrics.totalDurationMs = Date.now() - startedAt;
        const pending = computeResumePoint(record);
        record.resume.nextStage = pending;
        record.failures.push({
          at: new Date().toISOString(),
          stage: appErr.stage,
          segmentId: appErr.segmentId,
          error: appErr.toJSON(),
        });
      });

      this.#metrics?.increment('dub_jobs_failed_total', 1, { reason: appErr.code });
      log.error('Job failed', { stage: appErr.stage, code: appErr.code, error: appErr.message });
    } finally {
      this.#metrics?.gauge('dub_active_jobs', Math.max(0, this.#runners.size - 1));
    }
  }

  async #finishCancelled(jobId, log) {
    await this.#store.mutate(jobId, (record) => {
      assertTransition(record.status, JobStatus.CANCELLED);
      record.status = JobStatus.CANCELLED;
      record.finishedAt = new Date().toISOString();
      record.cancellation = {
        ...(record.cancellation ?? {}),
        cancelledAt: new Date().toISOString(),
      };
      // Record where a resume would pick up so the UI can promise a real restart.
      record.resume.nextStage = computeResumePoint(record);
    });
    this.#metrics?.increment('dub_jobs_cancelled_total', 1, {});
    this.#metrics?.increment('dub_cancellations_total', 1, { scope: 'job' });
    log.info('Job cancelled');
  }

  /**
   * Requests cancellation. Returns immediately; the run transitions to
   * `cancelled` once in-flight work unwinds.
   */
  async cancelJob(jobId, reason = 'Cancelled by user') {
    const job = await this.#store.read(jobId, { fresh: true });
    if (isTerminal(job.status) && job.status !== JobStatus.FAILED) {
      throw new ConflictError(`Job ${jobId} is ${job.status} and cannot be cancelled`);
    }
    const active = this.#runners.get(jobId);

    await this.#store.mutate(jobId, (record) => {
      if (record.status === JobStatus.RUNNING) {
        assertTransition(record.status, JobStatus.CANCELLING);
        record.status = JobStatus.CANCELLING;
      }
      record.cancellation = {
        requestedAt: new Date().toISOString(),
        reason,
        stageAtRequest: record.resume.nextStage,
      };
    });

    if (active) {
      active.token.cancel(reason);
    } else {
      // A job marked running with no in-process runner is an interrupted run;
      // finalize it directly so the UI is not left with a stuck state.
      await this.#finishCancelled(jobId, this.#logger.child({ jobId }));
    }
    this.#logger.info('Cancellation requested', { jobId, hadRunner: Boolean(active) });
    this.#emit({ type: 'job:cancelling', jobId });
    return this.#store.read(jobId, { fresh: true });
  }

  /**
   * Retries a job from a chosen scope.
   *
   *   scope = 'job'     -> resume from the earliest unfinished stage
   *   scope = 'stage'   -> reopen the named stage and everything after it
   *   scope = 'segment' -> reopen only the given segments' stages
   */
  async retryJob(jobId, { scope = RecoveryScope.JOB, stage = null, segmentIds = null } = {}) {
    if (this.isRunning(jobId)) {
      throw new ConflictError(`Job ${jobId} is already running`);
    }
    const job = await this.#store.read(jobId, { fresh: true });

    if (scope === RecoveryScope.SEGMENT) {
      if (!Array.isArray(segmentIds) || !segmentIds.length) {
        throw new AppError('Segment retry requires at least one segment id', {
          code: ErrorCode.VALIDATION, status: 400,
        });
      }
      await this.#reopenSegments(jobId, segmentIds);
    } else if (scope === RecoveryScope.STAGE) {
      if (!stage || !PIPELINE_ORDER.includes(stage)) {
        throw new AppError(`Unknown stage "${stage}"`, { code: ErrorCode.VALIDATION, status: 400 });
      }
      await this.#reopenStage(jobId, stage);
    } else {
      // Job scope: clear terminal status so the run loop can pick it up.
      await this.#store.mutate(jobId, (record) => {
        const pending = computeResumePoint(record) ?? StageName.QUALITY;
        const from = PIPELINE_ORDER.indexOf(pending);
        for (const name of PIPELINE_ORDER.slice(from)) {
          const s = record.stages[name];
          if (s.status === StageStatus.FAILED || s.status === StageStatus.CANCELLED) {
            s.status = StageStatus.PENDING;
            s.error = null;
          }
        }
        record.resume.nextStage = pending;
      });
    }

    this.#metrics?.increment('dub_jobs_resumed_total', 1, { scope });
    await this.startJob(jobId, { resume: true });
    return this.#store.read(jobId, { fresh: true });
  }

  /**
   * Reopens a stage and every stage after it. Reopening only the named stage
   * would leave later stages claiming success against stale inputs.
   */
  async #reopenStage(jobId, stageName) {
    await this.#store.mutate(jobId, (record) => {
      const from = PIPELINE_ORDER.indexOf(stageName);
      if (from === -1) return;
      for (const name of PIPELINE_ORDER.slice(from)) {
        const s = record.stages[name];
        s.status = StageStatus.PENDING;
        s.error = null;
        s.finishedAt = null;
      }
      record.resume.nextStage = stageName;
      record.resume.lastCompletedStage = PIPELINE_ORDER[from - 1] ?? null;
      if (record.status === JobStatus.COMPLETED || record.status === JobStatus.FAILED || record.status === JobStatus.CANCELLED) {
        record.status = JobStatus.CREATED;
      }
    });
    this.#metrics?.increment('dub_stage_retries_total', 1, { stage: stageName });
  }

  /**
   * Reopens the downstream stages of specific segments. Segment artifacts are
   * cleared so the reuse check cannot serve the failed output again, and the
   * owning stages are reset just enough to re-run.
   */
  async #reopenSegments(jobId, segmentIds) {
    const targets = new Set(segmentIds);
    let reopened = 0;

    await this.#store.mutate(jobId, async (record) => {
      for (const segment of record.segments) {
        if (!targets.has(segment.segmentId)) continue;
        reopened += 1;
        segment.status = segment.translatedText ? SegmentStatus.TRANSLATED : SegmentStatus.PENDING;
        segment.error = null;
        segment.attempts += 1;
        segment.stages.tts = { status: StageStatus.PENDING, error: null, attempts: segment.stages.tts?.attempts ?? 0 };
        segment.stages.alignment = { status: StageStatus.PENDING, error: null, attempts: segment.stages.alignment?.attempts ?? 0 };
        segment.stages.timing = { status: StageStatus.PENDING, error: null, attempts: segment.stages.timing?.attempts ?? 0 };
        segment.stages.mixing = { status: StageStatus.PENDING, error: null, attempts: segment.stages.mixing?.attempts ?? 0 };
        // Dropping the fingerprint forces regeneration instead of reuse.
        delete segment.fingerprints.tts;
        segment.artifacts.fitted = null;
        segment.artifacts.aligned = null;
        segment.alignment = null;
        segment.timing = null;
      }

      // The stages that own segment work must run again, and so must the stages
      // that consume their output.
      for (const name of [StageName.TTS, StageName.ALIGNMENT, StageName.TIMING, StageName.MIXING, StageName.RENDERING, StageName.QUALITY]) {
        const s = record.stages[name];
        s.status = StageStatus.PENDING;
        s.error = null;
        s.finishedAt = null;
      }
      record.resume.nextStage = StageName.TTS;
      record.status = JobStatus.CREATED;
      record.failures = record.failures.filter(
        (f) => !(f.segmentId && targets.has(f.segmentId)),
      );
    });

    this.#metrics?.increment('dub_segment_retries_total', reopened, { stage: StageName.TTS });
    this.#logger.info('Segments reopened for retry', { jobId, count: reopened });
  }

  /**
   * Finalizes jobs that were left `running` by a crash. They are marked failed
   * with a resumable failure rather than silently resumed, so an operator decides
   * when to spend the compute.
   */
  async recoverInterruptedJobs() {
    const interrupted = await this.#store.findInterrupted();
    const recovered = [];
    for (const job of interrupted) {
      if (this.isRunning(job.jobId)) continue;
      await this.#store.mutate(job.jobId, (record) => {
        record.status = JobStatus.FAILED;
        record.cancellation = null;
        record.failures.push({
          at: new Date().toISOString(),
          stage: record.resume.nextStage,
          segmentId: null,
          error: {
            code: ErrorCode.INTERNAL,
            message: 'Job was interrupted by a server restart.',
            retryable: true,
            recoveryScope: RecoveryScope.JOB,
            recommendedAction: 'Resume the job to continue from the last completed stage.',
          },
        });
        record.resume.nextStage = computeResumePoint(record);
      });
      recovered.push(job.jobId);
    }
    if (recovered.length) {
      this.#logger.warn('Recovered interrupted jobs', { count: recovered.length, jobIds: recovered });
    }
    return recovered;
  }

  /** Waits for a running job to settle. Used by the CLI and tests. */
  async waitFor(jobId, { timeoutMs = 0 } = {}) {
    const active = this.#runners.get(jobId);
    if (!active) return this.#store.read(jobId, { fresh: true });
    if (timeoutMs > 0) {
      // The timer must be cleared when the job finishes first. Leaving it armed
      // keeps the event loop alive for the full timeout, which hangs any process
      // (CLI, server, test runner) that waits for a job to complete.
      let timer;
      try {
        await Promise.race([
          active.runner,
          new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    } else {
      await active.runner;
    }
    return this.#store.read(jobId, { fresh: true });
  }

  /** Job detail for the API, with optional segment paging. */
  async getJob(jobId, { includeSegments = true, limit = 100, offset = 0 } = {}) {
    const job = await this.#store.read(jobId, { fresh: true });
    const total = job.segments.length;
    const page = includeSegments
      ? { offset: Math.max(0, offset), limit: Math.max(1, Math.min(limit, 1000)), total }
      : null;
    return summarizeJob(job, { includeSegments, segmentPage: page });
  }

  /** Full segment list for transcript and timing inspection. */
  async getSegments(jobId, { offset = 0, limit = 200 } = {}) {
    const job = await this.#store.read(jobId, { fresh: true });
    recomputeSegmentSummary(job);
    const slice = job.segments.slice(offset, offset + limit);
    return {
      total: job.segments.length,
      offset,
      limit,
      summary: job.segmentSummary,
      segments: slice.map(publicSegmentView),
    };
  }

  async listJobs(options) {
    const { jobs, total } = await this.#store.list(options);
    return { total, jobs: jobs.map((j) => summarizeJob(j)) };
  }

  async deleteJob(jobId) {
    if (this.isRunning(jobId)) {
      throw new ConflictError(`Job ${jobId} is running and cannot be deleted`);
    }
    await this.#store.delete(jobId);
    this.#logger.info('Job deleted', { jobId });
    return true;
  }

  /** Shuts down cleanly: cancel active runs and wait for them to unwind. */
  async shutdown({ timeoutMs = 15000 } = {}) {
    const active = [...this.#runners.entries()];
    if (!active.length) return;
    this.#logger.info('Shutting down active jobs', { count: active.length });
    for (const [, runner] of active) runner.token.cancel('Server shutting down');
    await Promise.race([
      Promise.allSettled(active.map(([, r]) => r.runner)),
      new Promise((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  }

  async health() {
    const { jobs } = await this.#store.list({ limit: 1000 });
    const byStatus = {};
    for (const job of jobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
    return {
      activeRunners: this.#runners.size,
      totalJobs: jobs.length,
      jobsByStatus: byStatus,
      provider: this.providerName,
      engine: this.engineName,
      providerConfigured: this.#provider?.configured ?? false,
    };
  }

  /** Resolves a job artifact to an absolute path after validating containment. */
  async resolveArtifact(jobId, relative) {
    const job = await this.#store.read(jobId, { fresh: true });
    const known = Object.values(job.artifacts).filter(Boolean);
    const isStageArtifact = relative.startsWith('tts/') || relative.startsWith('fitted/')
      || relative.startsWith('audio/') || relative.startsWith('final/')
      || relative.startsWith('transcript/') || relative.startsWith('segments/');
    // Only artifacts the job actually produced are servable. This prevents a
    // crafted request from reading arbitrary files that happen to sit in the
    // job directory.
    if (!known.includes(relative) && !isStageArtifact) {
      throw new NotFoundError(`Artifact ${relative} is not part of job ${jobId}`);
    }
    const absolute = this.#artifacts.resolve(jobId, relative);
    const stat = await fsp.stat(absolute).catch(() => null);
    if (!stat || !stat.isFile()) {
      throw new NotFoundError(`Artifact ${relative} not found`);
    }
    return { path: absolute, sizeBytes: stat.size, job };
  }

  artifactFingerprint(...parts) {
    return contentHash(...parts);
  }
}

export { STAGES, RecoveryScope, mapLimit, SegmentStatus };
