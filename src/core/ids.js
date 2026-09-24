import crypto from 'node:crypto';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Job and segment identifiers appear in URLs, filesystem paths, and artifact
 * names. They are generated here and validated on every ingress so an id can
 * never be used to escape its directory.
 */
export function newJobId() {
  return `job_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`;
}

export function newSegmentId(index) {
  return `seg_${String(index).padStart(5, '0')}`;
}

export function newArtifactId(name) {
  const slug = String(name).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 60);
  return `${slug}_${crypto.randomBytes(4).toString('hex')}`;
}

export function newRequestId() {
  return crypto.randomUUID();
}

export function isSafeId(value) {
  return typeof value === 'string'
    && SAFE_ID.test(value)
    && value !== '.'
    && value !== '..'
    && !value.includes('..');
}

/** Throws unless `value` is a safe identifier. Returns the value otherwise. */
export function assertSafeId(value, label = 'id') {
  if (!isSafeId(value)) {
    const err = new Error(`Invalid ${label}`);
    err.code = 'VALIDATION';
    err.status = 400;
    throw err;
  }
  return value;
}

/** Stable content hash used to decide whether a cached artifact is reusable. */
export function contentHash(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    if (part === undefined || part === null) continue;
    hash.update(typeof part === 'string' ? part : JSON.stringify(part));
    hash.update('\u0000');
  }
  return hash.digest('hex').slice(0, 32);
}

export function shortHash(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10);
}
