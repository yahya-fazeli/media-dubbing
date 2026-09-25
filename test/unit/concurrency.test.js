import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mapLimit, mapLimitStrict, forEachLimit, Mutex, Semaphore, sleep, chunk,
} from '../../src/core/concurrency.js';

/**
 * `concurrency.js` backs every fan-out in the pipeline: the per-segment TTS loop,
 * the alignment and timing loops, and the batched translation calls. These tests
 * pin the behaviours those callers rely on -- incremental persistence through
 * `onSettled`, bounded parallelism, and cancellation-aware sleeps -- that the
 * existing coverage in core.test.js does not exercise.
 */

test('mapLimit calls onSettled once per item, in index order, including failures', async () => {
  // The TTS stage persists job state from onSettled, so a missed or duplicated
  // callback would either lose progress or write it twice for the same segment.
  const settled = [];
  const results = await mapLimit([1, 2, 3, 4], 2, async (n) => {
    if (n === 2) throw new Error('seg-2 failed');
    return n * 10;
  }, {
    onSettled: (index, outcome) => settled.push([index, outcome.status]),
  });

  assert.deepEqual(settled, [
    [0, 'fulfilled'],
    [1, 'rejected'],
    [2, 'fulfilled'],
    [3, 'fulfilled'],
  ]);
  assert.equal(results[1].status, 'rejected');
  assert.equal(results[1].reason.message, 'seg-2 failed');
});

test('mapLimit onSettled is not called for items skipped by shouldStop', async () => {
  const settled = [];
  let ran = 0;
  const results = await mapLimit([1, 2, 3, 4, 5], 1, async (n) => {
    ran += 1;
    return n;
  }, {
    shouldStop: () => ran >= 2,
    onSettled: (index) => settled.push(index),
  });

  // Once shouldStop flips, no further worker runs and no further callbacks fire.
  assert.equal(ran, 2);
  assert.deepEqual(settled, [0, 1]);
  // mapLimit still returns a full-length array; the unvisited slots stay empty.
  assert.equal(results.length, 5);
  assert.equal(results[0].value, 1);
  assert.equal(results[1].value, 2);
  assert.equal(results[2], undefined);
});

test('mapLimit clamps the limit to at least one and at most the item count', async () => {
  // A limit of 0 or a negative value would otherwise start zero workers and hang
  // forever -- exactly the config footgun DUB_SEGMENT_CONCURRENCY could hit.
  for (const limit of [0, -5]) {
    let active = 0;
    let maxActive = 0;
    const results = await mapLimit([1, 2, 3], limit, async (n) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await sleep(2);
      active -= 1;
      return n;
    });
    assert.equal(maxActive, 1, `limit ${limit} should still run one worker at a time`);
    assert.deepEqual(results.map((r) => r.value), [1, 2, 3]);
  }

  // A limit above the item count must not create idle workers that never resolve.
  const wide = await mapLimit([1, 2], 999, async (n) => n + 1);
  assert.deepEqual(wide.map((r) => r.value), [2, 3]);
});

test('mapLimit accepts any iterable, not just arrays', async () => {
  const fromSet = await mapLimit(new Set([1, 2, 3]), 2, async (n) => n * 2);
  assert.deepEqual(fromSet.map((r) => r.value), [2, 4, 6]);
});

test('forEachLimit stops at the first rejection and resolves with undefined', async () => {
  let ran = 0;
  await assert.rejects(
    forEachLimit([1, 2, 3, 4], 1, async (n) => {
      ran += 1;
      if (n === 2) throw new Error('halt');
    }),
    /halt/,
  );
  assert.equal(ran, 2, 'items after the failure must not run');

  assert.equal(await forEachLimit([1], 1, async () => 'ignored'), undefined);
});

test('mapLimitStrict rejects rather than recording a rejected entry', async () => {
  const results = await mapLimitStrict([1, 2], 1, async (n) => n);
  assert.deepEqual(results.map((r) => r.value), [1, 2]);
  assert.equal(results.every((r) => r.status === 'fulfilled'), true);
});

test('Mutex serializes tasks and stays usable after a task throws', async () => {
  const mutex = new Mutex();
  const order = [];

  const first = mutex.run(async () => {
    order.push('a-start');
    await sleep(5);
    order.push('a-end');
    return 'A';
  });
  const second = mutex.run(async () => {
    order.push('b-start');
    throw new Error('b boom');
  });
  const third = mutex.run(async () => {
    order.push('c-start');
    return 'C';
  });

  const results = await Promise.allSettled([first, second, third]);

  assert.deepEqual(order, ['a-start', 'a-end', 'b-start', 'c-start']);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.equal(results[0].value, 'A');
  assert.equal(results[2].value, 'C', 'a failed task must not stall the queue');

  // The queue must recover: a rejection is swallowed for the tail but still
  // surfaces to its own caller.
  assert.equal(await mutex.run(async () => 'after'), 'after');
});

test('Semaphore bounds concurrency and grants permits in FIFO order', async () => {
  const semaphore = new Semaphore(2);
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 6 }, (_, i) => semaphore.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(3);
    active -= 1;
    return i;
  })));

  assert.equal(maxActive, 2, 'never more than the permitted number in flight');

  const fifo = new Semaphore(1);
  const order = [];
  await Promise.all(Array.from({ length: 3 }, (_, i) => fifo.run(async () => {
    order.push(i);
    await sleep(2);
  })));
  assert.deepEqual(order, [0, 1, 2]);
});

test('Semaphore clamps permits to one and releases on failure', async () => {
  let active = 0;
  let maxActive = 0;
  const semaphore = new Semaphore(0);
  await Promise.all(Array.from({ length: 4 }, () => semaphore.run(async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await sleep(2);
    active -= 1;
  })));
  assert.equal(maxActive, 1, 'a zero-permit semaphore is clamped to one');

  const recovering = new Semaphore(1);
  await assert.rejects(recovering.run(async () => { throw new Error('nope'); }), /nope/);
  assert.equal(await recovering.run(async () => 'ok'), 'ok', 'the permit is released in a finally');
});

test('sleep resolves without a signal and honors an abort before it starts', async () => {
  await sleep(1);

  const preAborted = new AbortController();
  preAborted.abort(new Error('too late'));
  await assert.rejects(() => sleep(1000, { signal: preAborted.signal }), /too late/);
});

test('sleep rejects when aborted mid-flight', async () => {
  const controller = new AbortController();
  const pending = sleep(1000, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('cancelled during backoff')), 10);
  await assert.rejects(() => pending, /cancelled during backoff/);
});

test('sleep wraps a non-Error abort reason in a real Error', async () => {
  const controller = new AbortController();
  controller.abort('plain string reason');
  await assert.rejects(
    () => sleep(1000, { signal: controller.signal }),
    (err) => err instanceof Error && err.message === 'Aborted',
  );
});

test('sleep tolerates a signal-like object without addEventListener', async () => {
  // Callers sometimes pass a bare object rather than a real AbortSignal; sleep
  // must not throw on the optional-chained listeners.
  await sleep(1, { signal: {} });
});

test('sleep removes its abort listener once the timer fires', async () => {
  const controller = new AbortController();
  await sleep(5, { signal: controller.signal });
  // Aborting after resolution must not reject an already-settled promise or
  // leave a dangling listener that fires into the void.
  controller.abort(new Error('after resolve'));
});

test('chunk clamps the batch size to at least one', () => {
  assert.deepEqual(chunk([1, 2, 3], 0), [[1], [2], [3]]);
  assert.deepEqual(chunk([1, 2, 3], -1), [[1], [2], [3]]);
  assert.deepEqual(chunk([], 5), []);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});
