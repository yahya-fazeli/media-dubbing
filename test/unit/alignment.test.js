import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alignSegment, fitSegmentToWindow, gradeFit } from '../../src/pipeline/alignment.js';
import { encodeWav, decodeWav } from '../../src/core/wav.js';

// Alignment works on decoded PCM objects, so every fixture round-trips through
// the WAV codec first.
function tone(seconds, sampleRate = 16000, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * 200 * i) / sampleRate));
  }
  return decodeWav(encodeWav({ samples, sampleRate, channels: 1 }));
}

test('alignSegment measures speech against a larger window as underflow', () => {
  const result = alignSegment(tone(2.5), { windowStart: 0, windowEnd: 4, sampleRate: 16000 });

  assert.ok(Math.abs(result.speechSeconds - 2.5) < 0.05);
  assert.ok(Math.abs(result.windowSeconds - 4) < 0.001);
  assert.ok(result.driftSeconds < 0, 'speech shorter than the window is negative drift');
  assert.ok(result.underflowSeconds > 0);
  assert.equal(result.overflowSeconds, 0);
  assert.equal(result.feasible, true, 'a slow-down within tempo bounds should be feasible');
});

test('alignSegment marks speech too short to stretch as infeasible', () => {
  // 2s of speech into a 4s window needs a 0.5x tempo, below the 0.6 floor.
  const result = alignSegment(tone(2), { windowStart: 0, windowEnd: 4, sampleRate: 16000 });
  assert.equal(result.feasible, false);
  assert.equal(result.clampedTempo, 0.6);
});

test('alignSegment reports overflow when speech overruns the window', () => {
  const result = alignSegment(tone(6), { windowEnd: 4, sampleRate: 16000 });

  assert.ok(result.driftSeconds > 0);
  assert.ok(result.overflowSeconds > 0);
  assert.equal(result.underflowSeconds, 0);
  assert.equal(result.feasible, true, 'a 1.5x speed-up is inside the tempo bounds');
  assert.ok(result.requiredTempo > 1.4 && result.requiredTempo < 1.6);
});

test('alignSegment marks speech too long to compress as infeasible', () => {
  const result = alignSegment(tone(9), { windowEnd: 4, sampleRate: 16000 });
  assert.equal(result.feasible, false, 'a 2.25x speed-up exceeds the ceiling');
  assert.equal(result.clampedTempo, 1.6);
});

test('alignSegment clamps required tempo to the configured bounds', () => {
  const result = alignSegment(tone(10), { windowEnd: 2, sampleRate: 16000, minTempo: 0.6, maxTempo: 1.6 });
  assert.equal(result.clampedTempo, 1.6);
  assert.ok(result.requiredTempo > 1.6);
});

test('alignSegment flags digital silence as failing quality', () => {
  const silent = decodeWav(encodeWav({ samples: new Int16Array(16000), sampleRate: 16000, channels: 1 }));
  const result = alignSegment(silent, { windowEnd: 1, sampleRate: 16000 });
  assert.equal(result.quality.silenceRatio > 0.95, true);
  assert.equal(gradeFit(result).grade, 'fail');
});

test('fitSegmentToWindow speeds up speech that overruns the window', () => {
  const fitted = fitSegmentToWindow(tone(4), { windowSeconds: 2, sampleRate: 16000 });
  assert.ok(fitted.appliedTempo > 1);
  assert.equal(fitted.action, 'speed-up');
  assert.ok(Math.abs(fitted.finalSeconds - 2) < 0.02, `final ${fitted.finalSeconds}s`);
  assert.equal(fitted.fits, true);
  assert.ok(Buffer.isBuffer(fitted.wav) || fitted.wav instanceof Uint8Array);
});

test('fitSegmentToWindow slows down speech that underruns the window', () => {
  const fitted = fitSegmentToWindow(tone(1), { windowSeconds: 1.5, sampleRate: 16000 });
  assert.ok(fitted.appliedTempo < 1);
  assert.equal(fitted.action, 'slow-down');
  assert.ok(Math.abs(fitted.finalSeconds - 1.5) < 0.02);
});

test('fitSegmentToWindow stretches up to the tempo ceiling without trimming', () => {
  // 20s into a 2s window wants 10x; the 1.6x ceiling still resamples to exactly
  // the target length, so nothing is trimmed and the segment is reported as fit.
  const fitted = fitSegmentToWindow(tone(20), { windowSeconds: 2, sampleRate: 16000, maxTempo: 1.6 });
  assert.equal(fitted.appliedTempo, 1.6);
  assert.equal(fitted.action, 'speed-up');
  assert.equal(fitted.trimmedSeconds, 0);
  assert.equal(fitted.fits, true);
});

test('fitSegmentToWindow trims a slight overrun that needs no tempo change', () => {
  // A 2% overrun is inside the "not worth re-timing" deadband, so the tail is cut.
  const fitted = fitSegmentToWindow(tone(2.04), { windowSeconds: 2, sampleRate: 16000 });
  assert.equal(fitted.appliedTempo, 1);
  assert.equal(fitted.action, 'trim');
  assert.ok(fitted.trimmedSeconds > 0);
  assert.equal(fitted.fits, false);
});

test('fitSegmentToWindow pads without re-timing when speech already fits', () => {
  const fitted = fitSegmentToWindow(tone(2), { windowSeconds: 2.02, sampleRate: 16000 });
  assert.equal(fitted.appliedTempo, 1);
  assert.ok(fitted.action === 'pad' || fitted.action === 'none');
  assert.ok(Math.abs(fitted.finalSeconds - 2.02) < 0.02);
});

test('fitSegmentToWindow output length matches the exact target frame count', () => {
  const fitted = fitSegmentToWindow(tone(3), { windowSeconds: 1.25, sampleRate: 16000 });
  assert.equal(fitted.samples.length, Math.round(1.25 * 16000));
});

test('gradeFit classifies fit quality from drift ratio', () => {
  assert.equal(gradeFit({ driftSeconds: 0, windowSeconds: 8, quality: {} }).grade, 'ok');
  assert.equal(gradeFit({ driftSeconds: 2, windowSeconds: 8, quality: {} }).grade, 'warn');
  assert.equal(gradeFit({ driftSeconds: 6, windowSeconds: 8, quality: {} }).grade, 'fail');
  assert.equal(gradeFit(null).grade, 'unknown');
});
