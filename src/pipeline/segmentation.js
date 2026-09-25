/**
 * Sentence- and pause-aware segmentation. Words from transcription are grouped
 * into segments that are (a) stable across runs given the same input, and
 * (b) bounded in duration so no single TTS request or audio window becomes
 * unreasonably large.
 *
 * Stability matters because segments are the unit of retry and reuse: if
 * re-running segmentation shuffled ids, every cached artifact would be orphaned.
 */

const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'e.g', 'i.e',
  'no', 'vol', 'fig', 'approx', 'dept', 'est', 'inc', 'ltd', 'co', 'Mt',
]);

const TERMINAL_PUNCTUATION = /[.!?。！？…]["')\]]*$/;

/**
 * @param {Array<{text:string,start:number,end:number}>} words
 * @param {object} options
 * @returns {Array<{segmentId:string,index:number,start:number,end:number,text:string,words:Array}>}
 */
export function segmentWords(words, options = {}) {
  const {
    targetSeconds = 8,
    minSeconds = 2.5,
    maxSeconds = 18,
    maxChars = 600,
  } = options;

  const usable = [];
  let prevEnd = 0;
  for (const raw of words ?? []) {
    const text = String(raw?.text ?? '').trim();
    const start = Number(raw?.start);
    const end = Number(raw?.end);
    if (!text.length || !Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Repair any residual non-monotonic timestamps so grouping cannot invert.
    // The repaired end must be carried forward, otherwise an overlapping word
    // keeps its original start and the sequence stays non-monotonic.
    const fixedStart = Math.max(prevEnd, start);
    const fixedEnd = Math.max(fixedStart + 0.01, end);
    usable.push({ text, start: fixedStart, end: fixedEnd });
    prevEnd = fixedEnd;
  }

  if (!usable.length) return [];

  const groups = [];
  let current = [];

  const flush = () => {
    if (!current.length) return;
    groups.push(current);
    current = [];
  };

  for (let i = 0; i < usable.length; i += 1) {
    const word = usable[i];
    current.push(word);

    const span = word.end - current[0].start;
    const chars = current.reduce((sum, w) => sum + w.text.length + 1, 0);
    const isLast = i === usable.length - 1;
    const endsSentence = TERMINAL_PUNCTUATION.test(word.text) && !isAbbreviation(word.text);

    // A gap in speech is the strongest natural boundary: end the segment when
    // silence and a sentence end coincide.
    const nextWord = usable[i + 1];
    const gapAfter = nextWord ? nextWord.start - word.end : 0;

    if (isLast) {
      flush();
      break;
    }
    if (endsSentence && span >= minSeconds) {
      flush();
      continue;
    }
    if (span >= maxSeconds || chars >= maxChars || span >= targetSeconds) {
      // Prefer ending before a large pause when one is available.
      flush();
      continue;
    }
    if (gapAfter > 0.8 && span >= minSeconds) {
      flush();
    }
  }
  flush();

  return groups.map((group, index) => {
    const start = group[0].start;
    const end = group[group.length - 1].end;
    return {
      segmentId: `seg_${String(index).padStart(5, '0')}`,
      index,
      start: round(start, 3),
      end: round(end, 3),
      durationSeconds: round(end - start, 3),
      text: group.map((w) => w.text).join(' '),
      words: group,
    };
  });
}

function isAbbreviation(token) {
  const stripped = token.replace(/[.!?。！？…]+$/, '').toLowerCase();
  return ABBREVIATIONS.has(stripped);
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * A stable fingerprint for a segment's source content. Used to decide whether a
 * previously generated artifact can be reused after a resume or retry.
 */
export function segmentFingerprint(segment, extra = '') {
  // Deliberately excludes the id and index: identical content at a different
  // position should still be reusable if the caller asks for content-addressed
  // reuse, and including them would defeat that.
  return [segment.text, segment.start.toFixed(3), segment.end.toFixed(3), extra].join('\u0001');
}

export { TERMINAL_PUNCTUATION };
