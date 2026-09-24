/**
 * Bounded-concurrency helpers. Large jobs fan out over hundreds of segments, so
 * every fan-out in the pipeline must respect a configurable ceiling.
 */

/**
 * Runs `worker` over `items` with at most `limit` in flight. Preserves input
 * order in the result. A throwing worker records a rejected entry rather than
 * aborting the whole batch, so one bad segment cannot sink a job.
 */
export async function mapLimit(items, limit, worker, options = {}) {
  const list = Array.from(items);
  const results = new Array(list.length);
  const effectiveLimit = Math.max(1, Math.min(limit || 1, list.length || 1));
  let cursor = 0;

  async function run() {
    while (true) {
      if (options.shouldStop?.()) return;
      const index = cursor++;
      if (index >= list.length) return;
      try {
        results[index] = { status: 'fulfilled', value: await worker(list[index], index) };
      } catch (err) {
        if (options.failFast) throw err;
        results[index] = { status: 'rejected', reason: err };
      }
      options.onSettled?.(index, results[index]);
    }
  }

  await Promise.all(Array.from({ length: effectiveLimit }, run));
  return results;
}

/** Like mapLimit but throws on the first failure. */
export function mapLimitStrict(items, limit, worker) {
  return mapLimit(items, limit, worker, { failFast: true });
}

/** Runs tasks with a ceiling, stopping early as soon as one rejects. */
export async function forEachLimit(items, limit, worker) {
  await mapLimit(items, limit, worker, { failFast: true });
}

/** A minimal FIFO queue that serializes access to a shared resource. */
export class Mutex {
  #tail = Promise.resolve();

  run(fn) {
    const result = this.#tail.then(fn, fn);
    this.#tail = result.then(() => undefined, () => undefined);
    return result;
  }
}

/** Simple semaphore for callers that need to acquire/release explicitly. */
export class Semaphore {
  #available;
  #waiters = [];

  constructor(permits) {
    this.#available = Math.max(1, permits);
  }

  async acquire() {
    if (this.#available > 0) {
      this.#available -= 1;
      return;
    }
    await new Promise((resolve) => this.#waiters.push(resolve));
  }

  release() {
    const next = this.#waiters.shift();
    if (next) next();
    else this.#available += 1;
  }

  async run(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}

/** Chunks an array into fixed-size batches. */
export function chunk(items, size) {
  const list = Array.from(items);
  const out = [];
  const n = Math.max(1, size);
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

export function sleep(ms, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}
