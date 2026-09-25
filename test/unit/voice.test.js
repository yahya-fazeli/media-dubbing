import { test } from 'node:test';
import assert from 'node:assert/strict';
import { voiceForSegment, ttsFingerprint, voiceRotation } from '../../src/pipeline/voice.js';

function makeContext({ voices = ['Kore', 'Puck'], target = 'es', providerName = 'gemini', sampleRate = 44100 } = {}) {
  return {
    job: { settings: { voices }, languages: { target } },
    provider: { name: providerName },
    config: { pipeline: { targetSampleRate: sampleRate } },
  };
}

test('voiceForSegment is deterministic for the same segment', () => {
  // Voice must be stable across retries and resumes, or re-synthesized audio
  // would not match its neighbours.
  const context = makeContext();
  const segment = { segmentId: 'seg_00007', text: 'hola' };
  assert.equal(voiceForSegment(context, segment), voiceForSegment(context, segment));
});

test('voiceForSegment only returns a voice from the configured list', () => {
  const voices = ['Kore', 'Puck', 'Charon'];
  const context = makeContext({ voices });
  for (let i = 0; i < 50; i += 1) {
    const voice = voiceForSegment(context, { segmentId: `seg_${String(i).padStart(5, '0')}`, text: 'x' });
    assert.ok(voices.includes(voice), `got ${voice}, not in the configured list`);
  }
});

test('voiceForSegment spreads segments across the available voices', () => {
  const voices = ['Kore', 'Puck', 'Charon'];
  const context = makeContext({ voices });
  const used = new Set();
  for (let i = 0; i < 60; i += 1) {
    used.add(voiceForSegment(context, { segmentId: `seg_${String(i).padStart(5, '0')}`, text: 'x' }));
  }
  assert.ok(used.size > 1, `expected multiple voices, got ${[...used].join(',')}`);
});

test('voiceForSegment returns null when no voices are configured', () => {
  assert.equal(voiceForSegment(makeContext({ voices: [] }), { segmentId: 'seg_00001' }), null);
  assert.equal(voiceForSegment({ job: { settings: {}, languages: {} }, provider: {}, config: { pipeline: {} } }, { segmentId: 's' }), null);
});

test('voiceForSegment honours an explicit valid voice on the segment', () => {
  const context = makeContext({ voices: ['Kore', 'Puck'] });
  assert.equal(voiceForSegment(context, { segmentId: 'seg_00001', voice: 'Puck' }), 'Puck');
});

test('voiceForSegment ignores an explicit voice that is not configured', () => {
  const context = makeContext({ voices: ['Kore', 'Puck'] });
  const voice = voiceForSegment(context, { segmentId: 'seg_00001', voice: 'NotAVoice' });
  assert.ok(['Kore', 'Puck'].includes(voice), `got ${voice}`);
});

test('voiceForSegment depends on the target language', () => {
  const segment = { segmentId: 'seg_00003', text: 'x' };
  const es = voiceForSegment(makeContext({ target: 'es', voices: ['Kore', 'Puck', 'Charon'] }), segment);
  const fr = voiceForSegment(makeContext({ target: 'fr', voices: ['Kore', 'Puck', 'Charon'] }), segment);
  assert.notEqual(es, fr, 'a different target language should be able to select a different voice');
});

test('ttsFingerprint is stable for identical inputs', () => {
  const context = makeContext();
  const segment = { segmentId: 'seg_00001', translatedText: 'hola', text: 'hi' };
  assert.equal(ttsFingerprint(context, segment), ttsFingerprint(context, segment));
});

test('ttsFingerprint changes when any audio-affecting input changes', () => {
  const segment = { segmentId: 'seg_00001', translatedText: 'hola', text: 'hi' };
  const base = ttsFingerprint(makeContext(), segment);

  assert.notEqual(base, ttsFingerprint(makeContext({ target: 'fr' }), segment), 'target language');
  assert.notEqual(base, ttsFingerprint(makeContext({ voices: ['Puck'] }), segment), 'voice');
  assert.notEqual(base, ttsFingerprint(makeContext({ providerName: 'fake' }), segment), 'provider');
  assert.notEqual(base, ttsFingerprint(makeContext({ sampleRate: 24000 }), segment), 'sample rate');
  assert.notEqual(base, ttsFingerprint(makeContext(), { ...segment, translatedText: 'hola!' }), 'translated text');
});

test('ttsFingerprint ignores fields that do not affect the audio', () => {
  const context = makeContext();
  const segment = { segmentId: 'seg_00001', translatedText: 'hola', text: 'hi' };
  // The source text is not an input to synthesis, so it must not invalidate cache.
  assert.equal(ttsFingerprint(context, segment), ttsFingerprint(context, { ...segment, text: 'different source' }));
  assert.equal(ttsFingerprint(context, segment), ttsFingerprint(context, { ...segment, index: 99 }));
});

test('ttsFingerprint handles a missing translated text', () => {
  const context = makeContext();
  const a = ttsFingerprint(context, { segmentId: 'seg_00001' });
  assert.equal(typeof a, 'string');
  assert.ok(a.length > 0);
});

test('voiceRotation cycles voices in order and repeats', () => {
  assert.deepEqual(voiceRotation(['a', 'b'], 5), ['a', 'b', 'a', 'b', 'a']);
});

test('voiceRotation returns an empty list when there are no voices', () => {
  assert.deepEqual(voiceRotation([], 4), []);
  assert.deepEqual(voiceRotation(null, 4), []);
  assert.deepEqual(voiceRotation(undefined, 4), []);
});

test('voiceRotation returns nothing for a zero count', () => {
  assert.deepEqual(voiceRotation(['a', 'b'], 0), []);
});
