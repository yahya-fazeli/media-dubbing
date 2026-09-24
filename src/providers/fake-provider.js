import { encodeWav, toMono } from '../core/wav.js';
import { ProviderError, ErrorCode, ValidationError } from '../core/errors.js';
import { assertLanguage, assertNonEmpty } from './provider.js';

/**
 * Offline provider used for tests, demos, and air-gapped runs. It produces
 * deterministic output derived from its inputs so artifact reuse and timing math
 * can be verified exactly. It is deliberately not a language model.
 *
 * `failureRate` and `failuresOn` allow tests to exercise retry and recovery
 * paths on purpose.
 */
export class FakeProvider {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger ?? { debug() {} };
    this.name = 'fake';
    this.settings = config.providers.fake;
    this.calls = { transcribe: 0, translate: 0, synthesize: 0 };
    /** Map of segmentId -> remaining forced failures, set by tests. */
    this.forcedFailures = new Map();
    this.transcriptOverride = null;
  }

  /** Forces the next N synthesis calls for a segment to fail. */
  failNextSynthesis(segmentId, times = 1) {
    this.forcedFailures.set(segmentId, (this.forcedFailures.get(segmentId) ?? 0) + times);
  }

  async transcribe(input, options = {}) {
    this.calls.transcribe += 1;
    await this.#delay(options.signal);
    const durationSeconds = Number(options.durationSeconds ?? 10);
    if (this.transcriptOverride) {
      return {
        language: options.language ?? 'en',
        durationSeconds,
        words: this.transcriptOverride,
        model: 'fake-transcriber',
        provider: this.name,
      };
    }
    return {
      language: options.language ?? 'en',
      durationSeconds,
      words: this.#buildWords(durationSeconds, options.language ?? 'en'),
      model: 'fake-transcriber',
      provider: this.name,
    };
  }

  async translate(segments, options = {}) {
    const targetLanguage = assertLanguage(options.targetLanguage, 'targetLanguage');
    const sourceLanguage = assertLanguage(options.sourceLanguage ?? 'en', 'sourceLanguage');
    this.calls.translate += 1;
    await this.#delay(options.signal);

    return segments.map((segment) => {
      assertNonEmpty(segment.text, 'segment.text');
      return {
        segmentId: segment.segmentId,
        text: this.#fakeTranslate(segment.text, targetLanguage),
        sourceText: segment.text,
        confidence: 0.9,
        model: 'fake-translator',
        provider: this.name,
        sourceLanguage,
        targetLanguage,
      };
    });
  }

  async synthesize(text, options = {}) {
    const segmentId = options.segmentId ?? 'unknown';
    assertNonEmpty(text, 'text');
    assertLanguage(options.targetLanguage ?? 'en', 'targetLanguage');
    this.calls.synthesize += 1;

    const forced = this.forcedFailures.get(segmentId) ?? 0;
    if (forced > 0) {
      this.forcedFailures.set(segmentId, forced - 1);
      throw new ProviderError('Forced synthesis failure for testing', {
        code: ErrorCode.TTS_ERROR,
        retryable: true,
        recoveryScope: 'segment',
        segmentId,
      });
    }
    if (this.settings.failureRate > 0 && Math.random() < this.settings.failureRate) {
      throw new ProviderError('Random synthesis failure', {
        code: ErrorCode.TTS_ERROR,
        retryable: true,
        recoveryScope: 'segment',
        segmentId,
      });
    }

    await this.#delay(options.signal);
    const sampleRate = options.sampleRate ?? this.config.pipeline.targetSampleRate;
    // Roughly 150ms per character, bounded, so durations track text length and
    // timing/fit logic has something meaningful to work with.
    const targetSeconds = options.targetDurationSeconds
      ?? Math.max(0.6, Math.min(30, text.length * 0.15));
    const samples = this.#speechLike(text, targetSeconds, sampleRate);
    const wav = encodeWav({ samples, sampleRate, channels: 1 });
    return {
      audio: wav,
      sampleRate,
      channels: 1,
      durationSeconds: samples.length / sampleRate,
      voice: options.voice ?? 'fake-voice',
      model: 'fake-tts',
      provider: this.name,
      text,
    };
  }

  /** Deterministic pseudo-speech: vowel-like tones with syllable envelopes. */
  #speechLike(text, durationSeconds, sampleRate) {
    const frames = Math.max(1, Math.round(durationSeconds * sampleRate));
    const samples = new Int16Array(frames);
    let h = 2166136261;
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    const base = 130 + (h % 90);
    const syllables = Math.max(1, Math.round(text.length / 3));
    const syllableFrames = frames / syllables;
    for (let f = 0; f < frames; f += 1) {
      const syllable = Math.floor(f / syllableFrames);
      const posInSyllable = (f % syllableFrames) / syllableFrames;
      const envelope = Math.sin(Math.PI * posInSyllable) ** 0.7;
      const t = f / sampleRate;
      const pitch = base * (1 + 0.05 * ((syllable * 7) % 5));
      samples[f] = Math.round(
        32767 * 0.28 * envelope
          * (0.7 * Math.sin(2 * Math.PI * pitch * t) + 0.3 * Math.sin(2 * Math.PI * pitch * 2 * t)),
      );
    }
    return samples;
  }

  #buildWords(durationSeconds, language) {
    const words = [];
    const speakingRate = 2.6; // words per second
    const total = Math.max(1, Math.round(durationSeconds * speakingRate));
    const step = durationSeconds / total;
    for (let i = 0; i < total; i += 1) {
      const start = i * step;
      const end = Math.min(durationSeconds, start + step * 0.9);
      words.push({
        text: `word${i + 1}`,
        start,
        end,
        confidence: 0.95,
        punctuated: i === total - 1,
      });
    }
    return words.map((w) => ({
      ...w,
      text: language === 'en' ? w.text : `[${language}]${w.text}`,
    }));
  }

  #fakeTranslate(text, targetLanguage) {
    const tokens = text.split(/\s+/).filter(Boolean);
    const transformed = tokens.map((token, i) => {
      if (/[.!?]$/.test(token)) return token;
      return i % 4 === 3 ? `${token},` : token;
    });
    const joined = transformed.join(' ');
    return `[${targetLanguage}] ${joined}`;
  }

  async #delay(signal) {
    const ms = this.settings.latencyMs;
    if (!ms) return;
    if (signal?.aborted) {
      const err = new ValidationError('Cancelled');
      err.code = ErrorCode.CANCELLED;
      throw err;
    }
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
