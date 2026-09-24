import fsp from 'node:fs/promises';
import path from 'node:path';
import { NotFoundError, ConflictError, ValidationError } from './errors.js';
import {
  writeJsonAtomic, readJson, ensureDir, resolveWithin, pathExists, statSafe, removeQuietly,
} from './fsutil.js';
import { assertSafeId } from './ids.js';

/**
 * Durable job storage. Each job is a directory containing `job.json` plus an
 * `artifacts/` subtree. Writes go through `writeJsonAtomic` so an interrupted
 * process can never leave a half-written record.
 *
 * The store is the only component that knows how to turn a job id into a path,
 * and every path is resolved through `resolveWithin`, so an id arriving from the
 * network cannot escape the data directory.
 */
export class JobStore {
  #cache = new Map();
  #locks = new Map();
  #config;
  #logger;

  constructor(config, logger) {
    this.#config = config;
    this.#logger = logger ?? { debug() {}, warn() {}, error() {} };
  }

  get config() { return this.#config; }

  jobDir(jobId) {
    assertSafeId(jobId, 'job id');
    return resolveWithin(this.#config.jobsDir, jobId);
  }

  jobFile(jobId) {
    return resolveWithin(this.jobDir(jobId), 'job.json');
  }

  artifactsDir(jobId) {
    return resolveWithin(this.jobDir(jobId), 'artifacts');
  }

  /**
   * Resolves a path inside a job's directory. `relative` may nest (for example
   * `stage/tts/seg_00001.wav`) but may never escape the job root.
   */
  artifactPath(jobId, ...relative) {
    return resolveWithin(this.artifactsDir(jobId), ...relative);
  }

  async create(record) {
    const dir = this.jobDir(record.jobId);
    await ensureDir(dir);
    await ensureDir(path.join(dir, 'artifacts'));
    await this.write(record);
    return record;
  }

  async write(record) {
    record.updatedAt = new Date().toISOString();
    await writeJsonAtomic(this.jobFile(record.jobId), record);
    this.#cache.set(record.jobId, record);
    return record;
  }

  async read(jobId, { fresh = false } = {}) {
    if (!fresh && this.#cache.has(jobId)) return this.#cache.get(jobId);
    const file = this.jobFile(jobId);
    let raw;
    try {
      raw = await readJson(file);
    } catch (err) {
      if (err.code === 'ENOENT') throw new NotFoundError(`Job ${jobId} not found`);
      throw err;
    }
    const record = migrate(raw);
    this.#cache.set(jobId, record);
    return record;
  }

  async exists(jobId) {
    try {
      assertSafeId(jobId, 'job id');
    } catch {
      return false;
    }
    return pathExists(this.jobFile(jobId));
  }

  /**
   * Serializes all mutations of a single job. Concurrent HTTP requests and the
   * pipeline worker can both touch a job, so every read-modify-write goes through
   * this lock.
   */
  async withLock(jobId, fn) {
    const previous = this.#locks.get(jobId) ?? Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    this.#locks.set(jobId, previous.then(() => gate));
    await previous.catch(() => {});
    try {
      return await fn();
    } finally {
      release();
      if (this.#locks.get(jobId) === gate) this.#locks.delete(jobId);
    }
  }

  /** Reads, mutates, and persists a job atomically with respect to other writers. */
  async mutate(jobId, mutator, { fresh = false } = {}) {
    return this.withLock(jobId, async () => {
      const job = await this.read(jobId, { fresh });
      const result = await mutator(job);
      await this.write(job);
      return result === undefined ? job : result;
    });
  }

  async list({ status, limit = 100, offset = 0, sort = 'desc' } = {}) {
    let entries = [];
    try {
      entries = await fsp.readdir(this.#config.jobsDir, { withFileTypes: true });
    } catch {
      return { jobs: [], total: 0 };
    }

    const records = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      // Skip directories whose names are not valid ids rather than reading them.
      const stat = await statSafe(this.jobFile(entry.name));
      if (!stat) continue;
      try {
        const record = await this.read(entry.name);
        records.push(record);
      } catch (err) {
        this.#logger.warn('Skipping unreadable job record', { jobId: entry.name, error: err.message });
      }
    }

    const filtered = status
      ? records.filter((r) => r.status === status)
      : records;
    const sorted = filtered.sort((a, b) => {
      const cmp = String(a.createdAt).localeCompare(String(b.createdAt));
      return sort === 'asc' ? cmp : -cmp;
    });

    return {
      total: sorted.length,
      jobs: sorted.slice(offset, offset + limit),
    };
  }

  /**
   * Deletes a job directory. Callers must confirm the job is not running; the
   * store refuses to delete an active job so a stray request cannot destroy work
   * in progress.
   */
  async delete(jobId, { force = false } = {}) {
    const job = await this.read(jobId).catch(() => null);
    if (job && ['running', 'cancelling'].includes(job.status) && !force) {
      throw new ConflictError(`Job ${jobId} is ${job.status} and cannot be deleted`);
    }
    await removeQuietly(this.jobDir(jobId));
    this.#cache.delete(jobId);
    return true;
  }

  /** Drops in-memory state so the next read comes from disk. */
  invalidate(jobId) {
    if (jobId) this.#cache.delete(jobId);
    else this.#cache.clear();
  }

  /**
   * Finds jobs that were mid-run when the process died. They are marked failed
   * with a resumable failure so the operator can restart them deliberately.
   */
  async findInterrupted() {
    const { jobs } = await this.list({ limit: 1000 });
    return jobs.filter((job) => ['running', 'cancelling'].includes(job.status));
  }
}

/**
 * Brings an older record up to the current schema. Missing collections are
 * filled in so a job written by a previous version still loads.
 */
export function migrate(raw) {
  if (!raw || typeof raw !== 'object') {
    throw new ValidationError('Job record is not an object');
  }
  const record = raw;
  record.segments ??= [];
  record.failures ??= [];
  record.stageHistory ??= [];
  record.logs ??= [];
  record.artifacts ??= {};
  record.resume ??= { lastCompletedStage: null, nextStage: null, resumeCount: 0 };
  record.metrics ??= {};
  record.segmentSummary ??= {};
  record.schemaVersion ??= 1;
  if (record.schemaVersion < 3) record.schemaVersion = 3;
  return record;
}
