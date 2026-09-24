import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { Logger, redact, LEVELS } from '../../src/core/logger.js';

/** Collects log lines so assertions can inspect exactly what a sink received. */
function capture() {
  const lines = [];
  const stream = new Writable({
    write(chunk, _enc, cb) { lines.push(chunk.toString()); cb(); },
  });
  return { stream, lines };
}

test('redact masks secret-looking object keys at any depth', () => {
  const out = redact({
    apiKey: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456',
    nested: { authorization: 'Bearer abcdefghijklmnop1234', token: 'short' },
    safe: 'keep me',
  });
  assert.equal(out.apiKey, '[redacted]');
  assert.equal(out.nested.authorization, '[redacted]');
  assert.equal(out.nested.token, '[redacted]');
  assert.equal(out.safe, 'keep me');
});

test('redact masks inline Gemini-style keys inside plain strings', () => {
  const out = redact('call failed with AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456');
  assert.ok(!out.includes('AIzaSy'), `key leaked: ${out}`);
  assert.ok(out.includes('[redacted]'));
});

test('redact masks query-string credentials but not ordinary prose', () => {
  // The whole `key=value` pair is replaced, so the secret never appears.
  assert.equal(redact('https://x/y?key=supersecretvalue'), 'https://x/y?[redacted]');
  const prose = 'the API requires bearer authentication';
  assert.equal(redact(prose), prose);
});

test('redact masks a real-looking bearer token in a string', () => {
  const out = redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc123');
  assert.ok(!out.includes('eyJhbGciOiJIUzI1NiJ9'), `token leaked: ${out}`);
  assert.ok(out.includes('Bearer [redacted]'));
});

test('redact walks arrays and normalizes thrown errors', () => {
  const out = redact(['ok', { password: 'hunter2' }]);
  assert.equal(out[0], 'ok');
  assert.equal(out[1].password, '[redacted]');

  const err = new Error('boom key=abcdef');
  const redacted = redact(err);
  assert.equal(redacted.name, 'Error');
  assert.ok(!redacted.message.includes('abcdef'), `secret leaked: ${redacted.message}`);
});

test('redact bounds recursion instead of blowing up on cycles', () => {
  const node = { name: 'root' };
  node.self = node;
  const out = redact(node);
  assert.equal(out.name, 'root');
  let cursor = out;
  let depth = 0;
  while (cursor.self && depth < 20) { cursor = cursor.self; depth += 1; }
  assert.ok(depth <= 8, `expected bounded depth, walked ${depth}`);
  assert.equal(cursor, '[depth-limit]');
});

test('redact treats null and undefined as pass-through', () => {
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test('Logger writes newline-delimited JSON with redacted fields', () => {
  const { stream, lines } = capture();
  const logger = new Logger({ level: 'info', pretty: false, stream });
  logger.info('provider call', { apiKey: 'AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZ0123456' });

  assert.equal(lines.length, 1);
  assert.ok(lines[0].endsWith('\n'), 'records are newline terminated');
  const record = JSON.parse(lines[0]);
  assert.equal(record.level, 'info');
  assert.equal(record.msg, 'provider call');
  assert.equal(record.fields.apiKey, '[redacted]');
  assert.ok(record.ts, 'records carry a timestamp');
});

test('Logger suppresses records below its level', () => {
  const { stream, lines } = capture();
  const logger = new Logger({ level: 'warn', pretty: false, stream });
  logger.debug('noisy');
  logger.info('also noisy');
  logger.warn('kept');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).msg, 'kept');
});

test('Logger.child merges bindings into every subsequent record', () => {
  const { stream, lines } = capture();
  const logger = new Logger({ level: 'debug', pretty: false, stream }).child({ jobId: 'job_1' });
  const child = logger.child({ stage: 'tts' });
  child.info('working', { segmentId: 'seg_00001' });

  const record = JSON.parse(lines[0]);
  assert.equal(record.jobId, 'job_1');
  assert.equal(record.stage, 'tts');
  assert.equal(record.fields.segmentId, 'seg_00001');
});

test('Logger.time logs the outcome and rethrows failures', async () => {
  const { stream, lines } = capture();
  const logger = new Logger({ level: 'debug', pretty: false, stream });

  const value = await logger.time('op', { stage: 'mix' }, async () => 42);
  assert.equal(value, 42);
  const okRecord = JSON.parse(lines[0]);
  assert.equal(okRecord.fields.outcome, 'ok');
  assert.equal(typeof okRecord.fields.durationMs, 'number');

  await assert.rejects(
    () => logger.time('op', { stage: 'mix' }, async () => { throw new Error('nope'); }),
    /nope/,
  );
  const errRecord = JSON.parse(lines[1]);
  assert.equal(errRecord.fields.outcome, 'error');
  assert.equal(errRecord.fields.error, 'nope');
});

test('LEVELS ordering is monotonic so filtering is well defined', () => {
  assert.ok(LEVELS.debug < LEVELS.info);
  assert.ok(LEVELS.info < LEVELS.warn);
  assert.ok(LEVELS.warn < LEVELS.error);
  assert.ok(LEVELS.error < LEVELS.silent);
});
