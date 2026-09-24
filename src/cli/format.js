/**
 * Terminal formatting helpers. Output is plain text with stable column widths so
 * it can be piped into other tools without ANSI noise.
 */

const STATUS_WIDTH = 10;

export function formatJobLine(job) {
  const created = shortTime(job.createdAt);
  const duration = job.metrics?.totalDurationMs ? `${Math.round(job.metrics.totalDurationMs / 1000)}s` : '-';
  const progress = job.segmentSummary
    ? `${job.segmentSummary.mixed ?? 0}/${job.segmentSummary.total ?? 0}`
    : '-';
  return [
    job.jobId.padEnd(34),
    pad(job.status, STATUS_WIDTH),
    `${job.languages.source}->${job.languages.target}`.padEnd(10),
    progress.padEnd(10),
    duration.padEnd(8),
    created,
  ].join('  ');
}

export function formatJobDetail(job) {
  const lines = [];
  lines.push(`Job ${job.jobId}`);
  lines.push(`  status:     ${job.status}`);
  lines.push(`  languages:  ${job.languages.source} -> ${job.languages.target}`);
  lines.push(`  source:     ${job.source.originalName} (${round(job.source.durationSeconds ?? 0, 1)}s)`);
  lines.push(`  created:    ${job.createdAt}`);
  lines.push(`  updated:    ${job.updatedAt}`);
  if (job.finishedAt) lines.push(`  finished:   ${job.finishedAt}`);
  lines.push(`  provider:   ${job.providerInfo?.provider ?? '-'} / engine: ${job.providerInfo?.engine ?? '-'}`);
  if (job.resume?.nextStage) lines.push(`  resume at:  ${job.resume.nextStage}`);

  lines.push('');
  lines.push('Stages:');
  for (const [name, stage] of Object.entries(job.stages)) {
    const timing = stage.durationMs != null ? `${Math.round(stage.durationMs / 1000)}s` : '-';
    const detail = stage.error?.message ?? stage.skipReason ?? stage.metadata?.summary ?? '';
    lines.push(`  ${pad(name, 20)} ${pad(stage.status, STATUS_WIDTH)} ${pad(timing, 7)} ${trim(detail, 70)}`);
  }

  lines.push('');
  const s = job.segmentSummary ?? {};
  lines.push(`Segments: ${s.total ?? 0} total, ${s.mixed ?? 0} mixed, ${s.failed ?? 0} failed, ${s.skipped ?? 0} skipped`);

  if (job.quality) {
    lines.push('');
    lines.push(`Quality: ${job.quality.overall} - ${job.quality.summary}`);
  }

  const final = job.artifacts?.finalVideo;
  if (final) {
    lines.push('');
    lines.push(`Final artifact: ${final}`);
  }
  return lines.join('\n');
}

export function formatSegments(segments, limit = 50, statusFilter = null) {
  const filtered = statusFilter ? segments.filter((s) => s.status === statusFilter) : segments;
  const lines = [`Segments (${filtered.length}${statusFilter ? ` matching ${statusFilter}` : ''}):`];
  lines.push(`  ${'id'.padEnd(12)} ${'window'.padEnd(17)} ${'status'.padEnd(12)} ${'tempo'.padEnd(7)} text`);
  for (const segment of filtered.slice(0, limit)) {
    const window = `${round(segment.start, 1)}-${round(segment.end, 1)}s`.padEnd(17);
    const tempo = segment.timing?.appliedTempo != null ? `${round(segment.timing.appliedTempo, 2)}` : '-';
    const text = segment.translatedText || segment.sourceText || '';
    lines.push(
      `  ${pad(segment.segmentId, 12)} ${window} ${pad(segment.status, 12)} ${pad(tempo, 7)} ${trim(text, 60)}`,
    );
  }
  if (filtered.length > limit) lines.push(`  ... ${filtered.length - limit} more`);
  return lines.join('\n');
}

export function formatFailures(job) {
  const lines = [`Failures (${job.failures?.length ?? 0}):`];
  if (!job.failures?.length) {
    lines.push('  none');
    return lines.join('\n');
  }
  for (const failure of job.failures.slice(-25)) {
    const where = [failure.stage, failure.segmentId].filter(Boolean).join(' / ');
    lines.push(`  [${failure.error?.code ?? 'ERROR'}] ${where}`);
    lines.push(`      ${failure.error?.message ?? 'unknown error'}`);
    if (failure.error?.recommendedAction) {
      lines.push(`      -> ${failure.error.recommendedAction}`);
    }
  }
  return lines.join('\n');
}

function pad(value, width) {
  return String(value ?? '').padEnd(width);
}

function trim(value, width) {
  const str = String(value ?? '').replace(/\s+/g, ' ');
  return str.length > width ? `${str.slice(0, width - 3)}...` : str;
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(Number(value) * factor) / factor;
}

function shortTime(iso) {
  if (!iso) return '-';
  return String(iso).replace('T', ' ').replace(/\..*$/, '');
}
