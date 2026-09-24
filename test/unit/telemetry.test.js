import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Telemetry, createTelemetry } from '../../src/core/telemetry.js';

test('a disabled Telemetry runs the body with a no-op span', async () => {
  const telemetry = new Telemetry({ enabled: false });
  assert.equal(telemetry.enabled, false);
  assert.equal(telemetry.currentTraceId(), null);

  let received = null;
  const value = await telemetry.span('stage', { stage: 'tts' }, async (span) => {
    received = span;
    return 'result';
  });
  assert.equal(value, 'result');
  // The no-op span must accept every method callers may use without throwing.
  assert.doesNotThrow(() => {
    received.setAttribute('a', 1);
    received.setAttributes({ a: 1 });
    received.addEvent('e');
    received.recordException(new Error('x'));
    received.setStatus({ code: 1 });
    received.end();
  });
  assert.equal(received.isRecording(), false);
});

test('a disabled Telemetry still propagates body errors unchanged', async () => {
  const telemetry = new Telemetry({ enabled: false });
  const boom = new Error('original');
  await assert.rejects(
    () => telemetry.span('stage', {}, async () => { throw boom; }),
    (err) => err === boom,
  );
});

test('Telemetry uses an injected API and records spans with cleaned attributes', async () => {
  const spans = [];
  const api = {
    trace: {
      getTracer: () => ({
        startActiveSpan: (name, fn) => {
          const span = {
            name,
            attributes: {},
            status: null,
            ended: false,
            exceptions: [],
            setAttribute(k, v) { this.attributes[k] = v; },
            setAttributes(obj) { Object.assign(this.attributes, obj); },
            addEvent() {},
            recordException(err) { this.exceptions.push(err); },
            setStatus(status) { this.status = status; },
            end() { this.ended = true; },
            spanContext: () => ({ traceId: 'trace-1', spanId: 'span-1' }),
          };
          spans.push(span);
          return fn(span);
        },
      }),
      getActiveSpan: () => ({ spanContext: () => ({ traceId: 'trace-1' }) }),
    },
  };

  const telemetry = new Telemetry({ enabled: true, serviceName: 'test-svc', api });
  assert.equal(telemetry.enabled, true);

  const value = await telemetry.span('stage.run', {
    stage: 'tts', count: 2, dropNull: null, dropUndef: undefined, config: { a: 1 },
  }, async () => 'ok');

  assert.equal(value, 'ok');
  assert.equal(spans.length, 1);
  const span = spans[0];
  assert.equal(span.attributes.stage, 'tts');
  assert.equal(span.attributes.count, 2);
  assert.equal(span.attributes.dropNull, undefined, 'null attributes are dropped');
  assert.equal(span.attributes.dropUndef, undefined, 'undefined attributes are dropped');
  assert.equal(span.attributes.config, '{"a":1}', 'objects are serialized');
  assert.equal(span.ended, true);
  assert.equal(telemetry.currentTraceId(), 'trace-1');
});

test('Telemetry records an exception and marks the span failed, then rethrows', async () => {
  const spans = [];
  const api = {
    trace: {
      getTracer: () => ({
        startActiveSpan: (name, fn) => {
          const span = {
            exceptions: [], status: null, ended: false,
            setAttribute() {}, setAttributes() {}, addEvent() {},
            recordException(err) { this.exceptions.push(err); },
            setStatus(s) { this.status = s; },
            end() { this.ended = true; },
            spanContext: () => ({}),
          };
          spans.push(span);
          return fn(span);
        },
      }),
      getActiveSpan: () => null,
    },
  };

  const telemetry = new Telemetry({ enabled: true, api });
  const boom = new Error('failed stage');
  await assert.rejects(() => telemetry.span('stage', {}, async () => { throw boom; }), /failed stage/);

  const span = spans[0];
  assert.equal(span.exceptions.length, 1);
  assert.equal(span.exceptions[0], boom);
  assert.equal(span.status.code, 2);
  assert.equal(span.ended, true, 'the span must be ended even on failure');
});

test('an enabled Telemetry without the OTel API falls back to no-op safely', () => {
  // Simulate the package being absent by injecting an explicit null API.
  const telemetry = new Telemetry({ enabled: true, api: null });
  // tryLoadOtelApi is used when api is null, so this depends on whether
  // @opentelemetry/api is installed. Either way the object must be usable.
  assert.equal(typeof telemetry.enabled, 'boolean');
  assert.doesNotThrow(() => telemetry.currentTraceId());
  assert.equal(typeof telemetry.span, 'function');
});

test('createTelemetry derives settings from config', () => {
  assert.equal(createTelemetry({ observability: { otelEnabled: false } }).enabled, false);
  assert.equal(createTelemetry({}).enabled, false);
  assert.equal(createTelemetry({}).serviceName, 'youtube-dub');
  assert.equal(
    createTelemetry({ observability: { otelServiceName: 'custom-svc' } }).serviceName,
    'custom-svc',
  );
});
