import fsp from 'node:fs/promises';
import path from 'node:path';
import { ValidationError, MediaError, ErrorCode } from '../core/errors.js';
import { safeFilename, extensionOf, ensureDir, statSafe } from '../core/fsutil.js';

/**
 * Validates and stores uploaded media inside a per-job directory. Two checks
 * matter for safety: the extension must be in the allow-list, and the file's
 * leading bytes must not contradict that extension (a renamed executable should
 * never reach ffmpeg).
 */

const MAGIC_SIGNATURES = [
  { ext: '.wav', check: (b) => b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE' },
  { ext: '.mp3', check: (b) => b.length >= 3 && (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) },
  { ext: '.flac', check: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'fLaC' },
  { ext: '.ogg', check: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { ext: '.opus', check: (b) => b.length >= 4 && b.toString('ascii', 0, 4) === 'OggS' },
  { ext: '.m4a', check: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
  { ext: '.aac', check: (b) => b.length >= 2 && b[0] === 0xff && (b[1] & 0xf0) === 0xf0 },
  { ext: '.mp4', check: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
  { ext: '.m4v', check: (b) => b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' },
  { ext: '.mov', check: (b) => b.length >= 12 && (b.toString('ascii', 4, 8) === 'ftyp' || b.toString('ascii', 4, 8) === 'moov') },
  { ext: '.webm', check: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
  { ext: '.mkv', check: (b) => b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 },
];

/** Reads the first bytes of a file and verifies them against its extension. */
export async function validateMediaSignature(file, extension) {
  const handle = await fsp.open(file, 'r');
  let head;
  try {
    head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const signature = MAGIC_SIGNATURES.find((s) => s.ext === extension);
  if (!signature) return { valid: true, checked: false };
  if (signature.check(head)) return { valid: true, checked: true };
  return { valid: false, checked: true, head: head.toString('hex') };
}

/**
 * Copies an upload into the job's input directory and validates it. Returns the
 * canonical stored path plus metadata. The stored name is derived from a
 * sanitized basename so traversal in the original filename is neutralized.
 */
export async function ingestUpload(config, jobId, uploadedFile, options = {}) {
  const originalName = uploadedFile?.originalname ?? uploadedFile?.name ?? 'upload.bin';
  const extension = extensionOf(originalName);
  const allowed = config.media.supportedInputExtensions;

  if (!allowed.includes(extension)) {
    throw new ValidationError(
      `Unsupported file type "${extension || 'unknown'}". Allowed: ${allowed.join(', ')}`,
      { details: { extension, allowed } },
    );
  }

  const sourcePath = uploadedFile.path;
  const stat = await statSafe(sourcePath);
  if (!stat || !stat.isFile()) {
    throw new ValidationError('Uploaded file is missing', { details: { originalName } });
  }
  if (stat.size === 0) {
    throw new ValidationError('Uploaded file is empty', { details: { originalName } });
  }
  if (stat.size > config.media.maxFileBytes) {
    throw new ValidationError(
      `Uploaded file exceeds the ${Math.round(config.media.maxFileBytes / 1024 / 1024)}MB limit`,
      { details: { sizeBytes: stat.size, limitBytes: config.media.maxFileBytes } },
    );
  }

  const signature = await validateMediaSignature(sourcePath, extension);
  if (!signature.valid) {
    throw new MediaError('File contents do not match its extension', {
      code: ErrorCode.VALIDATION,
      details: { extension, originalName },
      recommendedAction: 'Upload a file whose contents match its extension.',
    });
  }

  const inputDir = options.inputDir ?? path.join(config.artifactsDir, jobId, 'input');
  await ensureDir(inputDir);
  const storedName = safeFilename(originalName, `input${extension}`);
  const storedPath = path.join(inputDir, storedName);

  // A path check here is redundant with safeFilename, but keeps the invariant
  // explicit if the naming helper ever changes.
  if (path.dirname(path.resolve(storedPath)) !== path.resolve(inputDir)) {
    throw new ValidationError('Refusing to store an upload outside the job directory');
  }

  await fsp.copyFile(sourcePath, storedPath);
  await fsp.chmod(storedPath, 0o600);

  return {
    originalName,
    storedName,
    path: storedPath,
    extension,
    sizeBytes: stat.size,
    isVideo: config.media.videoExtensions.includes(extension),
    signatureChecked: signature.checked,
  };
}

/**
 * Enforces duration and size limits using the media engine's probe. Called once
 * per job before the pipeline starts so an oversized source fails fast.
 */
export async function enforceMediaLimits(config, engine, inputPath, probe) {
  const info = probe ?? (await engine.probe(inputPath));
  if (!info.hasAudio) {
    throw new MediaError('Source media contains no audio stream to dub', {
      code: ErrorCode.VALIDATION,
      retryable: false,
      recoveryScope: 'none',
      recommendedAction: 'Provide a source that contains speech audio.',
    });
  }
  if (info.durationSeconds > config.media.maxDurationSeconds) {
    throw new MediaError(
      `Source duration ${Math.round(info.durationSeconds)}s exceeds the limit of ${config.media.maxDurationSeconds}s`,
      { code: ErrorCode.VALIDATION, retryable: false, recoveryScope: 'none' },
    );
  }
  if (info.sizeBytes > config.media.maxFileBytes) {
    throw new MediaError('Source file exceeds the configured size limit', {
      code: ErrorCode.VALIDATION, retryable: false, recoveryScope: 'none',
    });
  }
  return info;
}

/** Deletes the staging directory used to receive an upload. */
export async function cleanupStaging(uploadedFile) {
  if (!uploadedFile?.path) return;
  await fsp.rm(uploadedFile.path, { force: true }).catch(() => {});
}

export { MAGIC_SIGNATURES };
