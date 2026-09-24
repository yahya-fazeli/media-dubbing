import express from 'express';
import multer from 'multer';
import path from 'node:path';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import { SUPPORTED_LANGUAGES } from '../config.js';
import { ValidationError, NotFoundError } from '../core/errors.js';
import { ingestUpload, cleanupStaging } from '../media/ingest.js';
import { safeFilename, extensionOf } from '../core/fsutil.js';
import { assertSafeId } from '../core/ids.js';

/**
 * REST surface for the Studio and CLI.
 *
 * Security posture:
 *  - the whole router is behind bearer auth (see middleware);
 *  - uploads are written to a staging directory with a random name, then moved
 *    into the job directory only after their contents are validated;
 *  - artifact reads go through a resolver that proves the artifact belongs to
 *    the named job before streaming;
 *  - no endpoint ever returns an absolute host path or a credential.
 */
export function createApiRouter(app, { uploadDir }) {
  const router = express.Router();
  const { orchestrator, config, logger, metrics } = app;

  const upload = multer({
    dest: uploadDir,
    limits: { fileSize: config.server.maxUploadBytes, files: 1 },
  });

  router.use(express.json({ limit: config.server.bodyLimit }));

  // --- Metadata ------------------------------------------------------------

  router.get('/health', async (req, res, next) => {
    try {
      const health = await orchestrator.health();
      res.json({
        status: 'ok',
        uptimeSeconds: Math.round(process.uptime()),
        ...health,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/meta', (req, res) => {
    res.json({
      name: 'youtube-dub',
      version: '3.0.0',
      languages: SUPPORTED_LANGUAGES,
      limits: {
        maxUploadBytes: config.server.maxUploadBytes,
        maxDurationSeconds: config.media.maxDurationSeconds,
        maxFileBytes: config.media.maxFileBytes,
      },
      supportedExtensions: config.media.supportedInputExtensions,
      videoExtensions: config.media.videoExtensions,
      pipeline: {
        order: [
          'ingest', 'audio_extract', 'vocal_separation', 'transcription', 'segmentation',
          'translation', 'tts', 'alignment', 'timing', 'mixing', 'rendering', 'quality',
        ],
        ttsConcurrency: config.pipeline.ttsConcurrency,
        segmentConcurrency: config.pipeline.segmentConcurrency,
      },
      engine: { kind: app.engineKind, reason: app.engineReason },
      provider: {
        kind: app.providerKind,
        reason: app.providerReason,
        configured: app.provider?.configured ?? false,
      },
      authRequired: Boolean(config.server.apiToken),
    });
  });

  router.get('/metrics', (req, res) => {
    res.json(metrics.snapshot());
  });

  router.get('/metrics/prometheus', (req, res) => {
    res.type('text/plain').send(metrics.toPrometheus());
  });

  // --- Jobs ----------------------------------------------------------------

  router.get('/jobs', async (req, res, next) => {
    try {
      const limit = clampInt(req.query.limit, 1, 200, 50);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const status = typeof req.query.status === 'string' ? req.query.status : undefined;
      const result = await orchestrator.listJobs({ limit, offset, status, sort: 'desc' });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  /**
   * Creates a job from an upload. Two-step on purpose: the source is staged,
   * validated, then copied into the job directory, so a rejected upload never
   * leaves a half-formed job behind.
   */
  router.post('/jobs', upload.single('file'), async (req, res, next) => {
    let uploaded = req.file;
    try {
      if (!uploaded) {
        throw new ValidationError('A file field named "file" is required');
      }

      const body = req.body ?? {};
      const sourceLanguage = requireLanguage(body.sourceLanguage, 'sourceLanguage');
      const targetLanguage = requireLanguage(body.targetLanguage, 'targetLanguage');
      if (sourceLanguage === targetLanguage) {
        throw new ValidationError('Source and target language must differ');
      }

      const settings = parseSettings(body);

      // Validate extension, size, and magic bytes before creating any job state.
      const staged = await stageUpload(config, uploaded);
      uploaded = { ...uploaded, path: staged.path, originalname: staged.originalName };

      const job = await orchestrator.createJob({
        sourceName: staged.storedName,
        sourceBuffer: await fsp.readFile(staged.path),
        sourceLanguage,
        targetLanguage,
        settings,
        voices: settings.voices,
        origin: req.auth?.authenticated ? 'studio' : 'studio-anonymous',
      });

      res.status(201).json({ job: await orchestrator.getJob(job.jobId, { includeSegments: false }) });

      if (body.autoStart === 'true' || body.autoStart === true) {
        orchestrator.startJob(job.jobId).catch((err) => {
          logger.error('Auto-start failed', { jobId: job.jobId, error: err.message });
        });
      }
    } catch (err) {
      next(err);
    } finally {
      if (uploaded?.path) await cleanupStaging(uploaded);
    }
  });

  /** Creates a job that references media already on the server (CLI / ingest). */
  router.post('/jobs/from-path', async (req, res, next) => {
    try {
      const body = req.body ?? {};
      const sourcePath = body.sourcePath;
      if (typeof sourcePath !== 'string' || !sourcePath.length) {
        throw new ValidationError('sourcePath is required');
      }
      // The path is supplied by an operator through an authenticated API, but it
      // is still only ever copied into the job directory, never executed or
      // served back from its original location.
      const stat = await fsp.stat(sourcePath).catch(() => null);
      if (!stat?.isFile()) throw new ValidationError('sourcePath does not point to a readable file');

      const sourceLanguage = requireLanguage(body.sourceLanguage, 'sourceLanguage');
      const targetLanguage = requireLanguage(body.targetLanguage, 'targetLanguage');
      const settings = parseSettings(body);

      const job = await orchestrator.createJob({
        sourceName: safeFilename(path.basename(sourcePath), 'source.bin'),
        sourcePath,
        sourceLanguage,
        targetLanguage,
        settings,
        voices: settings.voices,
        origin: 'cli',
      });
      res.status(201).json({ job: await orchestrator.getJob(job.jobId, { includeSegments: false }) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const includeSegments = req.query.segments !== 'false';
      const limit = clampInt(req.query.limit, 1, 1000, config.limits.defaultSegmentPageSize);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const job = await orchestrator.getJob(jobId, { includeSegments, limit, offset });
      res.json({
        job,
        running: orchestrator.isRunning(jobId),
        logs: await readRecentLogs(config, jobId, 100),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId/segments', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const limit = clampInt(req.query.limit, 1, 1000, 200);
      const offset = clampInt(req.query.offset, 0, 1_000_000, 0);
      const status = typeof req.query.status === 'string' ? req.query.status : null;
      const result = await orchestrator.getSegments(jobId, { offset: 0, limit: 100000 });
      let segments = result.segments;
      if (status) segments = segments.filter((s) => s.status === status);
      const total = segments.length;
      res.json({
        total,
        offset,
        limit,
        summary: result.summary,
        segments: segments.slice(offset, offset + limit),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId/transcript', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const job = await app.store.read(jobId, { fresh: true });
      if (!job.artifacts.transcript) {
        throw new NotFoundError('This job has no transcript yet');
      }
      const transcript = await app.artifacts.readJson(jobId, job.artifacts.transcript);
      res.json({
        transcript: {
          language: transcript.language,
          durationSeconds: transcript.durationSeconds,
          text: transcript.text,
          provider: transcript.provider,
          wordCount: transcript.words?.length ?? 0,
        },
        words: transcript.words ?? [],
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId/translations', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const job = await app.store.read(jobId, { fresh: true });
      if (!job.artifacts.translations) {
        throw new NotFoundError('This job has no translations yet');
      }
      res.json(await app.artifacts.readJson(jobId, job.artifacts.translations));
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId/failures', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const job = await app.store.read(jobId, { fresh: true });
      res.json({
        failures: job.failures.slice(-200).reverse(),
        stageErrors: Object.fromEntries(
          Object.entries(job.stages)
            .filter(([, s]) => s.error)
            .map(([name, s]) => [name, s.error]),
        ),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs/:jobId/artifacts', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const files = await app.artifacts.list(jobId);
      res.json({
        artifacts: Object.fromEntries(
          Object.entries((await app.store.read(jobId)).artifacts).map(([k, v]) => [k, v]),
        ),
        files,
      });
    } catch (err) {
      next(err);
    }
  });

  // --- Lifecycle -----------------------------------------------------------

  router.post('/jobs/:jobId/start', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      await orchestrator.startJob(jobId);
      res.status(202).json({ job: await orchestrator.getJob(jobId, { includeSegments: false }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:jobId/resume', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      await orchestrator.retryJob(jobId, { scope: 'job' });
      res.status(202).json({ job: await orchestrator.getJob(jobId, { includeSegments: false }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:jobId/cancel', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const reason = typeof req.body?.reason === 'string' ? req.body.reason : 'Cancelled from the Studio';
      const job = await orchestrator.cancelJob(jobId, reason);
      res.status(202).json({ job: await orchestrator.getJob(job.jobId, { includeSegments: false }) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:jobId/retry', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      const { scope = 'job', stage = null, segmentIds = null } = req.body ?? {};
      if (!['job', 'stage', 'segment'].includes(scope)) {
        throw new ValidationError('scope must be one of: job, stage, segment');
      }
      const job = await orchestrator.retryJob(jobId, { scope, stage, segmentIds });
      res.status(202).json({ job: await orchestrator.getJob(job.jobId, { includeSegments: false }) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/jobs/:jobId', async (req, res, next) => {
    try {
      const { jobId } = req.params;
      assertSafeId(jobId, 'job id');
      await orchestrator.deleteJob(jobId);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // --- Artifacts -----------------------------------------------------------

  /**
   * Streams an artifact. `jobId` and the artifact path are both validated, and
   * the resolver confirms the artifact belongs to that job. Range requests are
   * supported so the browser can seek in the final video.
   *
   * In Express 4 a bare `*` wildcard captures into `req.params[0]`, not a named
   * parameter, so the path is read from there.
   */
  router.get('/jobs/:jobId/artifacts/*', async (req, res, next) => {
    try {
      const jobId = req.params.jobId;
      assertSafeId(jobId, 'job id');
      const captured = req.params[0];
      const artifactPath = Array.isArray(captured) ? captured.join('/') : captured;
      if (!artifactPath || artifactPath.includes('\u0000')) {
        throw new ValidationError('Invalid artifact path');
      }

      const { path: absolute, sizeBytes } = await orchestrator.resolveArtifact(jobId, artifactPath);
      const contentType = contentTypeFor(artifactPath);
      const download = req.query.download === 'true';

      res.setHeader('Content-Type', contentType);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Cache-Control', 'private, max-age=60');
      if (download) {
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(path.basename(artifactPath))}"`);
      }

      const range = req.headers.range;
      if (range) {
        const parsed = parseRange(range, sizeBytes);
        if (!parsed) {
          res.status(416).setHeader('Content-Range', `bytes */${sizeBytes}`).end();
          return;
        }
        res.status(206);
        res.setHeader('Content-Range', `bytes ${parsed.start}-${parsed.end}/${sizeBytes}`);
        res.setHeader('Content-Length', String(parsed.end - parsed.start + 1));
        const stream = fs.createReadStream(absolute, { start: parsed.start, end: parsed.end });
        stream.on('error', next);
        stream.pipe(res);
        return;
      }

      res.setHeader('Content-Length', String(sizeBytes));
      const stream = fs.createReadStream(absolute);
      stream.on('error', next);
      stream.pipe(res);
    } catch (err) {
      next(err);
    }
  });

  return router;
}

/** Validates an upload and copies it into a staging file with a safe name. */
async function stageUpload(config, uploaded) {
  const extension = extensionOf(uploaded.originalname);
  if (!config.media.supportedInputExtensions.includes(extension)) {
    throw new ValidationError(
      `Unsupported file type "${extension || 'unknown'}"`,
      { details: { allowed: config.media.supportedInputExtensions } },
    );
  }
  const stat = await fsp.stat(uploaded.path);
  if (stat.size === 0) throw new ValidationError('Uploaded file is empty');
  if (stat.size > config.media.maxFileBytes) {
    throw new ValidationError('Uploaded file exceeds the configured media size limit');
  }
  const { validateMediaSignature } = await import('../media/ingest.js');
  const signature = await validateMediaSignature(uploaded.path, extension);
  if (!signature.valid) {
    throw new ValidationError('File contents do not match its extension', {
      details: { extension },
    });
  }
  return {
    path: uploaded.path,
    originalName: uploaded.originalname,
    storedName: safeFilename(uploaded.originalname, `source${extension}`),
    extension,
  };
}

function requireLanguage(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ValidationError(`${label} is required`);
  }
  const code = value.trim();
  if (!/^[a-z]{2}(-[A-Za-z]{2,4})?$/.test(code)) {
    throw new ValidationError(`${label} must be a BCP-47 style code such as "en" or "pt-BR"`);
  }
  return code;
}

function parseSettings(body) {
  const toBool = (v) => v === true || v === 'true';
  const voices = typeof body.voices === 'string' && body.voices.trim()
    ? body.voices.split(',').map((v) => v.trim()).filter(Boolean)
    : [];
  return {
    separateVocals: toBool(body.separateVocals),
    keepSourceAudio: body.keepSourceAudio === undefined ? true : toBool(body.keepSourceAudio),
    reencodeVideo: toBool(body.reencodeVideo),
    translationTone: typeof body.translationTone === 'string' && body.translationTone.trim()
      ? body.translationTone.trim()
      : 'neutral',
    voices,
    ttsConcurrency: clampInt(body.ttsConcurrency, 1, 32, undefined),
    musicBedGainDb: body.musicBedGainDb === undefined || body.musicBedGainDb === ''
      ? null
      : clampNumber(body.musicBedGainDb, -60, 20, null),
  };
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function contentTypeFor(relative) {
  const ext = extensionOf(relative);
  switch (ext) {
    case '.mp4': case '.m4v': return 'video/mp4';
    case '.webm': return 'video/webm';
    case '.mkv': return 'video/x-matroska';
    case '.mov': return 'video/quicktime';
    case '.wav': return 'audio/wav';
    case '.mp3': return 'audio/mpeg';
    case '.m4a': return 'audio/mp4';
    case '.ogg': case '.opus': return 'audio/ogg';
    case '.json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/** Parses a single-range Range header; returns null when unsatisfiable. */
function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return null;
  const [, startRaw, endRaw] = match;
  let start;
  let end;
  if (startRaw === '' && endRaw === '') return null;
  if (startRaw === '') {
    const suffix = Number.parseInt(endRaw, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(startRaw, 10);
    end = endRaw === '' ? size - 1 : Number.parseInt(endRaw, 10);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** Reads the tail of a job's log file for the failure/detail views. */
async function readRecentLogs(config, jobId, limit) {
  try {
    const file = path.join(config.logsDir, `${jobId}.ndjson`);
    const raw = await fsp.readFile(file, 'utf8');
    const lines = raw.trim().split('\n').filter(Boolean);
    return lines.slice(-limit).map((line) => {
      try { return JSON.parse(line); } catch { return { msg: line }; }
    });
  } catch {
    return [];
  }
}
