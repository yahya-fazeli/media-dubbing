# AGENTS.md

## Project

`youtube-dub v3` — a Node.js web dubbing platform (CLI + HTTP Studio) that runs
source media through transcription → translation → TTS → alignment → timing →
mixing → rendering.

## Commands

- `npm test` — full suite (unit + integration). Uses glob patterns; do not pass a
  directory argument.
- `npm run test:unit`
- `npm run test:integration`
- `node bin/youtube-dub.js serve` — start the Studio server.
- `node bin/youtube-dub.js run <file>` — CLI pipeline run.

## Test layout

Unit tests (`test/unit/`) cover the pure and near-pure modules directly:
concurrency, cancellation, ids/fsutil, errors, job-model, wav, alignment,
providers/retry/key-pool/fake-provider, context, artifact-store, job-store,
ingest, logger, metrics, middleware, config, telemetry, provider/media
selection, the CLI parsers/formatters, the media tool runner (`command.js`),
and the Gemini client. Integration tests (`test/integration/`) drive the real
pipeline and HTTP API end to end against the mock engine and fake provider.

`command.js` tests spawn real `node` child processes (`process.execPath`) to
exercise spawn, exit codes, signals, and timeouts without needing ffmpeg, and
inject a stub `fetchImpl` into `GeminiClient` for provider behavior.

Helpers live in `test/helpers/fixtures.js`: `makeTestApp()` builds a full
application in a throwaway data dir, and `createFixtureJob()` seeds a job from a
deterministic sine-wave WAV. Prefer these over hand-rolled setup.

Node's test runner runs files in parallel processes; tests that touch
`process.env` or shared temp dirs must restore state (see `withEnv` in
`test/unit/config.test.js` and the `boot()`/`t.after()` pattern in
`test/unit/middleware.test.js`).

## Environment

The sandbox has **no ffmpeg, no Gemini key, and no Demucs**. Defaults are
therefore mock-based:

- `DUB_MEDIA_ENGINE=mock` — mock media engine (no real ffmpeg).
- `DUB_FAKE_PROVIDER=true` — offline deterministic provider.
- `DUB_FAKE_LATENCY_MS` — per-call latency for the fake provider; useful for
  exercising cancellation while a run is in flight.
- `DUB_DATA_DIR`, `DUB_TMP_DIR` — data and scratch directories.

The server must bind `HOST=0.0.0.0` (not `127.0.0.1`) to be reachable through the
runtime proxy.

## Conventions / gotchas

- **Job persistence locking.** `JobStore.mutate()` serializes read-modify-write
  per job via `withLock(jobId, fn)`. `PipelineContext.save()` must persist
  *inside that same lock* and re-adopt server-owned fields (`status`,
  `cancellation`, timestamps) after acquiring it. Persisting outside the lock lets
  a stage's stale `running` snapshot clobber a concurrent `cancelling` status,
  which then makes the `cancelling -> cancelled` transition throw `CONFLICT`
  ("Illegal job transition running -> cancelled") and strands the job as
  `running` forever. `test/unit/context.test.js` pins this interleaving
  deterministically; it fails on the unlocked implementation.
- Segment summary field is `job.segmentSummary`; `job.segments` is an **array**.
- Fake-provider synthesis produces over-long speech, so per-segment alignment
  grades often read `fail` even though job-level quality validation passes. These
  are intentionally separate signals.
- The Studio's "No jobs match the filter." node is a `hidden` empty-state element
  (`#job-list-empty`); text extractors surface it even when it is not visible.
- Media/HTML are written via `textContent`/element creation, never provider data
  through `innerHTML`.
