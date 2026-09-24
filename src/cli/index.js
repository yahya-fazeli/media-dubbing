#!/usr/bin/env node
import { createApplication } from '../app.js';
import { startServer } from '../server/server.js';
import { loadConfig, ensureDataDirs, SUPPORTED_LANGUAGES } from '../config.js';
import { createLogger } from '../core/logger.js';
import { ffmpegAvailable } from '../media/ffmpeg-engine.js';
import { parseArgs, helpText } from './args.js';
import { formatJobLine, formatJobDetail, formatSegments, formatFailures } from './format.js';
import path from 'node:path';

/**
 * Operational CLI. Every command shares the same application wiring as the
 * server, so behaviour (engine selection, provider fallback, artifact layout) is
 * identical whether a job is driven from the browser or the terminal.
 */
async function main(argv) {
  const { command, flags, positionals } = parseArgs(argv);
  const config = ensureDataDirs(loadConfig({}));
  const logger = createLogger(config, { origin: 'cli' });

  switch (command) {
    case 'serve': return commandServe(config, flags, logger);
    case 'create': return commandCreate(config, flags, positionals, logger);
    case 'start': return commandStart(config, flags, positionals, logger);
    case 'status': return commandStatus(config, flags, positionals, logger);
    case 'list': return commandList(config, flags, logger);
    case 'cancel': return commandCancel(config, flags, positionals, logger);
    case 'resume': return commandResume(config, flags, positionals, logger);
    case 'retry': return commandRetry(config, flags, positionals, logger);
    case 'segments': return commandSegments(config, flags, positionals, logger);
    case 'failures': return commandFailures(config, flags, positionals, logger);
    case 'delete': return commandDelete(config, flags, positionals, logger);
    case 'doctor': return commandDoctor(config, logger);
    case 'help':
    case undefined: {
      process.stdout.write(helpText());
      return 0;
    }
    default:
      process.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
      return 2;
  }
}

function buildApp(config, logger, overrides = {}) {
  return createApplication({
    config: { dataDir: config.dataDir },
    logger,
    ...overrides,
  });
}

async function commandServe(config, flags, logger) {
  const port = flags.port ? Number.parseInt(flags.port, 10) : config.server.port;
  if (flags.port) process.env.PORT = String(port);
  const handle = await startServer({
    config: { dataDir: config.dataDir },
    logger,
  });

  process.stdout.write(`Studio:  ${handle.url}\n`);
  process.stdout.write(`API:     ${handle.url}/api\n`);
  process.stdout.write(`Engine:  ${handle.app.engineKind} (${handle.app.engineReason})\n`);
  process.stdout.write(`Provider:${handle.app.providerKind} (${handle.app.providerReason})\n`);
  process.stdout.write(`Data:    ${handle.app.config.dataDir}\n`);

  const shutdown = async (signal) => {
    process.stdout.write(`\nReceived ${signal}; draining active jobs...\n`);
    await handle.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Keep the process alive until a signal arrives.
  await new Promise(() => {});
  return 0;
}

async function commandCreate(config, flags, positionals, logger) {
  const sourcePath = positionals[0] ?? flags.source;
  if (!sourcePath) {
    process.stderr.write('Usage: youtube-dub create <source-file> --to <lang> [--from <lang>]\n');
    return 2;
  }
  const targetLanguage = flags.to;
  if (!targetLanguage) {
    process.stderr.write('--to <target-language> is required\n');
    return 2;
  }
  const sourceLanguage = flags.from ?? 'en';

  const app = await buildApp(config, logger);
  const settings = {
    separateVocals: flags.separateVocals === true || flags.separateVocals === 'true',
    voices: flags.voice ? String(flags.voice).split(',').map((v) => v.trim()).filter(Boolean) : [],
    reencodeVideo: flags.reencode === true || flags.reencode === 'true',
    keepSourceAudio: flags.keepSource !== 'false',
  };

  const job = await app.orchestrator.createJob({
    sourceName: path.basename(sourcePath),
    sourcePath: path.resolve(sourcePath),
    sourceLanguage,
    targetLanguage,
    settings,
    voices: settings.voices,
    origin: 'cli',
  });

  process.stdout.write(`Created ${job.jobId}\n`);
  if (flags.start === true || flags.start === 'true' || flags.wait === true || flags.wait === 'true') {
    await app.orchestrator.startJob(job.jobId);
    process.stdout.write('Started.\n');
    if (flags.wait === true || flags.wait === 'true') {
      const done = await app.orchestrator.waitFor(job.jobId, { timeoutMs: Number(flags.timeout ?? 0) });
      process.stdout.write(formatJobDetail(done));
      await app.close();
      return done.status === 'completed' ? 0 : 1;
    }
  }
  await app.close();
  return 0;
}

async function commandStart(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'start');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  await app.orchestrator.startJob(jobId);
  process.stdout.write(`Started ${jobId}\n`);
  if (flags.wait === true || flags.wait === 'true') {
    const done = await app.orchestrator.waitFor(jobId, { timeoutMs: Number(flags.timeout ?? 0) });
    process.stdout.write(formatJobDetail(done));
    await app.close();
    return done.status === 'completed' ? 0 : 1;
  }
  await app.close();
  return 0;
}

async function commandStatus(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'status');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  const job = await app.store.read(jobId, { fresh: true });
  process.stdout.write(formatJobDetail(job));
  if (flags.segments === true || flags.segments === 'true') {
    process.stdout.write(`\n${formatSegments(job.segments, 50)}\n`);
  }
  if (flags.failures === true || flags.failures === 'true') {
    process.stdout.write(`\n${formatFailures(job)}\n`);
  }
  await app.close();
  return 0;
}

async function commandList(config, flags, logger) {
  const app = await buildApp(config, logger);
  const { jobs } = await app.orchestrator.listJobs({
    limit: Number(flags.limit ?? 50),
    status: flags.status,
  });
  if (!jobs.length) {
    process.stdout.write('No jobs found.\n');
  } else {
    for (const job of jobs) process.stdout.write(`${formatJobLine(job)}\n`);
  }
  await app.close();
  return 0;
}

async function commandCancel(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'cancel');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  await app.orchestrator.cancelJob(jobId, flags.reason ?? 'Cancelled from CLI');
  const job = await app.orchestrator.waitFor(jobId, { timeoutMs: 30000 });
  process.stdout.write(`Job ${jobId} is now ${job.status}\n`);
  await app.close();
  return 0;
}

async function commandResume(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'resume');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  await app.orchestrator.retryJob(jobId, { scope: 'job' });
  process.stdout.write(`Resumed ${jobId}\n`);
  if (flags.wait === true || flags.wait === 'true') {
    const done = await app.orchestrator.waitFor(jobId, { timeoutMs: Number(flags.timeout ?? 0) });
    process.stdout.write(formatJobDetail(done));
    await app.close();
    return done.status === 'completed' ? 0 : 1;
  }
  await app.close();
  return 0;
}

async function commandRetry(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'retry');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  const scope = flags.scope ?? (flags.segment ? 'segment' : (flags.stage ? 'stage' : 'job'));
  const segmentIds = flags.segment
    ? String(flags.segment).split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  await app.orchestrator.retryJob(jobId, { scope, stage: flags.stage ?? null, segmentIds });
  process.stdout.write(`Retry started for ${jobId} (scope=${scope}${flags.stage ? `, stage=${flags.stage}` : ''})\n`);
  if (flags.wait === true || flags.wait === 'true') {
    const done = await app.orchestrator.waitFor(jobId, { timeoutMs: Number(flags.timeout ?? 0) });
    process.stdout.write(formatJobDetail(done));
    await app.close();
    return done.status === 'completed' ? 0 : 1;
  }
  await app.close();
  return 0;
}

async function commandSegments(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'segments');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  const job = await app.store.read(jobId, { fresh: true });
  process.stdout.write(`${formatSegments(job.segments, Number(flags.limit ?? 50), flags.status)}\n`);
  await app.close();
  return 0;
}

async function commandFailures(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'failures');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  const job = await app.store.read(jobId, { fresh: true });
  process.stdout.write(`${formatFailures(job)}\n`);
  await app.close();
  return 0;
}

async function commandDelete(config, flags, positionals, logger) {
  const jobId = requireJobId(positionals, 'delete');
  if (!jobId) return 2;
  const app = await buildApp(config, logger);
  await app.orchestrator.deleteJob(jobId);
  process.stdout.write(`Deleted ${jobId}\n`);
  await app.close();
  return 0;
}

async function commandDoctor(config, logger) {
  const lines = [];
  lines.push(`youtube-dub doctor`);
  lines.push(`  node:          ${process.version}`);
  lines.push(`  data dir:      ${config.dataDir}`);
  lines.push(`  media engine:  ${config.media.engine}`);

  const ff = await ffmpegAvailable(config);
  lines.push(`  ffmpeg:        ${ff.ffmpeg.available ? `yes (${ff.ffmpeg.version ?? 'unknown'})` : 'no'}`);
  lines.push(`  ffprobe:       ${ff.ffprobe.available ? 'yes' : 'no'}`);
  if (!ff.available) {
    lines.push('  note:          ffmpeg is unavailable; the mock engine will be used.');
  }

  const geminiKeys = config.providers.gemini.apiKeys.length;
  lines.push(`  gemini keys:   ${geminiKeys === 0 ? 'none configured' : `${geminiKeys} configured`}`);
  if (geminiKeys === 0) {
    lines.push('  note:          no Gemini keys; the deterministic offline provider will be used.');
  }

  const app = await buildApp(config, logger);
  const health = await app.orchestrator.health();
  lines.push(`  active engine: ${health.engine}`);
  lines.push(`  active provider: ${health.provider}`);
  lines.push(`  total jobs:    ${health.totalJobs}`);
  lines.push(`  by status:     ${JSON.stringify(health.jobsByStatus)}`);
  lines.push(`  api token:     ${config.server.apiToken ? 'set' : 'NOT SET (API is unauthenticated)'}`);
  lines.push(`  languages:     ${SUPPORTED_LANGUAGES.length} supported`);
  await app.close();

  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function requireJobId(positionals, command) {
  const jobId = positionals[0];
  if (!jobId) {
    process.stderr.write(`Usage: youtube-dub ${command} <job-id>\n`);
    return null;
  }
  return jobId;
}

main(process.argv.slice(2))
  .then((code) => {
    if (typeof code === 'number' && code !== 0) process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`Error: ${err?.message ?? err}\n`);
    if (process.env.DUB_DEBUG) process.stderr.write(`${err?.stack}\n`);
    process.exitCode = 1;
  });
