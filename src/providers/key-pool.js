import { AppError, ErrorCode, ProviderError } from '../core/errors.js';

/**
 * Tracks per-key health so the client can rotate away from a key that is rate
 * limited or rejected, and rotate back once a cooldown expires.
 */
export class KeyPool {
  #keys;
  #state = new Map();
  #cursor = 0;
  #cooldownMs;
  #rotations = 0;

  constructor(keys, { cooldownMs = 60_000 } = {}) {
    const unique = [...new Set((keys ?? []).map((k) => String(k).trim()).filter(Boolean))];
    this.#keys = unique;
    this.#cooldownMs = cooldownMs;
    for (const key of unique) this.#state.set(key, { failures: 0, blockedUntil: 0, uses: 0 });
  }

  get size() { return this.#keys.length; }
  get rotations() { return this.#rotations; }
  get empty() { return this.#keys.length === 0; }

  /** Masks keys for logs; only ever exposes an index and a short fingerprint. */
  describe() {
    return this.#keys.map((key, index) => ({
      index,
      fingerprint: `${key.slice(0, 4)}...${key.slice(-4)}`,
      ...this.#state.get(key),
    }));
  }

  /**
   * Returns the next usable key, preferring the least-failed key that is not in
   * cooldown. Throws when every key is blocked.
   */
  next() {
    if (!this.#keys.length) {
      throw new AppError('No Gemini API keys are configured', {
        code: ErrorCode.PROVIDER_AUTH,
        status: 503,
        retryable: false,
        recoveryScope: 'none',
        recommendedAction: 'Set GEMINI_API_KEYS (or GEMINI_API_KEY) and restart the server.',
      });
    }
    const now = Date.now();
    const nowBlocked = this.#keys.filter((k) => this.#state.get(k).blockedUntil > now);
    if (nowBlocked.length === this.#keys.length) {
      const soonest = Math.min(...nowBlocked.map((k) => this.#state.get(k).blockedUntil));
      throw new ProviderError('All API keys are rate limited or unavailable', {
        code: ErrorCode.PROVIDER_QUOTA,
        retryable: true,
        recoveryScope: 'stage',
        details: { retryAfterMs: Math.max(0, soonest - now) },
        recommendedAction: 'Wait for the quota cooldown then retry the stage.',
      });
    }

    for (let i = 0; i < this.#keys.length; i += 1) {
      this.#cursor = (this.#cursor + 1) % this.#keys.length;
      const key = this.#keys[this.#cursor];
      const state = this.#state.get(key);
      if (state.blockedUntil <= now) {
        state.uses += 1;
        return { key, index: this.#cursor };
      }
    }
    throw new ProviderError('No API key available', { code: ErrorCode.PROVIDER_QUOTA, retryable: true });
  }

  /** Records a transient failure; repeated failures trigger a cooldown. */
  recordFailure(key, { quotaExceeded = false, authFailed = false } = {}) {
    const state = this.#state.get(key);
    if (!state) return;
    state.failures += 1;
    if (authFailed) {
      // An invalid key stays out of rotation until an operator replaces it.
      state.blockedUntil = Number.MAX_SAFE_INTEGER;
    } else if (quotaExceeded || state.failures >= 3) {
      state.blockedUntil = Date.now() + this.#cooldownMs;
    }
  }

  recordSuccess(key) {
    const state = this.#state.get(key);
    if (!state) return;
    state.failures = 0;
  }

  noteRotation() { this.#rotations += 1; }
}

/**
 * Ordered model fallback chain. Keeps the primary model first and skips models
 * that have permanently failed for this process run.
 */
export class ModelChain {
  #models;
  #failed = new Set();
  #fallbacks = 0;

  constructor(primary, fallbacks = []) {
    this.#models = [...new Set([primary, ...fallbacks].filter(Boolean))];
  }

  get models() { return [...this.#models]; }
  get fallbackCount() { return this.#fallbacks; }

  *candidates() {
    const usable = this.#models.filter((m) => !this.#failed.has(m));
    yield* (usable.length ? usable : this.#models);
  }

  markFailed(model) {
    if (this.#failed.has(model)) return;
    this.#failed.add(model);
  }

  markFallback() { this.#fallbacks += 1; }

  reset() { this.#failed.clear(); }
}
