import { contentHash } from '../core/ids.js';

/**
 * Voice assignment. A segment's voice must be stable across retries and resumes,
 * otherwise re-synthesized audio would not match its neighbors. Assignment is
 * therefore derived deterministically from the segment's stable content and the
 * job's configured voice list.
 */
export function voiceForSegment(context, segment) {
  const voices = context.job.settings.voices ?? [];
  if (!voices.length) return null;
  if (segment.voice && voices.includes(segment.voice)) return segment.voice;
  // Hash the segment id rather than its position so a re-segmentation that
  // preserves ids also preserves voices.
  const hash = contentHash(segment.segmentId, context.job.languages.target);
  const index = Number.parseInt(hash.slice(0, 8), 16) % voices.length;
  return voices[index];
}

/**
 * Fingerprint of everything that affects a segment's synthesized audio. If any
 * of these change, cached audio must be regenerated.
 */
export function ttsFingerprint(context, segment) {
  return contentHash(
    segment.translatedText ?? '',
    context.job.languages.target,
    voiceForSegment(context, segment) ?? '',
    context.provider.name,
    context.config.pipeline.targetSampleRate,
  );
}

export function voiceRotation(voices, count) {
  if (!voices?.length) return [];
  return Array.from({ length: count }, (_, i) => voices[i % voices.length]);
}
