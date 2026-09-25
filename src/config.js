import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function envInt(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

function envFloat(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * Builds the full runtime configuration from environment variables. Credentials
 * are read here and only here; they are never written into job records.
 */
export function loadConfig(overrides = {}) {
  const dataDir = path.resolve(
    overrides.dataDir ?? process.env.DUB_DATA_DIR ?? path.join(projectRoot, 'data'),
  );

  return {
    projectRoot,
    dataDir,
    jobsDir: path.join(dataDir, 'jobs'),
    uploadsDir: path.join(dataDir, 'uploads'),
    artifactsDir: path.join(dataDir, 'artifacts'),
    logsDir: path.join(dataDir, 'logs'),
    tmpDir: path.resolve(process.env.DUB_TMP_DIR ?? path.join(os.tmpdir(), 'youtube-dub')),

    server: {
      host: process.env.HOST ?? '0.0.0.0',
      port: envInt('PORT', 12000),
      // Bearer token guarding the HTTP API. Unset means open access, which is
      // only suitable for local single-user use; the server warns when it is.
      apiToken: process.env.DUB_API_TOKEN ?? '',
      maxUploadBytes: envInt('DUB_MAX_UPLOAD_MB', 2048) * 1024 * 1024,
      bodyLimit: process.env.DUB_BODY_LIMIT ?? '1mb',
      trustProxy: envBool('DUB_TRUST_PROXY', false),
    },

    media: {
      // 'auto' selects ffmpeg when the binaries exist, otherwise the mock engine.
      engine: process.env.DUB_MEDIA_ENGINE ?? 'auto',
      ffmpegPath: process.env.FFMPEG_PATH ?? 'ffmpeg',
      ffprobePath: process.env.FFPROBE_PATH ?? 'ffprobe',
      demucsCommand: process.env.DEMUCS_COMMAND ?? 'demucs',
      demucsEnabled: envBool('DUB_DEMUCS_ENABLED', false),
      maxDurationSeconds: envInt('DUB_MAX_DURATION_SECONDS', 4 * 60 * 60),
      maxFileBytes: envInt('DUB_MAX_MEDIA_MB', 4096) * 1024 * 1024,
      supportedInputExtensions: [
        '.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v',
        '.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus',
      ],
      videoExtensions: ['.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v'],
      audioExtensions: ['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.opus'],
      commandTimeoutMs: envInt('DUB_MEDIA_TIMEOUT_MS', 30 * 60 * 1000),
    },

    pipeline: {
      targetSegmentSeconds: envFloat('DUB_TARGET_SEGMENT_SECONDS', 8),
      minSegmentSeconds: envFloat('DUB_MIN_SEGMENT_SECONDS', 2.5),
      maxSegmentSeconds: envFloat('DUB_MAX_SEGMENT_SECONDS', 18),
      ttsConcurrency: envInt('DUB_TTS_CONCURRENCY', 4),
      segmentConcurrency: envInt('DUB_SEGMENT_CONCURRENCY', 4),
      translationBatchSize: envInt('DUB_TRANSLATION_BATCH_SIZE', 20),
      maxSegmentAttempts: envInt('DUB_MAX_SEGMENT_ATTEMPTS', 3),
      maxStageAttempts: envInt('DUB_MAX_STAGE_ATTEMPTS', 2),
      // Tempo bounds applied when fitting synthesized speech into a segment window.
      minTempo: envFloat('DUB_MIN_TEMPO', 0.6),
      maxTempo: envFloat('DUB_MAX_TEMPO', 1.6),
      targetSampleRate: envInt('DUB_SAMPLE_RATE', 44100),
      outputChannels: envInt('DUB_OUTPUT_CHANNELS', 2),
      outputAudioBitrate: process.env.DUB_OUTPUT_AUDIO_BITRATE ?? '192k',
      outputVideoCodec: process.env.DUB_OUTPUT_VIDEO_CODEC ?? 'libx264',
      outputAudioCodec: process.env.DUB_OUTPUT_AUDIO_CODEC ?? 'aac',
      outputContainer: process.env.DUB_OUTPUT_CONTAINER ?? 'mp4',
      musicBedGainDb: envFloat('DUB_MUSIC_BED_GAIN_DB', -6),
      dialogueGainDb: envFloat('DUB_DIALOGUE_GAIN_DB', 0),
    },

    quality: {
      maxDurationDriftRatio: envFloat('DUB_MAX_DURATION_DRIFT_RATIO', 0.1),
      minDurationDriftSeconds: envFloat('DUB_MIN_DURATION_DRIFT_SECONDS', 2),
      minSegmentSuccessRatio: envFloat('DUB_MIN_SEGMENT_SUCCESS_RATIO', 0.9),
      requireAllStagesSucceeded: envBool('DUB_REQUIRE_ALL_STAGES', true),
    },

    providers: {
      gemini: {
        // Credentials come from the environment only and are never persisted.
        apiKeys: envList('GEMINI_API_KEYS', envList('GEMINI_API_KEY', [])),
        baseUrl: process.env.GEMINI_BASE_URL ?? 'https://generativelanguage.googleapis.com/v1beta',
        transcriptionModel: process.env.GEMINI_TRANSCRIPTION_MODEL ?? 'gemini-2.5-flash',
        transcriptionFallbacks: envList('GEMINI_TRANSCRIPTION_FALLBACKS', ['gemini-2.0-flash']),
        translationModel: process.env.GEMINI_TRANSLATION_MODEL ?? 'gemini-2.5-flash',
        translationFallbacks: envList('GEMINI_TRANSLATION_FALLBACKS', ['gemini-2.0-flash']),
        ttsModel: process.env.GEMINI_TTS_MODEL ?? 'gemini-2.5-flash-preview-tts',
        ttsFallbacks: envList('GEMINI_TTS_FALLBACKS', []),
        voices: envList('GEMINI_VOICES', ['Kore', 'Puck', 'Charon', 'Fenrir', 'Aoede']),
        maxAttempts: envInt('GEMINI_MAX_ATTEMPTS', 4),
        baseBackoffMs: envInt('GEMINI_BASE_BACKOFF_MS', 500),
        maxBackoffMs: envInt('GEMINI_MAX_BACKOFF_MS', 15000),
        requestTimeoutMs: envInt('GEMINI_TIMEOUT_MS', 120000),
        quotaCooldownMs: envInt('GEMINI_QUOTA_COOLDOWN_MS', 60000),
      },
      fake: {
        enabled: envBool('DUB_FAKE_PROVIDER', false),
        latencyMs: envInt('DUB_FAKE_LATENCY_MS', 5),
        failureRate: envFloat('DUB_FAKE_FAILURE_RATE', 0),
      },
    },

    observability: {
      logLevel: process.env.DUB_LOG_LEVEL ?? 'info',
      logPretty: envBool('DUB_LOG_PRETTY', true),
      otelEnabled: envBool('DUB_OTEL_ENABLED', false),
      otelServiceName: process.env.OTEL_SERVICE_NAME ?? 'youtube-dub',
      // 'console' prints spans to stdout, 'memory' retains them for tests and
      // inspection, 'none' registers a provider with no exporter.
      otelExporter: process.env.DUB_OTEL_EXPORTER ?? 'console',
      otelSampleRatio: envFloat('DUB_OTEL_SAMPLE_RATIO', 1),
      metricsEnabled: envBool('DUB_METRICS_ENABLED', true),
    },

    limits: {
      maxJobsRetained: envInt('DUB_MAX_JOBS_RETAINED', 1000),
      maxSegmentRowsInSummary: envInt('DUB_MAX_SEGMENT_ROWS', 5000),
      defaultSegmentPageSize: envInt('DUB_SEGMENT_PAGE_SIZE', 100),
    },
  };
}

export const SUPPORTED_LANGUAGES = [
  { code: 'en', name: 'English' },
  { code: 'es', name: 'Spanish' },
  { code: 'fr', name: 'French' },
  { code: 'de', name: 'German' },
  { code: 'it', name: 'Italian' },
  { code: 'pt', name: 'Portuguese' },
  { code: 'hi', name: 'Hindi' },
  { code: 'ja', name: 'Japanese' },
  { code: 'ko', name: 'Korean' },
  { code: 'zh', name: 'Chinese (Simplified)' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ru', name: 'Russian' },
  { code: 'nl', name: 'Dutch' },
  { code: 'pl', name: 'Polish' },
  { code: 'tr', name: 'Turkish' },
  { code: 'id', name: 'Indonesian' },
  { code: 'vi', name: 'Vietnamese' },
  { code: 'th', name: 'Thai' },
  { code: 'sv', name: 'Swedish' },
  { code: 'uk', name: 'Ukrainian' },
];

export function ensureDataDirs(config) {
  for (const dir of [
    config.dataDir,
    config.jobsDir,
    config.uploadsDir,
    config.artifactsDir,
    config.logsDir,
    config.tmpDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return config;
}

export { envInt, envBool, envFloat, envList };
