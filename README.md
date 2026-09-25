# youtube-dub

A Node.js web platform that dubs a video into another language. Point it at a
media file and it transcribes the speech, translates it, synthesizes the target
voice, fits that speech back into the original timing, mixes it with the
background, and renders a finished video — all as a resumable job you can watch
and steer from a browser.

---

## Contents

- [Features](#features)
- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [CLI](#cli)
- [Web Studio and HTTP API](#web-studio-and-http-api)
- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Observability](#observability)
- [Testing](#testing)
- [Project layout](#project-layout)
- [Security](#security)
- [License](#license)

---

## Features

- **Full dubbing pipeline** — audio extraction, optional vocal separation,
  transcription, segmentation, translation, text-to-speech, alignment, timing,
  mixing, rendering, and quality validation.
- **Resumable jobs** — every job and every segment has a durable status, so a
  crash, a timeout, or a cancelled job can pick up where it left off instead of
  starting over.
- **Segment-level recovery** — retry a single failed segment, one stage, or the
  whole job. Successful work is reused, never regenerated unnecessarily.
- **Bounded concurrency** — independent segments are processed in parallel, with
  configurable limits so large jobs do not overwhelm the server.
- **Provider fallback** — multiple Gemini models and API keys with automatic
  rotation, quota handling, and bounded retries.
- **Browser Studio** — a dashboard for creating jobs, watching stage and segment
  progress, inspecting transcripts and timings, and playing the final result.
- **Optional CLI** — the same engine, scriptable for operational tasks.
- **Offline development** — a deterministic fake provider and a mock media engine
  let you exercise the whole pipeline with no credentials and no ffmpeg.

## Requirements

- **Node.js >= 20.11** (ESM only).
- **ffmpeg** and **ffprobe** on your `PATH` for real media processing. Without
  them the app falls back to a mock engine that simulates media operations, which
  is enough to develop against but produces no real output.
- **A Gemini API key** for real transcription, translation, and speech synthesis.
  Without one the deterministic offline provider is used instead.
- **Demucs** (optional) if you want to separate vocals from background music.

## Install

```bash
git clone https://github.com/yahya-fazeli/media-dubbing.git
cd media-dubbing
npm install
```

OpenTelemetry packages are declared as optional dependencies, so a plain
`npm install` may skip them. If you want tracing, either make sure optional
dependencies are installed or add them explicitly:

```bash
npm install --include=optional
```

## Quick start

Run the bundled check first — it tells you which engine and provider you have:

```bash
npm run cli -- doctor
```

Then dub a file from the command line. This creates a job, starts it, and waits
for it to finish:

```bash
npm run cli -- create ./my-video.mp4 --to es --start --wait
```

With no Gemini key configured, the offline provider dubs the audio into a
recognizable placeholder voice so you can verify the plumbing end to end. To run
the real thing, provide keys as shown in [Configuration](#configuration).

Prefer a browser? Start the Studio:

```bash
npm start
```

Then open <http://localhost:12000> to create and watch jobs, and see
[Web Studio and HTTP API](#web-studio-and-http-api) for the API surface.

## CLI

The CLI is exposed as `youtube-dub` via the `bin` field, so
`npm run cli -- <command>` and `npx youtube-dub <command>` are equivalent once
installed.

```text
Usage: youtube-dub <command> [options]

Commands:
  serve                         Start the web Studio and HTTP API
  create <source> --to <lang>   Create a job from a media file
  start <job-id>                Start or restart a job
  resume <job-id>               Resume from the last completed stage
  retry <job-id>                Retry a job, stage, or segments
  cancel <job-id>               Cancel a running job
  status <job-id>               Show job detail
  segments <job-id>             List segments
  failures <job-id>             Show structured failures
  list                          List jobs
  delete <job-id>               Delete a job and its artifacts
  doctor                        Check environment and configuration
```

Common options:

```text
  --from <lang>                 Source language (default: en)
  --to <lang>                   Target language (required for create)
  --voice <a,b>                 Voice names for TTS
  --separate-vocals             Enable vocal separation (requires Demucs)
  --reencode                    Force video re-encoding on render
  --wait                        Wait for the job to finish
  --timeout <ms>                Timeout for --wait
  --start                       Start the job immediately after create
  --scope job|stage|segment     Retry scope (default: job)
  --stage <name>                Stage name for stage-scoped retry
  --segment <id,id>             Segment ids for segment-scoped retry
  --status <status>             Filter list and segments by status
  --port <n>                    Port for the serve command
```

A cancelled or failed job can be recovered at the level that failed. See
[How it works](#how-it-works) for the stage names.

```bash
# Resume a job after a crash or cancellation
npm run cli -- resume <job-id> --wait

# Retry only the segments that failed
npm run cli -- retry <job-id> --scope segment --segment seg_12,seg_19

# Re-run one stage, e.g. after adding a voice
npm run cli -- retry <job-id> --scope stage --stage tts
```

## Web Studio and HTTP API

`npm start` serves the Studio at `/` and the JSON API under `/api`. The API is
guarded by a bearer token when `DUB_API_TOKEN` is set; without it the server
starts unauthenticated and logs a warning, which is only appropriate for local
single-user use. See [Security](#security).

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Liveness, uptime, and job counts |
| `GET` | `/api/meta` | Version, supported languages, and limits |
| `GET` | `/api/metrics` | Metrics snapshot |
| `GET` | `/api/metrics/prometheus` | Metrics in Prometheus format |
| `GET` | `/api/jobs` | List jobs |
| `POST` | `/api/jobs` | Create a job from an uploaded file |
| `POST` | `/api/jobs/from-path` | Create a job from a server-side path |
| `GET` | `/api/jobs/:jobId` | Job detail, with optional segment paging |
| `GET` | `/api/jobs/:jobId/segments` | Segment list |
| `GET` | `/api/jobs/:jobId/transcript` | Source transcript |
| `GET` | `/api/jobs/:jobId/translations` | Translated segments |
| `GET` | `/api/jobs/:jobId/failures` | Structured failures |
| `GET` | `/api/jobs/:jobId/artifacts` | Artifact inventory |
| `GET` | `/api/jobs/:jobId/artifacts/*` | Download an artifact |
| `POST` | `/api/jobs/:jobId/start` | Start or restart |
| `POST` | `/api/jobs/:jobId/resume` | Resume |
| `POST` | `/api/jobs/:jobId/cancel` | Cancel |
| `POST` | `/api/jobs/:jobId/retry` | Retry a job, stage, or segments |
| `DELETE` | `/api/jobs/:jobId` | Delete a job and its artifacts |

For example:

```bash
curl -s http://localhost:12000/api/health
```

```json
{
  "status": "ok",
  "uptimeSeconds": 4,
  "activeRunners": 0,
  "totalJobs": 0,
  "jobsByStatus": {},
  "provider": "fake",
  "engine": "ffmpeg",
  "providerConfigured": false
}
```

## How it works

A job moves through a fixed sequence of stages. Each stage records its own
status and its own artifacts, which is what makes resumption possible: a re-run
skips stages that already succeeded and reuses their output.

```text
Source media
  → ingest
  → audio_extract
  → vocal_separation   (optional)
  → transcription      (word-level timestamps)
  → segmentation       (stable per-segment ids)
  → translation        (batched, context-aware)
  → tts                (concurrent, per segment)
  → alignment
  → timing             (fit speech into the original window)
  → mixing             (dialogue + background)
  → rendering
  → quality
```

A job is always in one of six states:

```text
created → running → completed
                 → failed
                 → cancelling → cancelled
```

`cancelled` and `failed` are recoverable: both can be resumed or retried at the
level that failed, as described in [CLI](#cli). Before a job is marked
`completed`, the quality stage checks that the final video exists, is readable,
contains the required streams, is within acceptable duration limits, and that
every required stage and segment succeeded.

## Configuration

Every setting is an environment variable with a working default; there is no
config file to write. Credentials are read from the environment only and are
never stored with a job.

### Credentials and server

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_API_KEYS` | — | Comma-separated API keys, rotated automatically. |
| `GEMINI_API_KEY` | — | Single-key alternative to `GEMINI_API_KEYS`. |
| `DUB_API_TOKEN` | — | Bearer token for the HTTP API. Unset means unauthenticated. |
| `PORT` | `12000` | HTTP port. |
| `HOST` | `0.0.0.0` | HTTP bind address. |
| `DUB_TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers. Enable only behind a trusted proxy. |
| `DUB_DATA_DIR` | `./data` | Root directory for jobs, uploads, artifacts, and logs. |
| `DUB_TMP_DIR` | system temp | Scratch directory for intermediate files. |

### Media engine

| Variable | Default | Description |
| --- | --- | --- |
| `DUB_MEDIA_ENGINE` | `auto` | `auto`, `ffmpeg`, or `mock`. `auto` uses ffmpeg when available. |
| `DUB_DEMUCS_ENABLED` | `false` | Enable vocal separation. Requires Demucs. |
| `DUB_MAX_UPLOAD_MB` | `2048` | Maximum upload size. |
| `DUB_MAX_MEDIA_MB` | `4096` | Maximum source media size. |
| `DUB_MAX_DURATION_SECONDS` | `14400` | Maximum source duration. |
| `DUB_MEDIA_TIMEOUT_MS` | `1800000` | Per-command timeout for external media tools. |

Supported input containers are `.mp4`, `.mov`, `.mkv`, `.webm`, `.avi`, `.m4v`,
`.mp3`, `.wav`, `.m4a`, `.aac`, `.flac`, `.ogg`, and `.opus`.

### Pipeline behaviour

| Variable | Default | Description |
| --- | --- | --- |
| `DUB_TTS_CONCURRENCY` | `4` | Concurrent TTS requests. |
| `DUB_SEGMENT_CONCURRENCY` | `4` | Segments processed in parallel. |
| `DUB_TRANSLATION_BATCH_SIZE` | `20` | Segments translated per request. |
| `DUB_TARGET_SEGMENT_SECONDS` | `8` | Preferred segment length. |
| `DUB_MIN_SEGMENT_SECONDS` | `2.5` | Minimum segment length. |
| `DUB_MAX_SEGMENT_SECONDS` | `18` | Maximum segment length. |
| `DUB_MIN_TEMPO` / `DUB_MAX_TEMPO` | `0.6` / `1.6` | Tempo bounds when fitting speech to a window. |
| `DUB_MAX_SEGMENT_ATTEMPTS` | `3` | Retries per segment before it is marked failed. |
| `DUB_MAX_STAGE_ATTEMPTS` | `2` | Retries per stage. |
| `DUB_SAMPLE_RATE` | `44100` | Output sample rate. |
| `DUB_OUTPUT_CHANNELS` | `2` | Output channel count. |
| `DUB_NORMALIZE_LOUDNESS` | `false` | Apply EBU R128 loudness normalization to the mix. |
| `DUB_TARGET_LUFS` | `-16` | Target loudness when normalization is enabled. |
| `DUB_MUSIC_BED_GAIN_DB` | `-6` | Background gain relative to dialogue. |
| `DUB_DIALOGUE_GAIN_DB` | `0` | Dialogue gain. |

### Quality gates

| Variable | Default | Description |
| --- | --- | --- |
| `DUB_REQUIRE_ALL_STAGES` | `true` | Fail the job if any required stage did not succeed. |
| `DUB_MIN_SEGMENT_SUCCESS_RATIO` | `0.9` | Minimum fraction of segments that must succeed. |
| `DUB_MAX_DURATION_DRIFT_RATIO` | `0.1` | Allowed relative duration difference. |
| `DUB_MIN_DURATION_DRIFT_SECONDS` | `2` | Absolute duration tolerance. |

### Gemini tuning

| Variable | Default | Description |
| --- | --- | --- |
| `GEMINI_MAX_ATTEMPTS` | `4` | Attempts per request before giving up. |
| `GEMINI_TIMEOUT_MS` | `120000` | Per-request timeout. |
| `GEMINI_BASE_BACKOFF_MS` / `GEMINI_MAX_BACKOFF_MS` | `500` / `15000` | Retry backoff bounds. |
| `GEMINI_QUOTA_COOLDOWN_MS` | `60000` | Cooldown after a quota error. |
| `GEMINI_TRANSCRIPTION_MODEL` | `gemini-2.5-flash` | Transcription model. |
| `GEMINI_TRANSLATION_MODEL` | `gemini-2.5-flash` | Translation model. |
| `GEMINI_TTS_MODEL` | `gemini-2.5-flash-preview-tts` | Speech synthesis model. |
| `GEMINI_*_FALLBACKS` | see `src/config.js` | Fallback models tried when the primary is unavailable. |
| `GEMINI_VOICES` | `Kore,Puck,Charon,Fenrir,Aoede` | Voices selectable via `--voice`. |

### Offline development

| Variable | Default | Description |
| --- | --- | --- |
| `DUB_FAKE_PROVIDER` | `false` | Use the deterministic offline provider instead of Gemini. |
| `DUB_FAKE_LATENCY_MS` | `5` | Simulated per-call latency. |
| `DUB_FAKE_FAILURE_RATE` | `0` | Fraction of calls to fail, for exercising retries. |

Supported languages: `en`, `es`, `fr`, `de`, `it`, `pt`, `hi`, `ja`, `ko`,
`zh`, `ar`, `ru`, `nl`, `pl`, `tr`, `id`, `vi`, `th`, `sv`, `uk`.

## Observability

Logs are structured JSON on stdout, with a `jobId` and stage where relevant so
you can correlate a line with a specific job.

| Variable | Default | Description |
| --- | --- | --- |
| `DUB_LOG_LEVEL` | `info` | Log level. |
| `DUB_LOG_PRETTY` | `true` | Human-readable logs instead of raw JSON. |
| `DUB_METRICS_ENABLED` | `true` | Collect provider, TTS, media, and timing metrics. |
| `DUB_OTEL_ENABLED` | `false` | Enable OpenTelemetry tracing. |
| `DUB_OTEL_EXPORTER` | `console` | `console`, `memory`, or `none`. |
| `DUB_OTEL_SAMPLE_RATIO` | `1` | Fraction of traces to sample. |
| `OTEL_SERVICE_NAME` | `youtube-dub` | Service name reported to the collector. |

With tracing enabled, each pipeline stage emits a span tagged with its job and
stage. A full job produces one span per stage:

```bash
DUB_OTEL_ENABLED=1 DUB_OTEL_EXPORTER=console npm run cli -- \
  create ./my-video.mp4 --to es --start --wait
```

Note that the tracer provider is process-global and is flushed, not shut down,
when the app closes, so tracing stays available for later work in the same
process. Tracing is covered in more detail in [AGENTS.md](AGENTS.md).

## Testing

```bash
npm test                  # unit and integration tests
npm run test:unit         # unit tests only
npm run test:integration  # integration tests only
```

The default suite runs without credentials, and without ffmpeg it still passes:
when the ffmpeg binaries are missing the media engine falls back to the mock
engine, and the deterministic offline provider stands in for Gemini. Tests that
exercise the real runtime are opt-in:

```bash
npm run test:real:media      # real ffmpeg and ffprobe
npm run test:real:provider   # real Gemini calls, needs credentials
npm run test:load            # concurrency and load
```

`test:real:provider` and `test:load` make real network or heavy local calls and
are intended to be run deliberately, not on every change.

## Project layout

```text
bin/youtube-dub.js       CLI entry point
public/                  Studio assets served at /
src/app.js               Composition root: engine, provider, stores, telemetry
src/config.js            Environment-driven configuration
src/cli/                 Argument parsing, output formatting, commands
src/core/                Job model, stores, cancellation, WAV, metrics, telemetry
src/media/               FFmpeg and mock engines, ingest, subprocess handling
src/pipeline/            Stages, segmentation, alignment, orchestration
src/providers/           Gemini client, key pool, retry, offline provider
src/server/              Express server, API routes, auth middleware
test/                    unit/, integration/, real/, and shared fixtures
```

## Security

- **Credentials stay in the environment.** API keys are read from environment
  variables and are never written into job records or artifacts.
- **Bearer authentication.** Set `DUB_API_TOKEN` to require a token on the API.
  Without it the server warns that it is unauthenticated.
- **Upload handling.** Files are validated by extension, size, and magic bytes,
  and are staged under a private data directory before a job is created.
- **Path traversal protection.** Identifiers are validated and artifact paths
  are resolved against their expected root, so a crafted id or filename cannot
  escape the data directory.
- **Controlled subprocesses.** ffmpeg, ffprobe, and Demucs are invoked as
  argument arrays via `execFile` with a timeout and cancellation support, never
  through a shell.
- **Log hygiene.** Logs carry correlation ids and metrics, not media content or
  credentials.

Found a security issue? Please report it privately rather than opening a public
issue.

## License

See [LICENSE](LICENSE).
