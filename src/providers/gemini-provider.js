import path from 'node:path';
import { GeminiClient } from './gemini-client.js';
import { ProviderError, ErrorCode, ValidationError } from '../core/errors.js';
import { assertLanguage, assertNonEmpty } from './provider.js';
import { decodeWav, encodeWav, resample, toMono } from '../core/wav.js';

/**
 * Gemini-backed provider. It builds prompts, parses structured JSON responses,
 * and normalizes the preview TTS audio payload into PCM the pipeline can mix.
 *
 * All credential handling is delegated to GeminiClient so this class never
 * touches a key directly.
 */
export class GeminiProvider {
  constructor(config, { logger, metrics, fetchImpl, random } = {}) {
    this.config = config;
    this.name = 'gemini';
    this.logger = logger ?? { debug() {}, warn() {} };
    this.client = new GeminiClient(config, { logger, metrics, fetchImpl, random });
    this.settings = config.providers.gemini;
  }

  get configured() { return this.client.configured; }

  /**
   * Transcribes audio with word-level timestamps. The audio is sent inline as
   * base64 because the preview API has a small per-request limit; larger sources
   * are handled by the pipeline transcribing windows and stitching results.
   */
  async transcribe(input, options = {}) {
    const { audioBase64, mimeType = 'audio/wav', language, durationSeconds, signal, stage } = options;
    if (!audioBase64) throw new ValidationError('transcribe requires audioBase64');
    assertLanguage(language ?? 'en', 'language');

    const prompt = [
      'Transcribe the attached audio verbatim.',
      `The spoken language is "${language}".`,
      'Return strict JSON with this exact shape:',
      '{"language":"<bcp47>","words":[{"text":"<word>","start":<seconds>,"end":<seconds>}],"text":"<full transcript>"}',
      'Rules: timestamps are seconds from the start of the audio and must be monotonic.',
      'Do not merge or drop words. Do not add commentary. Output JSON only.',
    ].join('\n');

    return this.client.generateContent({
      models: [this.settings.transcriptionModel, ...this.settings.transcriptionFallbacks],
      operation: 'transcribe',
      stage,
      signal,
      buildBody: (model) => ({
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { inlineData: { mimeType, data: audioBase64 } },
          ],
        }],
        generationConfig: {
          temperature: 0,
          responseMimeType: 'application/json',
          // Transcription must not be truncated; long audio needs headroom.
          maxOutputTokens: 65536,
        },
        model,
      }),
      parse: (json) => this.#parseTranscription(json, { language, durationSeconds }),
    });
  }

  /**
   * Translates a batch of segments in a single request so the model can use
   * cross-segment context. Returns one result per requested segment id.
   */
  async translate(segments, options = {}) {
    const sourceLanguage = assertLanguage(options.sourceLanguage ?? 'en', 'sourceLanguage');
    const targetLanguage = assertLanguage(options.targetLanguage, 'targetLanguage');
    if (!Array.isArray(segments) || segments.length === 0) return [];
    for (const segment of segments) assertNonEmpty(segment.text, 'segment.text');

    const payload = segments.map((s) => ({ id: s.segmentId, text: s.text, context: s.context ?? null }));
    const prompt = [
      `Translate each item from "${sourceLanguage}" to "${targetLanguage}".`,
      'Segments are consecutive lines of one continuous piece of speech, so keep pronouns,',
      'names, and terminology consistent across items and preserve the speaking register.',
      'Keep each translation close in length to the original so it fits the same time window.',
      'Do not merge or split items. Return strict JSON only, matching this shape:',
      '{"translations":[{"id":"<same id as input>","text":"<translated text>"}]}',
      'Input:',
      JSON.stringify({ items: payload }),
    ].join('\n');

    const result = await this.client.generateContent({
      models: [this.settings.translationModel, ...this.settings.translationFallbacks],
      operation: 'translate',
      stage: options.stage,
      segmentId: segments[0]?.segmentId,
      signal: options.signal,
      buildBody: (model) => ({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 65536 },
        model,
      }),
      parse: (json) => this.#parseTranslations(json, segments, { sourceLanguage, targetLanguage }),
    });
    return result;
  }

  /**
   * Synthesizes one segment. The preview TTS models return base64 PCM in an
   * inline data part; anything unexpected is reported as a provider error rather
   * than silently producing silence.
   */
  async synthesize(text, options = {}) {
    const targetLanguage = assertLanguage(options.targetLanguage ?? 'en', 'targetLanguage');
    assertNonEmpty(text, 'text');
    const voice = options.voice ?? this.settings.voices[0] ?? 'Kore';

    const styleHint = options.style
      ? `Speak in a ${options.style} tone.`
      : 'Speak naturally and clearly, matching a documentary narrator.';
    const prompt = [
      `Read the following text aloud in ${targetLanguage}.`,
      styleHint,
      'Lead-in pauses and sound effects are not wanted; speak only the provided text.',
      'Text:',
      text,
    ].join('\n');

    return this.client.generateContent({
      models: [this.settings.ttsModel, ...this.settings.ttsFallbacks],
      operation: 'tts',
      stage: options.stage,
      segmentId: options.segmentId,
      signal: options.signal,
      buildBody: (model) => ({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } },
          },
        },
        model,
      }),
      parse: (json, ctx) => this.#parseSpeech(json, {
        ...ctx,
        text,
        voice,
        targetLanguage,
        sampleRate: this.config.pipeline.targetSampleRate,
      }),
    });
  }

  #parseTranscription(json, { language, durationSeconds }) {
    const text = extractText(json);
    const parsed = parseJsonLoose(text);
    if (!parsed || !Array.isArray(parsed.words)) {
      throw new ProviderError('Transcription response was not the expected JSON shape', {
        code: ErrorCode.PROVIDER_ERROR,
        retryable: true,
        details: { receivedPreview: truncate(text, 400) },
      });
    }
    const limit = Number(durationSeconds ?? Number.POSITIVE_INFINITY) + 5;
    const words = parsed.words
      .map((w) => ({
        text: String(w.text ?? '').trim(),
        start: clampTime(Number(w.start), 0, limit),
        end: clampTime(Number(w.end), 0, limit),
        confidence: typeof w.confidence === 'number' ? w.confidence : null,
      }))
      // Repair any non-monotonic timestamps the model produced.
      .filter((w) => w.text.length > 0)
      .map((w, i, arr) => {
        const prevEnd = i > 0 ? arr[i - 1].end : 0;
        const start = Math.max(prevEnd, Number.isFinite(w.start) ? w.start : prevEnd);
        const end = Math.max(start + 0.01, Number.isFinite(w.end) ? w.end : start + 0.2);
        return { ...w, start, end };
      });

    if (!words.length) {
      throw new ProviderError('Transcription produced no words', {
        code: ErrorCode.PROVIDER_ERROR,
        retryable: true,
        recoveryScope: 'stage',
        recommendedAction: 'Retry transcription; the audio may be silent or too noisy.',
      });
    }

    return {
      language: String(parsed.language ?? language ?? 'en'),
      text: String(parsed.text ?? words.map((w) => w.text).join(' ')),
      words,
      durationSeconds: durationSeconds ?? (words.at(-1)?.end ?? 0),
      model: 'gemini-transcription',
      provider: this.name,
    };
  }

  #parseTranslations(json, requested, { sourceLanguage, targetLanguage }) {
    const text = extractText(json);
    const parsed = parseJsonLoose(text);
    const items = parsed?.translations;
    if (!Array.isArray(items)) {
      throw new ProviderError('Translation response was not the expected JSON shape', {
        code: ErrorCode.PROVIDER_ERROR,
        retryable: true,
        details: { receivedPreview: truncate(text, 400) },
      });
    }
    const byId = new Map(items.map((item) => [String(item.id), String(item.text ?? '')]));

    return requested.map((segment) => {
      const translated = byId.get(segment.segmentId);
      if (!translated || !translated.trim()) {
        throw new ProviderError(`Translation missing for segment ${segment.segmentId}`, {
          code: ErrorCode.PROVIDER_ERROR,
          retryable: true,
          recoveryScope: 'segment',
          segmentId: segment.segmentId,
        });
      }
      return {
        segmentId: segment.segmentId,
        text: translated.trim(),
        sourceText: segment.text,
        sourceLanguage,
        targetLanguage,
        confidence: 0.85,
        model: 'gemini-translation',
        provider: this.name,
      };
    });
  }

  #parseSpeech(json, { text, voice, targetLanguage, sampleRate }) {
    const part = json?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) {
      const finishReason = json?.candidates?.[0]?.finishReason;
      const blocked = json?.promptFeedback?.blockReason;
      throw new ProviderError('Speech synthesis returned no audio', {
        code: ErrorCode.TTS_ERROR,
        retryable: true,
        recoveryScope: 'segment',
        details: { finishReason, blockReason: blocked },
        recommendedAction: 'Retry the segment; shorten the text if the request keeps being rejected.',
      });
    }

    const mimeType = part.inlineData.mimeType ?? 'audio/L16;rate=24000';
    const raw = Buffer.from(part.inlineData.data, 'base64');
    const normalized = normalizeSpeechPayload(raw, mimeType, sampleRate);

    return {
      audio: normalized.wav,
      sampleRate: normalized.sampleRate,
      channels: 1,
      durationSeconds: normalized.samples.length / normalized.sampleRate,
      voice,
      targetLanguage,
      text,
      model: 'gemini-tts',
      provider: this.name,
      sourceMimeType: mimeType,
    };
  }
}

/**
 * TTS preview models return headerless PCM (audio/L16) or a WAV container
 * depending on the model. Both are handled, and the result is returned as a WAV
 * buffer at the pipeline's working sample rate.
 */
export function normalizeSpeechPayload(raw, mimeType, targetSampleRate) {
  if (/wav/i.test(mimeType)) {
    const decoded = decodeWav(raw);
    const mono = toMono(decoded.samples, decoded.channels);
    const samples = decoded.sampleRate === targetSampleRate
      ? mono
      : resample(mono, decoded.sampleRate, targetSampleRate, 1);
    return {
      samples,
      sampleRate: targetSampleRate,
      wav: encodeWav({ samples, sampleRate: targetSampleRate, channels: 1 }),
    };
  }

  const rateMatch = /rate=(\d+)/i.exec(mimeType);
  const sampleRate = rateMatch ? Number.parseInt(rateMatch[1], 10) : 24000;
  // Headerless payloads are 16-bit little-endian mono PCM.
  const usable = raw.length - (raw.length % 2);
  const samples = new Int16Array(usable / 2);
  for (let i = 0; i < samples.length; i += 1) samples[i] = raw.readInt16LE(i * 2);
  const resampled = sampleRate === targetSampleRate
    ? samples
    : resample(samples, sampleRate, targetSampleRate, 1);
  return {
    samples: resampled,
    sampleRate: targetSampleRate,
    wav: encodeWav({ samples: resampled, sampleRate: targetSampleRate, channels: 1 }),
  };
}

/** Pulls the first text part out of a generateContent response. */
export function extractText(json) {
  const parts = json?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('').trim();
}

/** Models sometimes wrap JSON in prose or code fences; recover the object. */
export function parseJsonLoose(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch { /* fall through to extraction */ }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* keep trying */ }
  }
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    try { return JSON.parse(text.slice(firstBrace, lastBrace + 1)); } catch { /* give up */ }
  }
  return null;
}

function clampTime(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(Math.max(value, min), max);
}

function truncate(text, max) {
  const value = String(text ?? '');
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export { path };
