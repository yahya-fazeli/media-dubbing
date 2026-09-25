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
the Gemini client and provider, segmentation, voice assignment, and alignment.
Integration tests (`test/integration/`) drive the real pipeline and HTTP API end
to end against the mock engine and fake provider.

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
- **`CancelToken` must satisfy the `AbortSignal` interface.** The orchestrator
  passes a `CancelToken` as the `signal` option to `runCommand`, `sleep()`, and
  the Gemini client, all of which expect a standard `AbortSignal`. The token owns
  an `AbortController` and delegates `addEventListener` / `removeEventListener` /
  `aborted` to it. Before that, `runCommand` threw "signal.addEventListener is not
  a function" on every real ffmpeg call, and the `signal?.addEventListener?.()`
  call sites silently no-oped so cancellation never reached in-flight provider
  requests. Any new field on the token must preserve this contract.

## Testing the real runtime

The default suite uses the **mock** media engine, which never spawns a
subprocess — so `runCommand`, every ffmpeg argument list, and real stream
handling are unexercised by `npm test`. `test/real/media-smoke.test.js` covers
them against the installed ffmpeg binary and is skipped unless enabled:

```
npm run test:real:media        # RUN_REAL_MEDIA_TESTS=1, needs ffmpeg + ffprobe
```

It builds its own video fixtures with ffmpeg (no committed binary assets) and
covers probe, extract, trim, normalize, concat, mix, render with stream copy,
render with forced re-encode, subprocess cancellation, missing-binary errors,
and full pipeline runs for both audio-only and video sources.

`ffmpeg-static` is available on npm as a fallback when system ffmpeg is absent.

Two runtime probes from Phase 0 that are wired but unverified against real tools:
- `demucs` is absent. The Python package installs but needs `torch` plus runtime
  model-weight downloads, so vocal separation cannot be exercised here.
- `@opentelemetry/api` is installed but there is **no SDK/exporter**, so spans
  go nowhere. `@opentelemetry/sdk-trace-node` and `sdk-trace-base` are available
  on npm if tracing is to be completed.
