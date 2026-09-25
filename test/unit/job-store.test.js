import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JobStore, migrate } from '../../src/core/job-store.js';
import { loadConfig, ensureDataDirs } from '../../src/config.js';
import { ErrorCode } from '../../src/core/errors.js';
import { newJobId } from '../../src/core/ids.js';

async function makeStore(t) {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'dub-store-'));
  t.after(() => fsp.rm(dataDir, { recursive: true, force: true }));
  const config = ensureDataDirs(loadConfig({ dataDir }));
  const store = new JobStore(config, { debug() {}, warn() {}, error() {} });
  return { store, config, dataDir };
}

function record(jobId, overrides = {}) {
  return {
    jobId,
    schemaVersion: 3,
    status: 'created',
    createdAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    updatedAt: new Date('2024-01-01T00:00:00Z').toISOString(),
    segments: [],
    failures: [],
    stageHistory: [],
    logs: [],
    artifacts: {},
    ...overrides,
  };
}

test('jobDir rejects ids that could traverse or leave the jobs directory', async (t) => {
  const { store } = await makeStore(t);
  for (const bad of ['../../etc', '..', '.', 'a/b', '', 'x\u0000y']) {
    assert.throws(() => store.jobDir(bad), `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test('create writes job.json and an artifacts directory', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId));

  const stat = await fsp.stat(store.jobFile(jobId));
  assert.ok(stat.isFile());
  const artStat = await fsp.stat(store.artifactsDir(jobId));
  assert.ok(artStat.isDirectory());
});

test('read returns a cached record, and { fresh } re-reads from disk', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { status: 'created' }));

  const cached = await store.read(jobId);
  assert.equal(cached.status, 'created');

  // Change the file underneath the store without touching the cached object.
  await fsp.writeFile(store.jobFile(jobId), JSON.stringify(record(jobId, { status: 'running' })));

  assert.equal((await store.read(jobId)).status, 'created', 'cache serves the stale copy');
  assert.equal((await store.read(jobId, { fresh: true })).status, 'running', 'fresh bypasses the cache');
  assert.equal((await store.read(jobId)).status, 'running', 'a fresh read refreshes the cache');
});

test('read throws NotFound for an unknown job', async (t) => {
  const { store } = await makeStore(t);
  await assert.rejects(
    () => store.read(newJobId()),
    (err) => err.code === ErrorCode.NOT_FOUND,
  );
});

test('exists is false for malformed ids rather than throwing', async (t) => {
  const { store } = await makeStore(t);
  assert.equal(await store.exists('../../etc/passwd'), false);
  assert.equal(await store.exists(newJobId()), false);
});

test('write stamps updatedAt on every persist', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  const rec = record(jobId);
  await store.create(rec);
  const first = rec.updatedAt;

  await new Promise((r) => setTimeout(r, 5));
  rec.status = 'running';
  await store.write(rec);
  assert.notEqual(rec.updatedAt, first, 'updatedAt must advance');
  assert.equal((await store.read(jobId, { fresh: true })).status, 'running');
});

test('withLock serializes concurrent read-modify-write cycles', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { counter: 0, segments: [] }));

  let inFlight = 0;
  let maxInFlight = 0;
  const bump = () => store.withLock(jobId, async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    const job = await store.read(jobId, { fresh: true });
    await new Promise((r) => setTimeout(r, 2));
    job.counter += 1;
    await store.write(job);
    inFlight -= 1;
  });

  await Promise.all(Array.from({ length: 25 }, bump));
  assert.equal(maxInFlight, 1, 'the lock must never admit two writers at once');
  assert.equal((await store.read(jobId, { fresh: true })).counter, 25, 'no update may be lost');
});

test('withLock still releases when the critical section throws', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId));

  await assert.rejects(() => store.withLock(jobId, async () => { throw new Error('boom'); }), /boom/);
  // If the lock leaked, this would hang instead of resolving.
  const job = await store.withLock(jobId, async () => store.read(jobId, { fresh: true }));
  assert.equal(job.jobId, jobId);
});

test('mutate reads, applies, and persists atomically', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { status: 'created' }));

  const result = await store.mutate(jobId, async (job) => { job.status = 'running'; });
  assert.equal(result.status, 'running', 'mutate returns the mutated record');
  assert.equal((await store.read(jobId, { fresh: true })).status, 'running');
});

test('mutate returns an explicit value when the mutator supplies one', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId));
  const result = await store.mutate(jobId, async () => 'custom');
  assert.equal(result, 'custom');
});

test('list filters by status, sorts, and paginates', async (t) => {
  const { store } = await makeStore(t);
  for (let i = 0; i < 5; i += 1) {
    const jobId = newJobId();
    await store.create(record(jobId, {
      createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, i)).toISOString(),
      status: i % 2 === 0 ? 'completed' : 'failed',
    }));
  }

  const all = await store.list();
  assert.equal(all.total, 5);
  assert.equal(all.jobs.length, 5);

  const completed = await store.list({ status: 'completed' });
  assert.equal(completed.total, 3);
  assert.ok(completed.jobs.every((j) => j.status === 'completed'));

  const ascending = await store.list({ sort: 'asc' });
  assert.equal(ascending.jobs[0].createdAt, new Date(Date.UTC(2024, 0, 1, 0, 0, 0)).toISOString());

  const page = await store.list({ limit: 2, offset: 1, sort: 'asc' });
  assert.equal(page.total, 5);
  assert.equal(page.jobs.length, 2);
  assert.equal(page.jobs[0].jobId, ascending.jobs[1].jobId);
});

test('list on a missing jobs directory returns an empty page instead of throwing', async (t) => {
  const { store, config } = await makeStore(t);
  await fsp.rm(config.jobsDir, { recursive: true, force: true });
  const page = await store.list();
  assert.deepEqual(page, { jobs: [], total: 0 });
});

test('list skips directories that hold no readable job record', async (t) => {
  const { store, config } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId));
  await fsp.mkdir(path.join(config.jobsDir, 'not-a-job'), { recursive: true });
  await fsp.mkdir(path.join(config.jobsDir, '.hidden'), { recursive: true });

  const page = await store.list();
  assert.equal(page.total, 1);
  assert.equal(page.jobs[0].jobId, jobId);
});

test('delete refuses to remove a running or cancelling job unless forced', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { status: 'running' }));

  await assert.rejects(
    () => store.delete(jobId),
    (err) => err.code === ErrorCode.CONFLICT && /cannot be deleted/.test(err.message),
  );
  assert.equal(await store.exists(jobId), true, 'the job must survive a refused delete');

  await store.delete(jobId, { force: true });
  assert.equal(await store.exists(jobId), false);
});

test('delete removes a terminal job and its cached entry', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { status: 'completed' }));
  await store.read(jobId);
  await store.delete(jobId);
  assert.equal(await store.exists(jobId), false);
  await assert.rejects(() => store.read(jobId), (err) => err.code === ErrorCode.NOT_FOUND);
});

test('findInterrupted reports only jobs left mid-run', async (t) => {
  const { store } = await makeStore(t);
  const running = newJobId();
  const cancelling = newJobId();
  const done = newJobId();
  await store.create(record(running, { status: 'running' }));
  await store.create(record(cancelling, { status: 'cancelling' }));
  await store.create(record(done, { status: 'completed' }));

  const interrupted = await store.findInterrupted();
  assert.deepEqual(
    interrupted.map((j) => j.jobId).sort(),
    [running, cancelling].sort(),
  );
});

test('invalidate drops one entry, or the whole cache when called bare', async (t) => {
  const { store } = await makeStore(t);
  const jobId = newJobId();
  await store.create(record(jobId, { status: 'created' }));

  store.invalidate(jobId);
  const fresh = await store.read(jobId, { fresh: true });
  fresh.status = 'running';
  await fsp.writeFile(store.jobFile(jobId), JSON.stringify(fresh));

  // Cache was dropped, so a plain read observes the on-disk value.
  assert.equal((await store.read(jobId)).status, 'running');
  store.invalidate();
  assert.equal((await store.read(jobId)).status, 'running');
});

test('migrate backfills collections on a sparse record and bumps the schema', () => {
  const migrated = migrate({ jobId: 'job_x', status: 'created' });
  assert.deepEqual(migrated.segments, []);
  assert.deepEqual(migrated.failures, []);
  assert.deepEqual(migrated.stageHistory, []);
  assert.deepEqual(migrated.artifacts, {});
  assert.deepEqual(migrated.resume, { lastCompletedStage: null, nextStage: null, resumeCount: 0 });
  assert.equal(migrated.languages.detectedSource, null);
  assert.equal(migrated.settings.autoDetectSourceLanguage, false);
  assert.equal(migrated.schemaVersion, 3);

  const auto = migrate({ jobId: 'job_auto', languages: { source: 'auto' } });
  assert.equal(auto.settings.autoDetectSourceLanguage, true);
});

test('migrate preserves existing data and rejects non-objects', () => {
  const migrated = migrate({ jobId: 'job_x', segments: [{ segmentId: 'seg_00001' }] });
  assert.equal(migrated.segments.length, 1);
  assert.throws(() => migrate(null), /not an object/i);
  assert.throws(() => migrate('nope'), /not an object/i);
});
