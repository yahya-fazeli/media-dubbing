import { decodeWav, encodeWav, toMono, resample, fadeEdges, rms, peak } from '../core/wav.js';

/**
 * Alignment measures the synthesized speech against the segment window it must
 * occupy. It answers three questions the UI and the timing stage both need:
 *
 *   1. How long is the generated audio relative to the window?
 *   2. How far off is the fit, in seconds and as a ratio?
 *   3. Is the audio non-silent and within a sane level range?
 *
 * Alignment never modifies samples; it only describes them.
 */

export function alignSegment(audio, options = {}) {
  const {
    windowStart = 0,
    windowEnd = 0,
    sampleRate = 44100,
    minTempo = 0.6,
    maxTempo = 1.6,
  } = options;

  const windowSeconds = Math.max(0, windowEnd - windowStart);
  const decoded = typeof audio === 'string' ? decodeWav(audio) : audio;
  const mono = toMono(decoded.samples, decoded.channels);
  const normalized = decoded.sampleRate === sampleRate
    ? mono
    : resample(mono, decoded.sampleRate, sampleRate, 1);

  const speechSeconds = normalized.length / sampleRate;
  const drift = speechSeconds - windowSeconds;
  const ratio = windowSeconds > 0 ? speechSeconds / windowSeconds : 1;

  // Tempo is the playback rate needed to make speech exactly fill the window.
  // Clamping it tells the timing stage whether stretching can absorb the drift.
  const rawTempo = speechSeconds > 0 ? speechSeconds / windowSeconds : 1;
  const requiredTempo = windowSeconds > 0 ? rawTempo : 1;
  const clampedTempo = Math.min(maxTempo, Math.max(minTempo, requiredTempo || 1));
  const feasible = windowSeconds > 0
    && requiredTempo >= minTempo - 1e-9
    && requiredTempo <= maxTempo + 1e-9;

  const quality = {
    rms: round(rms(normalized), 5),
    peak: round(peak(normalized), 5),
    silenceRatio: round(silenceRatio(normalized, sampleRate), 4),
    clipped: peak(normalized) >= 0.999,
  };

  return {
    sampleRate,
    samples: normalized,
    speechSeconds: round(speechSeconds, 3),
    windowSeconds: round(windowSeconds, 3),
    driftSeconds: round(drift, 3),
    fitRatio: round(ratio, 4),
    requiredTempo: round(requiredTempo, 4),
    clampedTempo: round(clampedTempo, 4),
    feasible,
    overflowSeconds: round(Math.max(0, drift), 3),
    underflowSeconds: round(Math.max(0, -drift), 3),
    quality,
  };
}

/**
 * Fits speech into a window by resampling (a tempo change). Resampling is used
 * rather than a real time-stretch because it needs no extra dependency; the
 * duration change is exact and speech remains intelligible at the bounded rates
 * the pipeline allows.
 *
 * Returns the fitted PCM plus a description of what was applied, including
 * whether the result still overshoots and must be trimmed or padded.
 */
export function fitSegmentToWindow(speech, options = {}) {
  const {
    windowSeconds,
    sampleRate = 44100,
    minTempo = 0.6,
    maxTempo = 1.6,
    minPaddingSeconds = 0.05,
    respectNaturalPauses = true,
  } = options;

  const decoded = typeof speech === 'string' ? decodeWav(speech) : speech;
  const mono = toMono(decoded.samples, decoded.channels);
  const base = decoded.sampleRate === sampleRate
    ? mono
    : resample(mono, decoded.sampleRate, sampleRate, 1);

  const speechSeconds = base.length / sampleRate;
  if (!(windowSeconds > 0)) {
    return {
      samples: base,
      sampleRate,
      appliedTempo: 1,
      action: 'none',
      speechSeconds: round(speechSeconds, 3),
      finalSeconds: round(speechSeconds, 3),
      trimmedSeconds: 0,
      paddedSeconds: 0,
      fits: false,
    };
  }

  const desiredTempo = speechSeconds / windowSeconds;
  // Only stretch when the drift is meaningful; tiny corrections are not worth
  // the audio artifacts they introduce.
  const meaningful = Math.abs(1 - desiredTempo) > 0.03;
  const tempo = meaningful
    ? Math.min(maxTempo, Math.max(minTempo, desiredTempo))
    : 1;

  // Stretching is done by resampling to an exact target frame count so the
  // tempo math is precise rather than approximate.
  const targetFrames = Math.round(windowSeconds * sampleRate);
  let samples = tempo === 1 ? base : resampleToLength(base, targetFrames);

  const actualFrames = samples.length;
  let action = tempo === 1 ? 'none' : (tempo > 1 ? 'speed-up' : 'slow-down');
  let trimmedSeconds = 0;
  let paddedSeconds = 0;
  let final = samples;

  if (respectNaturalPauses && tempo === 1 && actualFrames < targetFrames) {
    // When no stretch is needed, center the speech rather than front-loading it,
    // which sounds more natural against the original scene.
    const padFrames = targetFrames - actualFrames;
    const lead = Math.floor(padFrames / 2);
    final = padFrames > sampleRate * minPaddingSeconds
      ? padTo(final, targetFrames, lead)
      : padTo(final, targetFrames, 0);
    paddedSeconds = (targetFrames - actualFrames) / sampleRate;
    action = 'pad';
  } else if (actualFrames > targetFrames) {
    // Stretching hit the tempo ceiling and the speech still runs long, so the
    // tail is trimmed. This is logged as a fit problem for quality reporting.
    final = final.subarray(0, targetFrames);
    trimmedSeconds = (actualFrames - targetFrames) / sampleRate;
    action = 'trim';
  } else if (actualFrames < targetFrames) {
    final = padTo(final, targetFrames, 0);
    paddedSeconds = (targetFrames - actualFrames) / sampleRate;
    action = action === 'none' ? 'pad' : `${action}+pad`;
  }

  final = fadeEdges(final, 1, Math.round(sampleRate * 0.008));

  return {
    samples: final,
    sampleRate,
    appliedTempo: round(tempo, 4),
    action,
    speechSeconds: round(speechSeconds, 3),
    finalSeconds: round(final.length / sampleRate, 3),
    trimmedSeconds: round(trimmedSeconds, 3),
    paddedSeconds: round(paddedSeconds, 3),
    fits: trimmedSeconds === 0,
    wav: encodeWav({ samples: final, sampleRate, channels: 1 }),
  };
}

/** Resamples to an exact frame count, avoiding rounding drift. */
function resampleToLength(samples, targetFrames) {
  if (samples.length === targetFrames) return samples;
  const out = new Int16Array(targetFrames);
  const ratio = samples.length / targetFrames;
  for (let i = 0; i < targetFrames; i += 1) {
    const srcPos = i * ratio;
    const i0 = Math.floor(srcPos);
    const i1 = Math.min(samples.length - 1, i0 + 1);
    const frac = srcPos - i0;
    const a = samples[i0] ?? 0;
    const b = samples[i1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

function padTo(samples, targetFrames, leadFrames) {
  if (samples.length >= targetFrames) return samples.subarray(0, targetFrames);
  const out = new Int16Array(targetFrames);
  out.set(samples, Math.min(leadFrames, targetFrames - samples.length));
  return out;
}

/** Fraction of small frames that are effectively silent. */
function silenceRatio(samples, sampleRate) {
  const frame = Math.max(1, Math.round(sampleRate * 0.02));
  let silent = 0;
  let total = 0;
  for (let i = 0; i < samples.length; i += frame) {
    let sum = 0;
    const end = Math.min(samples.length, i + frame);
    for (let j = i; j < end; j += 1) sum += samples[j] * samples[j];
    const frameRms = Math.sqrt(sum / (end - i)) / 32768;
    if (frameRms < 0.005) silent += 1;
    total += 1;
  }
  return total ? silent / total : 0;
}

/**
 * Grades fit quality for reporting. Thresholds are intentionally lenient because
 * a slightly long segment that was trimmed is a normal outcome, not a defect.
 */
export function gradeFit(alignment, options = {}) {
  const { warnRatio = 0.25, failRatio = 0.6 } = options;
  const drift = Math.abs(alignment?.driftSeconds ?? 0);
  const windowSeconds = alignment?.windowSeconds ?? 0;
  const ratio = windowSeconds > 0 ? drift / windowSeconds : 0;

  if (!alignment) return { grade: 'unknown', ratio: 0, reason: 'No alignment information.' };
  if (alignment.quality?.silenceRatio > 0.95) {
    return { grade: 'fail', ratio, reason: 'Generated speech is almost entirely silent.' };
  }
  if (alignment.quality?.clipped) {
    return { grade: 'warn', ratio, reason: 'Generated speech is clipped.' };
  }
  if (ratio >= failRatio) {
    return { grade: 'fail', ratio, reason: 'Speech duration is far outside the segment window.' };
  }
  if (ratio >= warnRatio) {
    return { grade: 'warn', ratio, reason: 'Speech required significant stretching or trimming.' };
  }
  return { grade: 'ok', ratio, reason: 'Speech fits the segment window.' };
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
