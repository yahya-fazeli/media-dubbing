import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const REDACT_KEYS = new Set([
  'apikey', 'api_key', 'authorization', 'token', 'password', 'secret',
  'key', 'cookie', 'credential', 'credentials', 'x-goog-api-key',
]);

const REDACT_PATTERNS = [
  /AIza[0-9A-Za-z_-]{20,}/g,
  /(?:key|token|secret|password)=([^&\s"']+)/gi,
];

// A bearer credential must look like one: long, and containing at least one
// digit or symbol. Without the "looks like a token" test, ordinary prose such as
// "requires bearer authentication" would be redacted as if it were a secret.
const BEARER_PATTERN = /Bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi;

function redactString(value) {
  let out = value;
  for (const pattern of REDACT_PATTERNS) out = out.replace(pattern, '[redacted]');
  out = out.replace(BEARER_PATTERN, (match, token) => (
    /[0-9._~+/=-]/.test(token) ? 'Bearer [redacted]' : match
  ));
  return out;
}

/** Masks anything that looks like a credential before it reaches a sink. */
export function redact(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return '[depth-limit]';
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), code: value.code };
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * Emits newline-delimited JSON logs with job/stage/segment correlation fields,
 * plus a human-readable single line on stdout when pretty printing is enabled.
 */
export class Logger {
  #level;
  #pretty;
  #stream;
  #bindings;

  constructor(options = {}) {
    this.#level = LEVELS[options.level ?? 'info'] ?? LEVELS.info;
    this.#pretty = options.pretty ?? true;
    this.#stream = options.stream ?? process.stderr;
    this.#bindings = options.bindings ?? {};
  }

  /** Returns a logger with extra correlation fields merged into every line. */
  child(bindings) {
    const child = new Logger({
      level: Object.keys(LEVELS).find((k) => LEVELS[k] === this.#level) ?? 'info',
      pretty: this.#pretty,
      stream: this.#stream,
      bindings: { ...this.#bindings, ...bindings },
    });
    return child;
  }

  #emit(level, msg, fields = {}) {
    if (LEVELS[level] < this.#level) return;
    const record = {
      ts: new Date().toISOString(),
      level,
      msg: redact(msg),
      ...redact(this.#bindings),
      ...(Object.keys(fields).length ? { fields: redact(fields) } : {}),
    };
    this.#stream.write(`${JSON.stringify(record)}\n`);
  }

  debug(msg, fields) { this.#emit('debug', msg, fields); }
  info(msg, fields) { this.#emit('info', msg, fields); }
  warn(msg, fields) { this.#emit('warn', msg, fields); }
  error(msg, fields) { this.#emit('error', msg, fields); }

  /** Times an async operation and logs its duration, success, or failure. */
  async time(msg, fields, fn) {
    const start = Date.now();
    try {
      const result = await fn();
      this.debug(msg, { ...fields, durationMs: Date.now() - start, outcome: 'ok' });
      return result;
    } catch (err) {
      this.warn(msg, {
        ...fields,
        durationMs: Date.now() - start,
        outcome: 'error',
        errorCode: err?.code,
        error: err?.message,
      });
      throw err;
    }
  }
}

export function createLogger(config, bindings = {}) {
  return new Logger({
    level: config?.observability?.logLevel ?? 'info',
    pretty: config?.observability?.logPretty ?? true,
    bindings,
  });
}

/** Returns a logger that writes each job's lines to its own file as well. */
export function jobLogger(config, jobId, baseLogger) {
  const logger = baseLogger ?? createLogger(config);
  return logger.child({ jobId });
}

export function appendJobLogLine(config, jobId, record) {
  try {
    const file = path.join(config.logsDir, `${jobId}.ndjson`);
    fs.appendFileSync(file, `${JSON.stringify(redact(record))}\n`);
  } catch {
    // Logging must never be the reason a job fails.
  }
}

export { LEVELS };
