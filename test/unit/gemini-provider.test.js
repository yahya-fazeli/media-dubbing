import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GeminiProvider, normalizeSpeechPayload, extractText, parseJsonLoose,
} from '../../src/providers/gemini-provider.js';
import { decodeWav, encodeWav } from '../../src/core/wav.js';
import { ErrorCode } from '../../src/core/errors.js';
import { loadConfig } from '../../src/config.js';

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Builds a provider whose client always returns one scripted generation body. */
function makeProvider(response) {
  const config = loadConfig({ dataDir: '/tmp/gemini-provider-test' });
  config.providers.gemini.apiKeys = ['test-key'];
  config.providers.gemini.baseUrl = 'https://gemini.test/v1beta';
  config.providers.gemini.maxAttempts = 1;
  config.providers.gemini.baseBackoffMs = 1;
  config.providers.gemini.maxBackoffMs = 2;

  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const body = typeof response === 'function' ? response(JSON.parse(init.body)) : response;
    return {
      ok: true,
      status: 200,
      async json() { return body; },
      async text() { return JSON.stringify(body); },
    };
  };
  const provider = new GeminiProvider(config, { logger: silentLogger, fetchImpl, random: () => 0 });
  return { provider, config, calls };
}

const textResponse = (text) => ({
  candidates: [{ content: { parts: [{ text }] } }],
});

test('extractText joins text parts and trims the result', () => {
  assert.equal(extractText({ candidates: [{ content: { parts: [{ text: ' a ' }, { text: 'b' }] } }] }), 'a b');
  assert.equal(extractText({ candidates: [] }), '');
  assert.equal(extractText(null), '');
});

test('parseJsonLoose recovers JSON from fences and surrounding prose', () => {
  assert.deepEqual(parseJsonLoose('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonLoose('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonLoose('Here you go:\n{"a":3}\nHope that helps!'), { a: 3 });
  assert.equal(parseJsonLoose('no json at all'), null);
  assert.equal(parseJsonLoose(''), null);
});

test('transcribe sends inline audio and parses word timings', async () => {
  const words = [
    { text: 'hello', start: 0.0, end: 0.4 },
    { text: 'world', start: 0.4, end: 0.9 },
  ];
  const { provider, calls } = makeProvider(textResponse(JSON.stringify({
    language: 'en', words, text: 'hello world',
  })));

  // The pipeline passes base64 audio as the positional provider input.
  const result = await provider.transcribe('QUJD', {
    mimeType: 'audio/wav', language: 'en', durationSeconds: 1,
  });

  assert.equal(result.text, 'hello world');
  assert.equal(result.words.length, 2);
  assert.equal(result.words[1].text, 'world');
  assert.equal(result.provider, 'gemini');

  const sent = JSON.parse(calls[0].init.body);
  const inline = sent.contents[0].parts.find((p) => p.inlineData);
  assert.equal(inline.inlineData.data, 'QUJD');
  assert.equal(inline.inlineData.mimeType, 'audio/wav');
  assert.equal(sent.generationConfig.temperature, 0);
});

test('transcribe requires audio and a valid language', async () => {
  const { provider } = makeProvider(textResponse('{}'));

  await assert.rejects(() => provider.transcribe(null, { language: 'en' }), /audioBase64/);
  await assert.rejects(
    () => provider.transcribe('QUJD', { language: 'not a language' }),
    /Invalid language code/,
  );
});

test('transcribe repairs non-monotonic and missing timestamps', async () => {
  // The model can emit overlapping or absent times; the parser must normalize
  // them into a strictly increasing sequence so alignment has sane input.
  const { provider } = makeProvider(textResponse(JSON.stringify({
    language: 'en',
    words: [
      { text: 'a', start: 0.0, end: 1.0 },
      { text: 'b', start: 0.2, end: 0.3 },
      { text: 'c' },
      { text: '   ' },
    ],
  })));

  const result = await provider.transcribe('QUJD', { language: 'en' });

  assert.equal(result.words.length, 3, 'blank words are dropped');
  for (let i = 1; i < result.words.length; i += 1) {
    assert.ok(
      result.words[i].start >= result.words[i - 1].end,
      `word ${i} starts before the previous word ends: ${JSON.stringify(result.words)}`,
    );
  }
  assert.ok(result.words.every((w) => w.end > w.start), 'every word has positive duration');
});

test('transcribe clamps timestamps to the known duration', async () => {
  const { provider } = makeProvider(textResponse(JSON.stringify({
    language: 'en',
    words: [{ text: 'a', start: 0, end: 9999 }],
  })));

  const result = await provider.transcribe('QUJD', { language: 'en', durationSeconds: 2 });
  assert.ok(result.words[0].end <= 7, `end was ${result.words[0].end}, expected clamp to duration+5`);
});

test('transcribe rejects a response that is not the expected shape', async () => {
  const { provider } = makeProvider(textResponse('this is not json'));
  await assert.rejects(
    () => provider.transcribe('QUJD', { language: 'en' }),
    (err) => err.code === ErrorCode.PROVIDER_ERROR && err.retryable === true,
  );
});

test('transcribe rejects a response with no words at all', async () => {
  const { provider } = makeProvider(textResponse(JSON.stringify({ language: 'en', words: [] })));
  await assert.rejects(
    () => provider.transcribe('QUJD', { language: 'en' }),
    (err) => err.code === ErrorCode.PROVIDER_ERROR && err.recoveryScope === 'stage',
  );
});

test('translate sends all segments in one request and maps results by id', async () => {
  const { provider, calls } = makeProvider(textResponse(JSON.stringify({
    translations: [
      { id: 'seg_00002', text: 'dos' },
      { id: 'seg_00001', text: 'uno' },
    ],
  })));

  const result = await provider.translate([
    { segmentId: 'seg_00001', text: 'one' },
    { segmentId: 'seg_00002', text: 'two' },
  ], { sourceLanguage: 'en', targetLanguage: 'es' });

  assert.equal(calls.length, 1, 'a batch must be a single request for cross-segment context');
  assert.deepEqual(result.map((r) => r.segmentId), ['seg_00001', 'seg_00002']);
  assert.deepEqual(result.map((r) => r.text), ['uno', 'dos']);
  assert.equal(result[0].sourceText, 'one');
  assert.equal(result[0].targetLanguage, 'es');
});

test('translate returns an empty list for no segments without calling the provider', async () => {
  const { provider, calls } = makeProvider(textResponse('{}'));
  assert.deepEqual(await provider.translate([], { targetLanguage: 'es' }), []);
  assert.equal(calls.length, 0);
});

test('translate fails when a requested segment is missing from the response', async () => {
  const { provider } = makeProvider(textResponse(JSON.stringify({
    translations: [{ id: 'seg_00001', text: 'uno' }],
  })));

  await assert.rejects(
    () => provider.translate([
      { segmentId: 'seg_00001', text: 'one' },
      { segmentId: 'seg_00002', text: 'two' },
    ], { targetLanguage: 'es' }),
    (err) => err.code === ErrorCode.PROVIDER_ERROR
      && err.recoveryScope === 'segment'
      && err.segmentId === 'seg_00002',
  );
});

test('translate rejects blank segment text before calling the provider', async () => {
  const { provider, calls } = makeProvider(textResponse('{}'));
  await assert.rejects(
    () => provider.translate([{ segmentId: 'seg_00001', text: '   ' }], { targetLanguage: 'es' }),
    /non-empty string/,
  );
  assert.equal(calls.length, 0);
});

test('synthesize decodes base64 PCM at the declared rate into a WAV', async () => {
  const raw = Buffer.alloc(2000);
  for (let i = 0; i < 1000; i += 1) raw.writeInt16LE(i % 100, i * 2);
  const { provider } = makeProvider({
    candidates: [{
      content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: raw.toString('base64') } }] },
    }],
  });

  const result = await provider.synthesize('hola', { targetLanguage: 'es', segmentId: 'seg_00001' });

  assert.equal(result.sampleRate, provider.config.pipeline.targetSampleRate);
  assert.equal(result.channels, 1);
  assert.ok(result.audio.length > 0, 'a WAV buffer is returned');
  const decoded = decodeWav(result.audio);
  assert.ok(decoded.samples.length > 0, 'the WAV round-trips');
  assert.equal(result.voice, 'Kore');
  assert.equal(result.voice, provider.config.providers.gemini.voices[0]);
});

test('synthesize reports a missing audio part as a retryable TTS error', async () => {
  const { provider } = makeProvider({
    candidates: [{ finishReason: 'SAFETY', content: { parts: [{ text: 'refused' }] } }],
    promptFeedback: { blockReason: 'PROHIBITED_CONTENT' },
  });

  await assert.rejects(
    () => provider.synthesize('text', { targetLanguage: 'es', segmentId: 'seg_00001' }),
    (err) => {
      assert.equal(err.code, ErrorCode.TTS_ERROR);
      assert.equal(err.retryable, true);
      assert.equal(err.recoveryScope, 'segment');
      assert.equal(err.details.finishReason, 'SAFETY');
      assert.equal(err.details.blockReason, 'PROHIBITED_CONTENT');
      return true;
    },
  );
});

test('synthesize validates its text and honours an explicit voice', async () => {
  const raw = Buffer.alloc(200);
  const { provider, calls } = makeProvider({
    candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/L16;rate=24000', data: raw.toString('base64') } }] } }],
  });

  await assert.rejects(() => provider.synthesize('  ', { targetLanguage: 'es' }), /non-empty string/);

  const result = await provider.synthesize('hola', { targetLanguage: 'es', voice: 'Puck', style: 'cheerful' });
  assert.equal(result.voice, 'Puck');
  const sent = JSON.parse(calls[0].init.body);
  const voiceName = sent.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName;
  assert.equal(voiceName, 'Puck');
});

test('normalizeSpeechPayload resamples headerless PCM to the target rate', () => {
  const raw = Buffer.alloc(4800); // 2400 samples at 24 kHz => 0.1s
  const out = normalizeSpeechPayload(raw, 'audio/L16;rate=24000', 48000);

  assert.equal(out.sampleRate, 48000);
  assert.equal(out.samples.length, 4800, '0.1s at 48 kHz is 4800 samples');
  const decoded = decodeWav(out.wav);
  assert.equal(decoded.sampleRate, 48000);
  assert.equal(decoded.channels, 1);
});

test('normalizeSpeechPayload defaults to 24 kHz when the mime type omits a rate', () => {
  const raw = Buffer.alloc(2400);
  const out = normalizeSpeechPayload(raw, 'audio/L16', 24000);
  assert.equal(out.samples.length, 1200);
});

test('normalizeSpeechPayload drops a trailing odd byte from headerless PCM', () => {
  // 16-bit samples need an even byte count; a stray byte must not shift the frames.
  const out = normalizeSpeechPayload(Buffer.alloc(101), 'audio/L16;rate=24000', 24000);
  assert.equal(out.samples.length, 50);
});

test('normalizeSpeechPayload passes a WAV container through the decoder', () => {
  const frames = 480;
  const interleaved = new Int16Array(frames * 2);
  for (let i = 0; i < frames; i += 1) {
    interleaved[i * 2] = i % 50;
    interleaved[i * 2 + 1] = i % 50;
  }
  const wav = encodeWav({ samples: interleaved, sampleRate: 48000, channels: 2 });

  const out = normalizeSpeechPayload(wav, 'audio/wav', 48000);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.samples.length, frames, 'stereo input is downmixed to mono');
  const decoded = decodeWav(out.wav);
  assert.equal(decoded.channels, 1);
});

test('normalizeSpeechPayload downsamples a WAV whose rate differs from the target', () => {
  const samples = new Int16Array(2400); // 0.1s at 24 kHz
  const wav = encodeWav({ samples, sampleRate: 24000, channels: 1 });

  const out = normalizeSpeechPayload(wav, 'audio/wav; codecs=1', 48000);
  assert.equal(out.sampleRate, 48000);
  assert.equal(out.samples.length, 4800, '0.1s at 48 kHz is 4800 samples');
});