import fsp from 'node:fs/promises';
import path from 'node:path';
import { ensureDir, statSafe, resolveWithin, writeJsonAtomic } from './fsutil.js';
import { assertSafeId } from './ids.js';
import { ValidationError, MediaError, ErrorCode } from './errors.js';

/**
 * Owns everything written under a job's `artifacts/` directory. Centralizing it
 * means:
 *
 *  - every path is produced by `resolveWithin`, so no stage can write outside
 *    its job directory;
 *  - artifacts are written to a temp name then renamed, so a crash mid-write
 *    leaves the previous artifact intact instead of a corrupt one;
 *  - reuse decisions are made in one place, using content fingerprints.
 */
export class ArtifactStore {
  #config;
  #logger;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger ?? { debug() {}, warn() {} };
  }

  /**
   * Root of a job's artifact tree. Artifacts live inside the job directory (next
   * to `job.json`) so a job is a single self-contained folder that can be moved,
   * backed up, or deleted as one unit.
   */
  jobRoot(jobId) {
    assertSafeId(jobId, 'job id');
    return path.join(path.resolve(this.#config.jobsDir), jobId, 'artifacts');
  }

  /** Relative (portable) path for a stage artifact, e.g. `transcript/words.json`. */
  relativePath(...parts) {
    return parts.filter(Boolean).join('/');
  }

  /** Absolute path for a job artifact, guaranteed inside the job directory. */
  resolve(jobId, relative) {
    if (typeof relative !== 'string' || !relative.length) {
      throw new ValidationError('Artifact path is required');
    }
    if (path.isAbsolute(relative) || relative.includes('\u0000')) {
      throw new ValidationError('Artifact paths must be relative and free of null bytes');
    }
    return resolveWithin(this.jobRoot(jobId), relative);
  }

  async writeBuffer(jobId, relative, buffer) {
    const target = this.resolve(jobId, relative);
    await ensureDir(path.dirname(target));
    const tmp = `${target}.${process.pid}.${Date.now()}.part`;
    await fsp.writeFile(tmp, buffer, { mode: 0o600 });
    await fsp.rename(tmp, target);
    return { relative, sizeBytes: buffer.length };
  }

  async writeJson(jobId, relative, value) {
    const target = this.resolve(jobId, relative);
    await writeJsonAtomic(target, value);
    const stat = await statSafe(target);
    return { relative, sizeBytes: stat?.size ?? 0 };
  }

  async readJson(jobId, relative) {
    const target = this.resolve(jobId, relative);
    return JSON.parse(await fsp.readFile(target, 'utf8'));
  }

  async readBuffer(jobId, relative) {
    return fsp.readFile(this.resolve(jobId, relative));
  }

  async exists(jobId, relative) {
    const stat = await statSafe(this.resolve(jobId, relative));
    return Boolean(stat && stat.isFile() && stat.size > 0);
  }

  async size(jobId, relative) {
    const stat = await statSafe(this.resolve(jobId, relative));
    return stat?.size ?? 0;
  }

  /**
   * Verifies an artifact exists, is non-empty, and — for WAV files — has a
   * readable header. A zero-byte or truncated file is treated as corrupt so the
   * producing stage re-runs instead of the pipeline consuming garbage.
   */
  async verify(jobId, relative, { expectWav = false } = {}) {
    const target = this.resolve(jobId, relative);
    const stat = await statSafe(target);
    if (!stat || !stat.isFile()) {
      return { valid: false, reason: 'missing' };
    }
    if (stat.size === 0) {
      return { valid: false, reason: 'empty' };
    }
    if (expectWav) {
      try {
        const handle = await fsp.open(target, 'r');
        try {
          const head = Buffer.alloc(12);
          const { bytesRead } = await handle.read(head, 0, 12, 0);
          if (bytesRead < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
            return { valid: false, reason: 'not-a-wav' };
          }
        } finally {
          await handle.close();
        }
      } catch {
        return { valid: false, reason: 'unreadable' };
      }
    }
    return { valid: true, sizeBytes: stat.size };
  }

  /**
   * Decides whether an existing artifact can be reused. Reuse requires that the
   * file is valid *and* that the fingerprint of the inputs that produced it still
   * matches. `expectedFingerprint` of `null` means "any valid artifact is fine".
   */
  async canReuse(jobId, relative, { fingerprint = null, storedFingerprint = null, expectWav = false } = {}) {
    if (fingerprint !== null && storedFingerprint !== fingerprint) {
      this.#logger.debug?.('Artifact fingerprint changed; regenerating', { jobId, relative });
      return { reusable: false, reason: 'fingerprint-mismatch' };
    }
    const verification = await this.verify(jobId, relative, { expectWav });
    if (!verification.valid) {
      // A corrupt artifact is removed so the regenerating stage starts clean.
      await fsp.rm(this.resolve(jobId, relative), { force: true }).catch(() => {});
      return { reusable: false, reason: verification.reason };
    }
    return { reusable: true, sizeBytes: verification.sizeBytes };
  }

  /** Copies an uploaded/source file into the artifact tree. */
  async copyIn(jobId, sourcePath, relative) {
    const target = this.resolve(jobId, relative);
    await ensureDir(path.dirname(target));
    await fsp.copyFile(sourcePath, target);
    await fsp.chmod(target, 0o600);
    const stat = await statSafe(target);
    return { relative, sizeBytes: stat?.size ?? 0 };
  }

  /** Removes a single artifact, used to force regeneration after corruption. */
  async remove(jobId, relative) {
    await fsp.rm(this.resolve(jobId, relative), { force: true }).catch(() => {});
  }

  /** Lists artifact files under a prefix with sizes, for the job detail view. */
  async list(jobId, prefix = '') {
    const root = this.jobRoot(jobId);
    const out = [];
    async function walk(dir, rel) {
      let entries = [];
      try {
        entries = await fsp.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await walk(full, relPath);
        } else if (entry.isFile() && !entry.name.endsWith('.part')) {
          const stat = await statSafe(full);
          if (relPath.startsWith(prefix)) out.push({ relative: relPath, sizeBytes: stat?.size ?? 0 });
        }
      }
    }
    await walk(root, '');
    return out.sort((a, b) => a.relative.localeCompare(b.relative));
  }
}

export function artifactMediaError(relative, reason) {
  return new MediaError(`Artifact ${relative} is not usable (${reason})`, {
    code: ErrorCode.CORRUPT_ARTIFACT,
    retryable: true,
    recoveryScope: 'stage',
    recommendedAction: 'Retry the stage to regenerate the artifact.',
  });
}
