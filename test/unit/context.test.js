import test from 'node:test';
import assert from 'node:assert/strict';
import { PipelineContext } from '../../src/pipeline/context.js';
import { JobStatus, StageName, createJobRecord } from '../../src/core/job-model.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function baseJob(overrides = {}) {
  return Object.assign(
    createJobRecord({
      jobId: 'job_race_0001',
      sourceName: 'clip.wav',
      sourcePath: 'input/clip.wav',
      sourceLanguage: 'en',
      targetLanguage: 'es',
    }),
    { status: JobStatus.RUNNING, startedAt: '2026-01-01T00:00:00.000Z' },
    overrides,
  );
}

/** A minimal mutex so the fake store behaves like JobStore.withLock. */
class Mutex {
  constructor() { this.tail = Promise.resolve(); }
  run(fn) {
    const result = this.tail.then(fn, fn);
    this.tail = result.then(() => {}, () => {});
    return result;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Store that delays writes that originate from `save()` (delay = true) but makes
 * `mutate()` writes immediate. That models a slow stage persist racing a fast
 * cancel endpoint, and lets the test pin the interleaving deterministically.
 */
class DelayedWriteStore {
  constructor(record, delayMs = 60) {
    this.record = clone(record);
    this.delayMs = delayMs;
    this.mutex = new Mutex();
    this.onWriteStart = null;
  }

  async read() {
    return clone(this.record);
  }

  async write(record, { delay = true } = {}) {
    if (delay) {
      this.onWriteStart?.();
      await sleep(this.delayMs);
    }
    this.record = clone(record);
    return this.record;
  }

  withLock(_jobId, fn) {
    return this.mutex.run(fn);
  }

  async mutate(jobId, mutator) {
    return this.withLock(jobId, async () => {
      const record = await this.read();
      await mutator(record);
      await this.write(record, { delay: false });
      return record;
    });
  }
}

test('a stage save cannot clobber a concurrent cancellation', async () => {
  const store = new DelayedWriteStore(baseJob());
  const job = clone(store.record); // the stage's stale in-memory view

  const context = new PipelineContext({
    config: { engine: 'mock' },
    job,
    store,
    artifacts: {},
    engine: null,
    provider: null,
    logger: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    metrics: { increment() {}, gauge() {}, observe() {} },
    telemetry: { span: (_n, _a, fn) => fn() },
    signal: null,
    services: {},
  });

  let writeStarted;
  const writeStartedPromise = new Promise((resolve) => { writeStarted = resolve; });
  store.onWriteStart = writeStarted;

  const savePromise = context.save();
  await writeStartedPromise; // the stage write is now in flight

  // The cancel endpoint commits mid-write. It must win: the job is cancelling.
  const cancelPromise = store.mutate(job.jobId, (record) => {
    record.status = JobStatus.CANCELLING;
  });

  await Promise.all([savePromise, cancelPromise]);
  assert.equal(
    store.record.status,
    JobStatus.CANCELLING,
    'the cancellation status must survive a stage write that started earlier',
  );
});

test('a stage save still persists its own fields', async () => {
  const store = new DelayedWriteStore(baseJob(), 0);
  const context = new PipelineContext({
    config: { engine: 'mock' },
    job: clone(store.record),
    store,
    artifacts: {},
    engine: null,
    provider: null,
    logger: { child: () => ({ debug() {}, info() {}, warn() {}, error() {} }) },
    metrics: { increment() {}, gauge() {}, observe() {} },
    telemetry: { span: (_n, _a, fn) => fn() },
    signal: null,
    services: {},
  });

  context.job.stages[StageName.INGEST].status = 'succeeded';
  await context.save();

  assert.equal(store.record.stages[StageName.INGEST].status, 'succeeded');
});
