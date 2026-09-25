/**
 * Small argument parser. Supports `--flag value`, `--flag=value`, and boolean
 * flags. Deliberately minimal: the CLI is an operations tool, and a dependency
 * for argument parsing would not earn its place.
 *
 * Recognized boolean flags are listed explicitly so `--wait` alone means true
 * while `--to es` consumes a value.
 */
const BOOLEAN_FLAGS = new Set([
  'start', 'wait', 'segments', 'failures', 'separate-vocals', 'reencode',
]);

export function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  let command = null;

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];

    if (token === '--') {
      positionals.push(...argv.slice(i + 1));
      break;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        flags[toCamel(body.slice(0, eq))] = body.slice(eq + 1);
        continue;
      }
      const name = toCamel(body);
      if (BOOLEAN_FLAGS.has(body)) {
        flags[name] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // Short flags map onto their long equivalents for the common cases.
      const short = token.slice(1);
      const map = { t: 'to', f: 'from', s: 'source', w: 'wait', p: 'port' };
      const name = map[short] ?? short;
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    if (command === null) command = token;
    else positionals.push(token);
  }

  return { command, flags, positionals };
}

function toCamel(name) {
  return name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

export function helpText() {
  return [
    'youtube-dub v3 - web-based video dubbing platform',
    '',
    'Usage: youtube-dub <command> [options]',
    '',
    'Commands:',
    '  serve                         Start the web Studio and HTTP API',
    '  create <source> --to <lang>   Create a job from a media file',
    '  start <job-id>                Start or restart a job',
    '  resume <job-id>               Resume from the last completed stage',
    '  retry <job-id>                Retry a job, stage, or segments',
    '  cancel <job-id>               Cancel a running job',
    '  status <job-id>               Show job detail',
    '  segments <job-id>             List segments',
    '  failures <job-id>             Show structured failures',
    '  list                          List jobs',
    '  delete <job-id>               Delete a job and its artifacts',
    '  doctor                        Check environment and configuration',
    '',
    'Common options:',
    '  --from <lang|auto>            Source language (default: en; use auto to detect)',
    '  --to <lang>                   Target language (required for create)',
    '  --voice <a,b>                 Voice names for TTS',
    '  --separate-vocals             Enable vocal separation (requires Demucs)',
    '  --reencode                    Force video re-encoding on render',
    '  --wait                        Wait for the job to finish',
    '  --timeout <ms>                Timeout for --wait',
    '  --start                       Start the job immediately after create',
    '  --scope job|stage|segment     Retry scope (default: job)',
    '  --stage <name>                Stage name for stage-scoped retry',
    '  --segment <id,id>             Segment ids for segment-scoped retry',
    '  --status <status>             Filter list and segments by status',
    '  --port <n>                    Port for the serve command',
    '',
    'Environment:',
    '  PORT, DUB_DATA_DIR, DUB_API_TOKEN, GEMINI_API_KEYS,',
    '  DUB_MEDIA_ENGINE (auto|ffmpeg|mock), DUB_FAKE_PROVIDER,',
    '  DUB_DEMUCS_ENABLED, DUB_TTS_CONCURRENCY, DUB_OTEL_ENABLED',
    '',
  ].join('\n');
}

export { BOOLEAN_FLAGS };
