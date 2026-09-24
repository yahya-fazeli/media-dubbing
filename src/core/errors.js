/**
 * Structured error taxonomy. Every error carries a stable `code`, the pipeline
 * stage it came from, whether retrying could plausibly help, and a suggested
 * recovery scope so the UI can offer the right button.
 */

export const ErrorCode = {
  VALIDATION: 'VALIDATION',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  PROVIDER_ERROR: 'PROVIDER_ERROR',
  PROVIDER_QUOTA: 'PROVIDER_QUOTA',
  PROVIDER_AUTH: 'PROVIDER_AUTH',
  PROVIDER_UNAVAILABLE: 'PROVIDER_UNAVAILABLE',
  TTS_ERROR: 'TTS_ERROR',
  MEDIA_ERROR: 'MEDIA_ERROR',
  MEDIA_TOOL_MISSING: 'MEDIA_TOOL_MISSING',
  CORRUPT_ARTIFACT: 'CORRUPT_ARTIFACT',
  INTERNAL: 'INTERNAL',
};

/**
 * Recovery scopes, ordered from most specific to broadest. The UI uses this to
 * decide whether to offer "retry segment", "retry stage", or "resume job".
 */
export const RecoveryScope = {
  SEGMENT: 'segment',
  STAGE: 'stage',
  JOB: 'job',
  NONE: 'none',
};

export class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = options.name ?? 'AppError';
    this.code = options.code ?? ErrorCode.INTERNAL;
    this.status = options.status ?? 500;
    this.stage = options.stage ?? null;
    this.segmentId = options.segmentId ?? null;
    this.jobId = options.jobId ?? null;
    this.retryable = options.retryable ?? false;
    this.recoveryScope = options.recoveryScope ?? RecoveryScope.NONE;
    this.recommendedAction = options.recommendedAction ?? null;
    this.details = options.details ?? null;
    this.cause = options.cause ?? undefined;
    if (this.cause && this.stack) {
      this.stack = `${this.stack}\nCaused by: ${this.cause.stack ?? this.cause.message ?? this.cause}`;
    }
  }

  /** Serializes to a plain object safe to send to clients or write to disk. */
  toJSON() {
    return {
      code: this.code,
      message: this.message,
      stage: this.stage,
      segmentId: this.segmentId,
      retryable: this.retryable,
      recoveryScope: this.recoveryScope,
      recommendedAction: this.recommendedAction,
      details: this.details,
    };
  }
}

export class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'ValidationError',
      code: ErrorCode.VALIDATION,
      status: 400,
      retryable: false,
      recoveryScope: options.recoveryScope ?? RecoveryScope.NONE,
    });
  }
}

export class NotFoundError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'NotFoundError',
      code: ErrorCode.NOT_FOUND,
      status: 404,
      retryable: false,
      recoveryScope: RecoveryScope.NONE,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'ConflictError',
      code: ErrorCode.CONFLICT,
      status: 409,
      retryable: false,
      recoveryScope: options.recoveryScope ?? RecoveryScope.NONE,
    });
  }
}

export class CancelledError extends AppError {
  constructor(message = 'Operation cancelled', options = {}) {
    super(message, {
      ...options,
      name: 'CancelledError',
      code: ErrorCode.CANCELLED,
      status: 499,
      retryable: false,
      recoveryScope: RecoveryScope.JOB,
      recommendedAction: 'Resume the job to continue from the last checkpoint.',
    });
  }
}

export class TimeoutError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'TimeoutError',
      code: ErrorCode.TIMEOUT,
      status: 504,
      retryable: true,
      recoveryScope: options.recoveryScope ?? RecoveryScope.STAGE,
      recommendedAction: options.recommendedAction ?? 'Retry the stage; the operation exceeded its time budget.',
    });
  }
}

export class ProviderError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'ProviderError',
      code: options.code ?? ErrorCode.PROVIDER_ERROR,
      status: 502,
      retryable: options.retryable ?? true,
      recoveryScope: options.recoveryScope ?? RecoveryScope.SEGMENT,
      recommendedAction:
        options.recommendedAction ?? 'Retry; the AI provider returned a transient failure.',
    });
  }
}

export class MediaError extends AppError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      name: 'MediaError',
      code: options.code ?? ErrorCode.MEDIA_ERROR,
      status: 422,
      retryable: options.retryable ?? false,
      recoveryScope: options.recoveryScope ?? RecoveryScope.STAGE,
      recommendedAction:
        options.recommendedAction ?? 'Inspect the source media and retry the media stage.',
    });
  }
}

/** Normalizes anything thrown into an AppError without losing the original. */
export function toAppError(err, context = {}) {
  if (err instanceof AppError) {
    if (!err.stage && context.stage) err.stage = context.stage;
    if (!err.segmentId && context.segmentId) err.segmentId = context.segmentId;
    if (!err.jobId && context.jobId) err.jobId = context.jobId;
    return err;
  }
  if (err?.name === 'AbortError') {
    return new CancelledError('Operation aborted', context);
  }
  return new AppError(err?.message ?? String(err), {
    ...context,
    code: context.code ?? ErrorCode.INTERNAL,
    retryable: context.retryable ?? false,
    recoveryScope: context.recoveryScope ?? RecoveryScope.NONE,
    cause: err,
  });
}
