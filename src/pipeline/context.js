import { StageStatus, SegmentStatus, recomputeSegmentSummary, markStageComplete } from '../core/job-model.js';
import { toAppError, RecoveryScope, ErrorCode } from '../core/errors.js';
import { CancelledError } from '../core/errors.js';
import { isCancellation } from '../core/cancellation.js';

/**
 * The shared state a stage runs against. Stages receive this and mutate the job
 * through `save()` so persistence stays in one place and every stage records the
 * same timing and error fields.
 */
export class PipelineContext {
  constructor({ config, job, store, artifacts, engine, provider, logger, metrics, telemetry, signal, services }) {
    this.config = config;
    this.job = job;
    this.store = store;
    this.artifacts = artifacts;
    this.engine = engine;
    this.provider = provider;
    this.logger = logger;
    this.metrics = metrics;
    this.telemetry = telemetry;
    this.signal = signal;
    this.services = services ?? {};
    this.stageName = null;
  }

  get jobId() { return this.job.jobId; }

  /** Logger bound to the current stage so every line is correlated. */
  stageLogger(stage) {
    const name = stage ?? this.stageName;
    return this.logger.child({ jobId: this.jobId, stage: name });
  }

  segmentLogger(stage, segmentId) {
    return this.logger.child({ jobId: this.jobId, stage, segmentId });
  }

  throwIfCancelled() {
    this.signal?.throwIfCancelled();
  }

  /**
   * Persists the job. Writes are queued through a promise chain because several
   * segment workers call this concurrently; without serialization a slower write
   * could land after a newer one and roll the record backwards.
   *
   * Before writing, ownership-sensitive fields are re-read from disk: the
   * orchestrator (and the cancel endpoint) can change `status`, `cancellation`,
   * and the lifecycle timestamps while a stage is mid-flight, and the stage must
   * not clobber those with its stale in-memory view.
   */
  async save() {
    recomputeSegmentSummary(this.job);
    this.#saveQueue = this.#saveQueue.then(
      () => this.#persist(),
      () => this.#persist(),
    );
    return this.#saveQueue;
  }

  /**
   * Persists under the job lock. Re-adopting the server-owned fields *inside* the
   * lock is what makes a concurrent cancel safe: without it a stage's stale
   * `running` snapshot could be written back over the `cancelling` status the
   * cancel endpoint just committed, leaving the job permanently stuck.
   */
  async #persist() {
    await this.store.withLock(this.jobId, async () => {
      await this.#adoptServerFields();
      await this.store.write(this.job);
    });
  }

  async #adoptServerFields() {
    let persisted = null;
    try {
      persisted = await this.store.read(this.jobId, { fresh: true });
    } catch {
      return; // A brand-new job may not be readable yet; the write below creates it.
    }
    if (!persisted || persisted === this.job) return;
    this.job.status = persisted.status;
    this.job.cancellation = persisted.cancellation;
    this.job.startedAt = persisted.startedAt ?? this.job.startedAt;
    this.job.finishedAt = persisted.finishedAt ?? this.job.finishedAt;
    this.job.resume.resumeCount = persisted.resume.resumeCount ?? this.job.resume.resumeCount;
  }

  #saveQueue = Promise.resolve();

  /**
   * Runs one stage with consistent bookkeeping: status transitions, timing,
   * metrics, failure recording, and stage history. `body` performs the work.
   */
  async runStage(name, body) {
    const previousStage = this.stageName;
    this.stageName = name;
    const job = this.job;
    const stage = job.stages[name];
    const attempt = stage.attempts + 1;
    stage.attempts = attempt;
    stage.status = StageStatus.RUNNING;
    stage.startedAt = new Date().toISOString();
    stage.error = null;
    stage.skipReason = null;

    const started = Date.now();
    const log = this.stageLogger(name);
    log.info('Stage started', { attempt });

    try {
      const result = await this.telemetry.span(`stage.${name}`, { jobId: this.jobId, stage: name, attempt }, async () => {
        this.throwIfCancelled();
        return body(this);
      });

      stage.durationMs = Date.now() - started;
      stage.finishedAt = new Date().toISOString();
      if (stage.status !== StageStatus.SKIPPED) stage.status = StageStatus.SUCCEEDED;
      stage.artifact = result?.artifact ?? stage.artifact;
      stage.metadata = result?.metadata ?? null;
      if (result?.skipReason) {
        stage.status = StageStatus.SKIPPED;
        stage.skipReason = result.skipReason;
      }

      markStageComplete(job, name);
      this.#pushHistory(name, stage.status, stage.durationMs, null);
      this.metrics?.observe('dub_stage_duration_ms', stage.durationMs, { stage: name, outcome: stage.status });
      log.info('Stage finished', { attempt, status: stage.status, durationMs: stage.durationMs });
      await this.save();
      return result;
    } catch (err) {
      const appErr = toAppError(err, { stage: name, jobId: this.jobId });
      stage.durationMs = Date.now() - started;
      stage.finishedAt = new Date().toISOString();

      if (isCancellation(appErr)) {
        stage.status = StageStatus.CANCELLED;
        stage.error = appErr.toJSON();
        this.#pushHistory(name, StageStatus.CANCELLED, stage.durationMs, appErr.toJSON());
        log.info('Stage cancelled', { durationMs: stage.durationMs });
        await this.save();
        throw appErr;
      }

      stage.status = StageStatus.FAILED;
      stage.error = appErr.toJSON();
      this.#pushHistory(name, StageStatus.FAILED, stage.durationMs, appErr.toJSON());
      this.metrics?.increment('dub_stage_failures_total', 1, { stage: name, code: appErr.code });
      if (appErr.code === ErrorCode.TIMEOUT) this.metrics?.increment('dub_timeouts_total', 1, { stage: name });
      log.error('Stage failed', { attempt, durationMs: stage.durationMs, code: appErr.code, error: appErr.message });
      await this.save();
      throw appErr;
    } finally {
      this.stageName = previousStage;
    }
  }

  #pushHistory(name, status, durationMs, error) {
    this.job.stageHistory.push({
      at: new Date().toISOString(),
      stage: name,
      status,
      durationMs,
      error,
    });
    if (this.job.stageHistory.length > 500) {
      this.job.stageHistory.splice(0, this.job.stageHistory.length - 500);
    }
  }
}

/**
 * Applies a segment-level failure to a segment record, keeping the first error
 * (the root cause) rather than the last one seen.
 */
export function recordSegmentFailure(context, segment, err, stage) {
  const appErr = toAppError(err, { stage, segmentId: segment.segmentId, jobId: context.jobId });
  if (isCancellation(appErr)) throw appErr;

  segment.status = SegmentStatus.FAILED;
  segment.error = appErr.toJSON();
  segment.lastAttemptAt = new Date().toISOString();
  segment.stages[stage] = {
    ...(segment.stages[stage] ?? {}),
    status: StageStatus.FAILED,
    error: appErr.toJSON(),
    attempts: (segment.stages[stage]?.attempts ?? 0) + 1,
  };
  context.metrics?.increment('dub_segment_failures_total', 1, { stage, code: appErr.code });
  context.job.failures.push({
    at: new Date().toISOString(),
    stage,
    segmentId: segment.segmentId,
    error: appErr.toJSON(),
  });
  if (context.job.failures.length > 200) {
    context.job.failures.splice(0, context.job.failures.length - 200);
  }
  return appErr;
}

export function clearSegmentFailure(segment, stage) {
  segment.error = null;
  segment.stages[stage] = {
    ...(segment.stages[stage] ?? {}),
    status: StageStatus.SUCCEEDED,
    error: null,
  };
  segment.lastAttemptAt = new Date().toISOString();
}

export { CancelledError, RecoveryScope };
