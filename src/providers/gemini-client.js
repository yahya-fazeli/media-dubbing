import {
  CancelledError, ErrorCode, ProviderError, TimeoutError, toAppError,
} from '../core/errors.js';
import { KeyPool } from './key-pool.js';
import {
  FailureClass, authError, classifyHttpStatus, quotaError, withRetries,
} from './retry.js';

/**
 * Thin REST client for the Gemini API. It owns everything that must be uniform
 * across transcription, translation, and TTS:
 *
 *  - key rotation across multiple API keys
 *  - model fallback along an ordered chain
 *  - bounded retries with backoff for transient and quota failures
 *  - request timeouts and prompt cancellation
 *  - per-call metrics, without ever logging key material
 */
export class GeminiClient {
  #keyPool;
  #metrics;
  #logger;
  #fetchImpl;
  #random;

  constructor(config, { logger, metrics, fetchImpl, random } = {}) {
    this.config = config;
    this.gemini = config.providers.gemini;
    this.#keyPool = new KeyPool(this.gemini.apiKeys, { cooldownMs: this.gemini.quotaCooldownMs });
    this.#metrics = metrics ?? null;
    this.#logger = logger ?? { debug() {}, info() {}, warn() {}, error() {} };
    this.#fetchImpl = fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.#random = random ?? Math.random;
  }

  get configured() { return !this.#keyPool.empty; }
  get keyPoolSize() { return this.#keyPool.size; }
  keyHealth() { return this.#keyPool.describe(); }

  /**
   * Issues a generateContent call, walking the model chain and rotating keys.
   * `buildBody(model)` produces the request payload for a given model, which lets
   * callers swap model-specific fields (for example TTS voice config).
   */
  async generateContent({ models, buildBody, operation, signal, stage, segmentId, parse }) {
    if (!this.configured) {
      throw authError('No Gemini API keys configured', { operation: 'generateContent' });
    }
    const modelList = Array.from(models);
    let lastError = null;

    for (let modelIndex = 0; modelIndex < modelList.length; modelIndex += 1) {
      const model = modelList[modelIndex];
      const isFallback = modelIndex > 0;
      if (isFallback) {
        this.#metrics?.increment('dub_provider_model_fallbacks_total', 1, { operation });
      }

      if (signal?.aborted) throw new CancelledError();

      try {
        const result = await withRetries(
          async (attempt) => {
            const { key, index } = this.#keyPool.next();
            if (index !== 0 && attempt > 1) {
              this.#keyPool.noteRotation();
              this.#metrics?.increment('dub_provider_key_rotations_total', 1, { operation });
            }
            return this.#callModel({ model, key, keyIndex: index, attempt, buildBody, operation, signal, stage, segmentId, parse });
          },
          {
            maxAttempts: this.gemini.maxAttempts,
            baseBackoffMs: this.gemini.baseBackoffMs,
            maxBackoffMs: this.gemini.maxBackoffMs,
            signal,
            random: this.#random,
            onGiveUp: (attempt, failureClass, err) => {
              this.#logger.warn('Provider call gave up', {
                operation, stage, segmentId, model, attempts: attempt, failureClass,
                errorCode: err.code, error: err.message,
              });
            },
          },
        );
        if (isFallback) {
          this.#logger.info('Provider call succeeded on fallback model', { operation, model });
        }
        return result;
      } catch (err) {
        const appErr = toAppError(err, { stage, segmentId });
        lastError = appErr;
        const failureClass = classifyFailure(appErr);
        // Only model-availability problems justify trying the next model. A quota
        // or auth problem would repeat identically on every model.
        const tryNextModel = failureClass === FailureClass.INVALID
          || (failureClass === FailureClass.PERMANENT && appErr.code === ErrorCode.PROVIDER_UNAVAILABLE);
        if (isCancellation(appErr)) throw appErr;
        if (!tryNextModel) throw appErr;
        this.#logger.warn('Model unavailable; trying next in fallback chain', {
          operation, model, errorCode: appErr.code, error: appErr.message,
        });
      }
    }
    throw lastError ?? new ProviderError('All models in the fallback chain failed', { operation });
  }

  async #callModel({ model, key, keyIndex, attempt, buildBody, operation, signal, stage, segmentId, parse }) {
    const url = `${this.gemini.baseUrl}/models/${encodeURIComponent(model)}:generateContent`;
    const body = buildBody(model);
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('request timeout')), this.gemini.requestTimeoutMs);

    const started = Date.now();
    this.#metrics?.increment('dub_provider_calls_total', 1, { operation, model });
    const labels = { operation, model };

    try {
      const response = await this.#fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // Keys travel in a header, never a query string, so they cannot leak
          // into access logs or error messages that echo the URL.
          'x-goog-api-key': key,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      const durationMs = Date.now() - started;
      this.#metrics?.observe('dub_provider_duration_ms', durationMs, labels);

      if (!response.ok) {
        const text = await safeText(response);
        const failureClass = classifyHttpStatus(response.status, text);

        if (failureClass === FailureClass.QUOTA) {
          this.#keyPool.recordFailure(key, { quotaExceeded: true });
          this.#metrics?.increment('dub_provider_quota_events_total', 1, { operation, model });
          // A quota failure belongs to the key, not the model, so retrying with
          // another key is the right move before giving up on the model.
          throw quotaError(`Gemini returned ${response.status} for ${operation}`, {
            operation, model, status: response.status, attempt,
          });
        }
        if (failureClass === FailureClass.AUTH) {
          this.#keyPool.recordFailure(key, { authFailed: true });
          throw authError(`Gemini rejected the API key (${response.status})`, {
            operation, model, status: response.status, keyIndex,
          });
        }
        if (failureClass === FailureClass.INVALID && /model|not found|unsupported/i.test(text)) {
          throw new ProviderError(`Model ${model} is not available for ${operation}`, {
            code: ErrorCode.PROVIDER_UNAVAILABLE,
            retryable: false,
            details: { operation, model, status: response.status },
          });
        }
        if (failureClass === FailureClass.INVALID) {
          throw new ProviderError(`Gemini rejected the ${operation} request`, {
            code: ErrorCode.PROVIDER_ERROR,
            retryable: false,
            recoveryScope: 'segment',
            details: { operation, model, status: response.status, body: truncate(text) },
            recommendedAction: 'Inspect the segment input; the request was malformed.',
          });
        }
        throw new ProviderError(`Gemini returned ${response.status} for ${operation}`, {
          code: ErrorCode.PROVIDER_ERROR,
          retryable: true,
          details: { operation, model, status: response.status, body: truncate(text) },
        });
      }

      const json = await response.json();
      this.#keyPool.recordSuccess(key);
      return parse ? parse(json, { model, operation }) : json;
    } catch (err) {
      this.#metrics?.increment('dub_provider_errors_total', 1, {
        operation, model, failureClass: classifyErrorCode(err),
      });
      if (controller.signal.aborted && signal?.aborted) {
        throw new CancelledError('Provider request cancelled');
      }
      if (controller.signal.aborted) {
        throw new TimeoutError(`Gemini ${operation} request timed out after ${this.gemini.requestTimeoutMs}ms`, {
          stage, segmentId,
          details: { operation, model },
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }
}

function classifyFailure(appErr) {
  if (appErr.code === ErrorCode.PROVIDER_QUOTA) return FailureClass.QUOTA;
  if (appErr.code === ErrorCode.PROVIDER_AUTH) return FailureClass.AUTH;
  if (appErr.code === ErrorCode.PROVIDER_UNAVAILABLE) return FailureClass.PERMANENT;
  if (appErr.code === ErrorCode.PROVIDER_ERROR && appErr.details?.status === 400) return FailureClass.INVALID;
  if (appErr.code === ErrorCode.TIMEOUT) return FailureClass.TRANSIENT;
  return FailureClass.PERMANENT;
}

function classifyErrorCode(err) {
  const appErr = toAppError(err);
  return appErr.code;
}

function isCancellation(err) {
  return err?.code === ErrorCode.CANCELLED || err?.name === 'CancelledError' || err?.name === 'AbortError';
}

async function safeText(response) {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

function truncate(text, max = 800) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}
