import { StageName, StageStatus, SegmentStatus } from '../core/job-model.js';
import { MediaError, ErrorCode, ValidationError } from '../core/errors.js';
import { contentHash } from '../core/ids.js';
import { statSafe } from '../core/fsutil.js';

/**
 * Renders the final video. Audio-only sources are promoted to a video artifact
 * so a single output type covers both cases; video sources keep their original
 * video stream by default and only re-encode when asked or when a mux fails.
 */
export const renderingStage = {
  name: StageName.RENDERING,

  async run(context) {
    return context.runStage(StageName.RENDERING, async (ctx) => {
      const job = ctx.job;
      const pipeline = ctx.config.pipeline;
      const log = ctx.stageLogger(StageName.RENDERING);

      if (!job.artifacts.dubbedAudio) {
        throw new ValidationError('No mixed audio is available to render', { retryable: true, recoveryScope: 'stage' });
      }
      const audioPath = ctx.artifacts.resolve(ctx.jobId, job.artifacts.dubbedAudio);
      const audioCheck = await ctx.artifacts.verify(ctx.jobId, job.artifacts.dubbedAudio, { expectWav: true });
      if (!audioCheck.valid) {
        throw new MediaError('Mixed audio is invalid and cannot be rendered', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
          details: { reason: audioCheck.reason },
        });
      }

      const container = pipeline.outputContainer;
      const relative = ctx.artifacts.relativePath('final', `dubbed.${container}`);
      const outputPath = ctx.artifacts.resolve(ctx.jobId, relative);
      const durationSeconds = job.source.durationSeconds ?? undefined;

      const hasVideo = job.source.hasVideo === true;
      const sourceRelative = hasVideo
        ? job.source.relativePath
        : (job.artifacts.vocals ?? job.artifacts.extractedAudio);

      const result = await ctx.engine.renderVideo(
        ctx.artifacts.resolve(ctx.jobId, sourceRelative),
        audioPath,
        outputPath,
        {
          container,
          durationSeconds,
          reencode: job.settings.reencodeVideo === true,
          copyVideo: hasVideo && job.settings.reencodeVideo !== true,
          signal: ctx.signal,
          stage: StageName.RENDERING,
        },
      );

      const stat = await statSafe(outputPath);
      if (!stat || stat.size === 0) {
        throw new MediaError('Render produced no output file', {
          code: ErrorCode.CORRUPT_ARTIFACT,
          retryable: true,
          recoveryScope: 'stage',
        });
      }

      job.artifacts.finalVideo = relative;
      const metadata = {
        container,
        sizeBytes: stat.size,
        durationSeconds: result.durationSeconds ?? durationSeconds ?? null,
        videoReencoded: result.videoReencoded ?? false,
        preservedSourceVideo: hasVideo && !result.videoReencoded,
        sourceHadVideo: hasVideo,
        fingerprint: contentHash(job.artifacts.dubbedAudio, stat.size, container),
      };
      log.info('Render complete', {
        container, sizeBytes: stat.size, videoReencoded: metadata.videoReencoded,
      });
      return { artifact: relative, metadata };
    });
  },
};

/**
 * Final validation. This is the gate that prevents a job from being reported as
 * completed when its output is unusable. It checks facts about the artifact and
 * about the job's own consistency, and it never repairs anything — it only
 * reports, so the failure is attributable to a specific stage.
 */
export const qualityStage = {
  name: StageName.QUALITY,

  async run(context) {
    return context.runStage(StageName.QUALITY, async (ctx) => {
      const job = ctx.job;
      const config = ctx.config.quality;
      const log = ctx.stageLogger(StageName.QUALITY);
      const checks = [];
      const push = (id, status, detail = {}) => checks.push({ id, status, ...detail });

      // 1. The final artifact must exist and be non-empty.
      if (!job.artifacts.finalVideo) {
        push('final_artifact_exists', 'fail', { message: 'No final artifact was recorded.' });
      } else {
        const stat = await statSafe(ctx.artifacts.resolve(ctx.jobId, job.artifacts.finalVideo));
        if (!stat || stat.size === 0) {
          push('final_artifact_exists', 'fail', { message: 'Final artifact is missing or empty.' });
        } else {
          push('final_artifact_exists', 'pass', { sizeBytes: stat.size });
        }
      }

      // 2. The final artifact must be readable by the media engine.
      let finalProbe = null;
      if (job.artifacts.finalVideo) {
        try {
          finalProbe = await ctx.engine.probe(ctx.artifacts.resolve(ctx.jobId, job.artifacts.finalVideo), {
            signal: ctx.signal,
          });
          push('final_artifact_readable', 'pass', { container: finalProbe.container });
        } catch (err) {
          push('final_artifact_readable', 'fail', { message: `Final artifact is unreadable: ${err.message}` });
        }
      }

      // 3. Required streams must be present.
      if (finalProbe) {
        const hasAudio = finalProbe.hasAudio && finalProbe.audioStreams > 0;
        if (hasAudio) {
          push('audio_stream_present', 'pass', { audioStreams: finalProbe.audioStreams, codec: finalProbe.audio?.codec ?? null });
        } else {
          push('audio_stream_present', 'fail', { message: 'Final artifact has no audio stream.' });
        }
        if (job.source.hasVideo) {
          if (finalProbe.hasVideo) {
            push('video_stream_present', 'pass', { videoStreams: finalProbe.videoStreams });
          } else {
            push('video_stream_present', 'fail', { message: 'Source had video but the output has none.' });
          }
        } else {
          push('video_stream_present', 'skip', { message: 'Source was audio-only.' });
        }

        // 4. Duration must be within the tolerated drift of the source.
        const sourceDuration = job.source.durationSeconds ?? 0;
        const finalDuration = finalProbe.durationSeconds ?? 0;
        const drift = Math.abs(finalDuration - sourceDuration);
        const tolerance = Math.max(config.minDurationDriftSeconds, sourceDuration * config.maxDurationDriftRatio);
        if (sourceDuration > 0 && drift <= tolerance) {
          push('duration_within_tolerance', 'pass', { driftSeconds: round(drift, 3), toleranceSeconds: round(tolerance, 3) });
        } else if (sourceDuration === 0) {
          push('duration_within_tolerance', 'warn', { message: 'Source duration is unknown.' });
        } else {
          push('duration_within_tolerance', 'fail', {
            message: `Output duration differs from the source by ${round(drift, 2)}s.`,
            driftSeconds: round(drift, 3),
            toleranceSeconds: round(tolerance, 3),
          });
        }
      }

      // 5. Every required stage must have succeeded.
      const stageProblems = [];
      for (const [name, stage] of Object.entries(job.stages)) {
        if (name === StageName.QUALITY) continue;
        if (stage.status === StageStatus.SUCCEEDED || stage.status === StageStatus.SKIPPED) continue;
        stageProblems.push({ stage: name, status: stage.status, error: stage.error?.message ?? null });
      }
      if (!stageProblems.length) {
        push('required_stages_succeeded', 'pass');
      } else if (config.requireAllStagesSucceeded) {
        push('required_stages_succeeded', 'fail', { message: 'Some stages did not succeed.', stages: stageProblems });
      } else {
        push('required_stages_succeeded', 'warn', { message: 'Some stages did not succeed.', stages: stageProblems });
      }

      // 6. Enough segments must have produced audio.
      const total = job.segments.length;
      const usable = job.segments.filter((s) => [SegmentStatus.MIXED, SegmentStatus.FITTED, SegmentStatus.SYNTHESIZED].includes(s.status)).length;
      const failed = job.segments.filter((s) => s.status === SegmentStatus.FAILED).length;
      const ratio = total > 0 ? usable / total : 0;
      if (total === 0) {
        push('segments_succeeded', 'fail', { message: 'The job contains no segments.' });
      } else if (ratio >= config.minSegmentSuccessRatio) {
        push('segments_succeeded', 'pass', { usable, total, ratio: round(ratio, 4), failedSegments: failed });
      } else {
        push('segments_succeeded', 'fail', {
          message: `Only ${usable} of ${total} segments produced usable audio.`,
          usable, total, failedSegments: failed, ratio: round(ratio, 4),
        });
      }

      // 7. A referenced artifact that is missing is always a failure.
      const missingArtifacts = [];
      for (const [key, relative] of Object.entries(job.artifacts)) {
        if (!relative) continue;
        const exists = await ctx.artifacts.exists(ctx.jobId, relative);
        if (!exists) missingArtifacts.push({ key, relative });
      }
      if (!missingArtifacts.length) {
        push('artifacts_intact', 'pass');
      } else {
        push('artifacts_intact', 'fail', { message: 'Some recorded artifacts are missing.', artifacts: missingArtifacts });
      }

      // 8. Job state must be internally consistent.
      const inconsistencies = [];
      if (job.status === 'running' && job.resume.nextStage !== null && job.resume.nextStage !== StageName.QUALITY) {
        inconsistencies.push(`resume cursor points at ${job.resume.nextStage}`);
      }
      if (job.artifacts.dubbedAudio && !job.artifacts.finalVideo) {
        inconsistencies.push('dubbed audio exists without a rendered video');
      }
      if (!inconsistencies.length) {
        push('job_state_consistent', 'pass');
      } else {
        push('job_state_consistent', 'fail', { message: 'Job state is inconsistent.', details: inconsistencies });
      }

      const failures = checks.filter((c) => c.status === 'fail');
      const warnings = checks.filter((c) => c.status === 'warn');
      const overall = failures.length ? 'fail' : (warnings.length ? 'warn' : 'pass');

      const segmentGrades = { ok: 0, warn: 0, fail: 0, unknown: 0 };
      for (const segment of job.segments) {
        const grade = segment.quality?.alignment?.grade ?? 'unknown';
        segmentGrades[grade] = (segmentGrades[grade] ?? 0) + 1;
      }

      job.quality = {
        overall,
        checkedAt: new Date().toISOString(),
        checks,
        failureCount: failures.length,
        warningCount: warnings.length,
        segmentGrades,
        summary: summarize(overall, failures, warnings),
      };

      if (failures.length) {
        ctx.metrics?.increment('dub_quality_failures_total', failures.length, { scope: 'job' });
      }

      log.info('Quality validation complete', { overall, failures: failures.length, warnings: warnings.length });
      return {
        artifact: null,
        metadata: {
          overall,
          failureCount: failures.length,
          warningCount: warnings.length,
          failedChecks: failures.map((f) => f.id),
        },
      };
    });
  },
};

function summarize(overall, failures, warnings) {
  if (overall === 'pass') return 'All quality checks passed.';
  if (overall === 'warn') {
    return `Quality checks passed with ${warnings.length} warning(s): ${warnings.map((w) => w.id).join(', ')}.`;
  }
  return `Quality validation failed ${failures.length} check(s): ${failures.map((f) => f.id).join(', ')}.`;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
