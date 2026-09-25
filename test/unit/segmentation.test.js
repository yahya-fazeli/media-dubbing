import { test } from 'node:test';
import assert from 'node:assert/strict';
import { segmentWords, segmentFingerprint, TERMINAL_PUNCTUATION } from '../../src/pipeline/segmentation.js';

/** Builds evenly spaced words at a fixed rate, e.g. 2 words per second. */
function wordsFrom(tokens, { start = 0, perWord = 0.5 } = {}) {
  return tokens.map((text, i) => ({
    text,
    start: start + i * perWord,
    end: start + (i + 1) * perWord,
  }));
}

test('segmentWords assigns stable, zero-padded ids in order', () => {
  const segments = segmentWords(wordsFrom(['one.', 'two.', 'three.']), { minSeconds: 0.1 });

  assert.deepEqual(segments.map((s) => s.segmentId), ['seg_00000', 'seg_00001', 'seg_00002']);
  assert.deepEqual(segments.map((s) => s.index), [0, 1, 2]);
});

test('segmentation is deterministic for identical input', () => {
  // Segment ids are the unit of retry and reuse, so identical input must produce
  // identical segments or every cached artifact would be orphaned.
  const input = wordsFrom(['alpha beta.', 'gamma delta.', 'epsilon zeta.']);
  const a = segmentWords(input, { minSeconds: 0.1 });
  const b = segmentWords(input, { minSeconds: 0.1 });
  assert.deepEqual(a, b);
});

test('segmentWords returns nothing for empty or unusable input', () => {
  assert.deepEqual(segmentWords([]), []);
  assert.deepEqual(segmentWords(null), []);
  assert.deepEqual(segmentWords([{ text: '   ', start: 0, end: 1 }]), []);
  assert.deepEqual(segmentWords([{ text: 'a', start: NaN, end: 1 }]), []);
  assert.deepEqual(segmentWords([{ text: 'a', start: 0, end: Infinity }]), []);
});

test('segmentWords repairs non-monotonic word timestamps', () => {
  // Overlapping words must be pushed forward; otherwise segment windows invert.
  const segments = segmentWords([
    { text: 'a', start: 0, end: 0.5 },
    { text: 'b', start: 0.2, end: 0.3 },
    { text: 'c', start: 0.25, end: 0.4 },
  ], { targetSeconds: 100, minSeconds: 99, maxSeconds: 100, maxChars: 9999 });

  const words = segments[0].words;
  assert.equal(words.length, 3);
  for (let i = 1; i < words.length; i += 1) {
    assert.ok(
      words[i].start >= words[i - 1].end,
      `word ${i} starts before the previous ends: ${JSON.stringify(words)}`,
    );
  }
  assert.ok(words.every((w) => w.end > w.start));
});

test('segmentWords splits on sentence-ending punctuation', () => {
  // Two sentences separated by a pause should not share a segment.
  const words = [
    { text: 'Hello', start: 0, end: 0.4 },
    { text: 'there.', start: 0.4, end: 1.0 },
    { text: 'Second', start: 3.0, end: 3.4 },
    { text: 'sentence.', start: 3.4, end: 4.0 },
  ];
  const segments = segmentWords(words, { minSeconds: 0.5 });

  assert.equal(segments.length, 2);
  assert.equal(segments[0].text, 'Hello there.');
  assert.equal(segments[1].text, 'Second sentence.');
});

test('segmentWords does not split on abbreviations', () => {
  const words = [
    { text: 'Meet', start: 0, end: 0.4 },
    { text: 'Dr.', start: 0.4, end: 0.9 },
    { text: 'Smith', start: 0.9, end: 1.4 },
    { text: 'now.', start: 1.4, end: 2.0 },
  ];
  const segments = segmentWords(words, { minSeconds: 0.5 });

  assert.equal(segments.length, 1, `abbreviation caused a split: ${JSON.stringify(segments.map((s) => s.text))}`);
  assert.equal(segments[0].text, 'Meet Dr. Smith now.');
});

test('segmentWords respects the maximum duration', () => {
  const words = wordsFrom(Array.from({ length: 40 }, (_, i) => `w${i}`), { perWord: 1 });
  const segments = segmentWords(words, { maxSeconds: 5, minSeconds: 1, targetSeconds: 100 });

  for (const segment of segments) {
    // A segment may exceed max only by the final word that crossed the boundary.
    assert.ok(segment.durationSeconds <= 6, `segment ran ${segment.durationSeconds}s, over maxSeconds`);
  }
  assert.ok(segments.length > 1, 'long input must be split');
});

test('segmentWords respects the character budget', () => {
  const words = wordsFrom(Array.from({ length: 30 }, () => 'longword'), { perWord: 0.2 });
  const segments = segmentWords(words, { maxChars: 50, targetSeconds: 100, maxSeconds: 100, minSeconds: 0.1 });

  for (const segment of segments) {
    assert.ok(segment.text.length <= 60, `segment had ${segment.text.length} chars, over budget`);
  }
  assert.ok(segments.length > 1);
});

test('segmentWords splits on a long pause even without punctuation', () => {
  const words = [
    { text: 'first', start: 0, end: 0.5 },
    { text: 'part', start: 0.5, end: 1.0 },
    { text: 'second', start: 5.0, end: 5.5 },
    { text: 'part', start: 5.5, end: 6.0 },
  ];
  const segments = segmentWords(words, { minSeconds: 0.5, targetSeconds: 100, maxSeconds: 100, maxChars: 9999 });

  assert.equal(segments.length, 2, `expected a pause split, got ${JSON.stringify(segments.map((s) => s.text))}`);
});

test('segment boundaries are contiguous and non-overlapping', () => {
  const segments = segmentWords(wordsFrom(Array.from({ length: 25 }, (_, i) => (i % 7 === 6 ? `w${i}.` : `w${i}`)), { perWord: 0.7 }), { minSeconds: 1 });

  for (let i = 1; i < segments.length; i += 1) {
    assert.ok(
      segments[i].start >= segments[i - 1].end,
      `segment ${i} starts at ${segments[i].start} before segment ${i - 1} ends at ${segments[i - 1].end}`,
    );
  }
});

test('segment duration and rounded fields are consistent', () => {
  const segments = segmentWords(wordsFrom(['a.', 'b.', 'c.']), { minSeconds: 0.1 });
  for (const segment of segments) {
    assert.equal(segment.durationSeconds, Number((segment.end - segment.start).toFixed(3)));
    assert.equal(segment.start, Number(segment.start.toFixed(3)));
    assert.equal(segment.end, Number(segment.end.toFixed(3)));
  }
});

test('segment text is the joined word texts', () => {
  const segments = segmentWords(wordsFrom(['alpha', 'beta.', 'gamma']), { minSeconds: 0.1 });
  for (const segment of segments) {
    assert.equal(segment.text, segment.words.map((w) => w.text).join(' '));
  }
});

test('TERMINAL_PUNCTUATION recognizes sentence ends across scripts', () => {
  assert.ok(TERMINAL_PUNCTUATION.test('end.'));
  assert.ok(TERMINAL_PUNCTUATION.test('end!'));
  assert.ok(TERMINAL_PUNCTUATION.test('end?'));
  assert.ok(TERMINAL_PUNCTUATION.test('end。'));
  assert.ok(TERMINAL_PUNCTUATION.test('end…'));
  assert.ok(!TERMINAL_PUNCTUATION.test('end'));
  assert.ok(!TERMINAL_PUNCTUATION.test('end,'));
});

test('segmentFingerprint is stable and ignores id and index', () => {
  const segment = { text: 'hello world', start: 1.5, end: 3.25 };
  const withMeta = { ...segment, segmentId: 'seg_00042', index: 42 };

  assert.equal(segmentFingerprint(segment), segmentFingerprint(withMeta));
  assert.equal(segmentFingerprint(segment), segmentFingerprint({ ...segment }));
});

test('segmentFingerprint changes when content or timing changes', () => {
  const base = { text: 'hello', start: 0, end: 1 };
  assert.notEqual(segmentFingerprint(base), segmentFingerprint({ ...base, text: 'hello!' }));
  assert.notEqual(segmentFingerprint(base), segmentFingerprint({ ...base, start: 0.5 }));
  assert.notEqual(segmentFingerprint(base), segmentFingerprint({ ...base, end: 2 }));
});

test('segmentFingerprint incorporates the extra discriminator', () => {
  const segment = { text: 'hello', start: 0, end: 1 };
  assert.notEqual(segmentFingerprint(segment, 'es'), segmentFingerprint(segment, 'fr'));
  assert.notEqual(segmentFingerprint(segment, 'es'), segmentFingerprint(segment));
});
