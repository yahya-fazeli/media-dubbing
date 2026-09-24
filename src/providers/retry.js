import { sleep } from '../core/concurrency.js';
import { CancelledError, ErrorCode, ProviderError, toAppError } from '../core/errors.js';
import { isCancellation } from '../core/cancellation.js';

/**
 * Retry policy for provider calls. Classification decides everything: quota and
 * transient failures are retried with exponential backoff plus jitter, while
 * authentication and malformed-request failures fail immediately because
 * retrying cannot change the outcome.
 */

export const FailureClass = {
  TRANSIENT: 'transient',
  QUOTA: 'quota',
  AUTH: 'auth',
  INVALID: 'invalid',
  CANCELLED: 'cancelled',
  PERMANENT: 'permanent',
};

export function classifyHttpStatus(status, body = '') {
  if (status === 429) return FailureClass.QUOTA;
  if (status === 401 || status === 403) return FailureClass.AUTH;
  if (status === 400 || status === 404 || status === 422) return FailureClass.INVALID;
  if (status === 408 || status === 425) return FailureClass.TRANSIENT;
  if (status >= 500) return FailureClass.TRANSIENT;
  // Some quota responses surface with a 200-level status and an error body.
  if (/RESOURCE_EXHAUSTED|rate limit|quota/i.test(body)) return FailureClass.QUOTA;
  return FailureClass.PERMANENT;
}

export function classifyError(err) {
  if (isCancellation(err)) return FailureClass.CANCELLED;
  if (err?.name === 'TimeoutError' || err?.code === ErrorCode.TIMEOUT) return FailureClass.TRANSIENT;
  if (err?.code === ErrorCode.PROVIDER_QUOTA) return FailureClass.QUOTA;
  if (err?.code === ErrorCode.PROVIDER_AUTH) return FailureClass.AUTH;
  const causeCode = err?.cause?.code ?? err?.code;
  if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(causeCode)) {
    return FailureClass.TRANSIENT;
  }
  return FailureClass.PERMANENT;
}

/** Full jitter exponential backoff, capped at maxBackoffMs. */
export function backoffDelay(attempt, baseMs, maxMs, random = Math.random) {
  const exponential = Math.min(maxMs, baseMs * 2 ** (attempt - 1));
  return Math.round(exponential * (0.5 + random() * 0.5));
}

/**
 * Runs `fn` with bounded retries. `fn` receives the attempt number so callers
 * can rotate keys or models between attempts.
 *
 * @param {(attempt: number, ctx: object) => Promise<any>} fn
 */
export async function withRetries(fn, options = {}) {
  const {
    maxAttempts = 4,
    baseBackoffMs = 500,
    maxBackoffMs = 15_000,
    signal,
    onAttempt = () => {},
    onGiveUp = () => {},
    random = Math.random,
    retryOn = () => true,
  } = options;

  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (signal?.aborted) {
      throw new CancelledError(signal.reason instanceof Error ? signal.reason.message : 'Cancelled');
    }
    try {
      return await fn(attempt);
    } catch (err) {
      const appErr = toAppError(err);
      const failureClass = classifyError(appErr);
      lastError = appErr;

      if (failureClass === FailureClass.CANCELLED) throw appErr;
      onAttempt(attempt, failureClass, appErr);

      // Only transient and quota failures are worth retrying. Auth, malformed
      // request, and permanent failures repeat identically, so they fail fast.
      const retryable = failureClass === FailureClass.TRANSIENT
        || failureClass === FailureClass.QUOTA;
      const canRetry = attempt < maxAttempts
        && retryable
        && retryOn(failureClass, attempt);

      if (!canRetry) {
        onGiveUp(attempt, failureClass, appErr);
        throw appErr;
      }

      // Quota failures need a longer pause than ordinary transient errors.
      const base = failureClass === FailureClass.QUOTA ? Math.max(baseBackoffMs * 4, 2000) : baseBackoffMs;
      await sleep(backoffDelay(attempt, base, maxBackoffMs, random), { signal });
    }
  }
  throw lastError;
}

export function quotaError(message, details = {}) {
  return new ProviderError(message, {
    code: ErrorCode.PROVIDER_QUOTA,
    retryable: true,
    recoveryScope: 'stage',
    recommendedAction: 'Retry after the quota window resets, or add another API key.',
    details,
  });
}

export function authError(message, details = {}) {
  return new ProviderError(message, {
    code: ErrorCode.PROVIDER_AUTH,
    retryable: false,
    recoveryScope: 'none',
    recommendedAction: 'Verify the configured Gemini API key is valid and has the required scopes.',
    details,
  });
}
