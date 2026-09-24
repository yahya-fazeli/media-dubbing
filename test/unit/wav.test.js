import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeWav, decodeWav, toMono, toChannels, resample, mixInto,
  fadeEdges, rms, peak, waveformPeaks, frameCount, samplesToSeconds, secondsToFrames,
} from '../../src/core/wav.js';

function tone(seconds, sampleRate = 8000, hz = 200, amplitude = 0.5) {
  const frames = Math.round(seconds * sampleRate);
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i += 1) {
    samples[i] = Math.round(amplitude * 32767 * Math.sin((2 * Math.PI * hz * i) / sampleRate));
  }
  return { samples, sampleRate, channels: 1 };
}

test('encodeWav/decodeWav round-trips mono audio losslessly', () => {
  const source = tone(1);
  const decoded = decodeWav(encodeWav(source));

  assert.equal(decoded.sampleRate, 8000);
  assert.equal(decoded.channels, 1);
  assert.equal(decoded.samples.length, source.samples.length);
  assert.ok(Math.abs(decoded.durationSeconds - 1) < 0.01);

  for (let i = 0; i < source.samples.length; i += 1) {
    assert.equal(decoded.samples[i], source.samples[i]);
  }
});

test('encodeWav/decodeWav round-trips stereo audio', () => {
  const frames = 1000;
  const samples = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    samples[i * 2] = 1000;
    samples[i * 2 + 1] = -1000;
  }
  const decoded = decodeWav(encodeWav({ samples, sampleRate: 44100, channels: 2 }));
  assert.equal(decoded.channels, 2);
  assert.equal(decoded.samples.length, frames * 2);
  assert.equal(decoded.samples[0], 1000);
  assert.equal(decoded.samples[1], -1000);
});

test('decodeWav rejects bytes that are not a WAV', () => {
  assert.throws(() => decodeWav(Buffer.from('definitely not a wav file, no RIFF here')));
});

test('decodeWav rejects a truncated header', () => {
  const valid = encodeWav(tone(0.1));
  assert.throws(() => decodeWav(valid.subarray(0, 8)));
});

test('toMono averages channels', () => {
  const stereo = new Int16Array([100, 300, -100, -300]);
  assert.deepEqual(Array.from(toMono(stereo, 2)), [200, -200]);
});

test('toChannels duplicates a mono signal across the requested channels', () => {
  const out = toChannels(new Int16Array([5, 6]), 2);
  assert.deepEqual(Array.from(out), [5, 5, 6, 6]);
});

test('resample changes length proportionally to the rate ratio', () => {
  const source = tone(1, 8000);
  const up = resample(source.samples, 8000, 16000, 1);
  assert.ok(Math.abs(up.length - 16000) <= 2, `got ${up.length}`);
  const down = resample(source.samples, 8000, 4000, 1);
  assert.ok(Math.abs(down.length - 4000) <= 2, `got ${down.length}`);
});

test('resample is a no-op when rates match', () => {
  const source = tone(0.25, 8000);
  assert.equal(resample(source.samples, 8000, 8000, 1).length, source.samples.length);
});

test('mixInto places a clip at a frame offset and sums it', () => {
  const timeline = new Int16Array(10);
  timeline[3] = 100;
  mixInto(timeline, new Int16Array([10, 20, 30]), 2, 1);
  assert.deepEqual(Array.from(timeline), [0, 0, 10, 120, 30, 0, 0, 0, 0, 0]);
});

test('mixInto applies gain', () => {
  const timeline = new Int16Array(4);
  mixInto(timeline, new Int16Array([100, 200]), 0, 0.5);
  assert.deepEqual(Array.from(timeline), [50, 100, 0, 0]);
});

test('mixInto clamps on overflow instead of wrapping', () => {
  const timeline = new Int16Array([30000, -30000]);
  mixInto(timeline, new Int16Array([30000, -30000]), 0, 1);
  assert.deepEqual(Array.from(timeline), [32767, -32768]);
});

test('fadeEdges attenuates the leading and trailing fade windows', () => {
  const samples = new Int16Array(200).fill(10000);
  const faded = fadeEdges(samples, 1, 10);
  // The fade-in ramps from silence at index 0 to full level at the end of the
  // window; the fade-out mirrors it, so the mirrored index is what shrinks.
  assert.equal(faded[0], 0);
  assert.ok(faded[5] > 0 && faded[5] < 10000);
  assert.equal(faded[100], 10000);
  assert.ok(faded[190] < 10000 && faded[190] > 0);
});

test('rms and peak describe signal level', () => {
  const constant = new Int16Array(100).fill(16384);
  assert.ok(Math.abs(peak(constant) - 0.5) < 0.001);
  assert.ok(Math.abs(rms(constant) - 0.5) < 0.001);
  assert.equal(rms(new Int16Array(100)), 0);
});

test('waveformPeaks returns a normalized peak envelope', () => {
  const source = tone(0.5, 8000);
  const peaks = waveformPeaks(source.samples, 1, 32);
  assert.equal(peaks.length, 32);
  assert.ok(peaks.every((p) => p.peak >= 0 && p.peak <= 1));
  assert.ok(peaks.every((p) => typeof p.startFrame === 'number'));
  assert.ok(peaks[0].peak > 0.4, 'a 0.5-amplitude tone should produce a substantial peak');
});

test('frame and seconds conversions are consistent', () => {
  assert.equal(frameCount(new Int16Array(20), 2), 10);
  assert.equal(samplesToSeconds(8000, 8000, 1), 1);
  assert.equal(secondsToFrames(1, 8000), 8000);
});
