import { el, clear, formatDuration, formatSeconds, truncate, statusClass } from './dom.js';

/**
 * Renders the pipeline stage list. Each stage shows its status, duration, and
 * either its error, its skip reason, or a short summary of what it produced.
 */

const STAGE_LABELS = {
  ingest: 'Ingest',
  audio_extract: 'Audio extraction',
  vocal_separation: 'Vocal separation',
  transcription: 'Transcription',
  segmentation: 'Segmentation',
  translation: 'Translation',
  tts: 'Speech synthesis',
  alignment: 'Alignment',
  timing: 'Timing / fitting',
  mixing: 'Audio mixing',
  rendering: 'Video rendering',
  quality: 'Quality validation',
};

export function renderPipeline(container, job) {
  clear(container);
  const stages = Object.values(job.stages ?? {});
  const currentStage = Object.values(job.stages ?? {}).find((s) => s.status === 'running')?.name
    ?? job.resume?.nextStage;

  for (const stage of stages) {
    const note = stageNote(stage);
    const dot = el('span', {
      class: `pipeline-dot dot-${stage.status}`,
      title: stage.status,
    });
    const row = el('li', { class: `pipeline-step${stage.name === currentStage ? ' is-current' : ''}` }, [
      dot,
      el('span', { class: 'pipeline-name', text: STAGE_LABELS[stage.name] ?? stage.name }),
      el('span', { class: `pill ${statusClass(stage.status)}`, text: stage.status }),
      el('span', { class: 'mono muted', text: stage.durationMs != null ? `${(stage.durationMs / 1000).toFixed(1)}s` : '—' }),
      el('span', { class: 'pipeline-note', text: note }),
    ]);
    container.append(row);
  }
}

function stageNote(stage) {
  if (stage.error?.message) return stage.error.message;
  if (stage.skipReason) return stage.skipReason;
  if (stage.attempts > 1) return `Attempt ${stage.attempts}`;
  const meta = stage.metadata;
  if (!meta) return '';
  switch (stage.name) {
    case 'ingest':
      return `${formatDuration(meta.durationSeconds)} · ${meta.hasVideo ? 'video + audio' : 'audio only'}`;
    case 'audio_extract':
      return meta.copied ? 'Reused source audio (already WAV)' : `Extracted @ ${meta.sampleRate} Hz`;
    case 'vocal_separation':
      return meta.separated ? `Separated with ${meta.model ?? 'model'}` : (meta.reason ?? 'Not separated');
    case 'transcription':
      return `${meta.wordCount} words${meta.provider ? ` via ${meta.provider}` : ''}`;
    case 'segmentation':
      return `${meta.segmentCount} segments (avg ${formatSeconds(meta.averageSeconds)})`;
    case 'translation':
      return `${meta.translated} translated, ${meta.reused ?? 0} reused, ${meta.failed ?? 0} failed`;
    case 'tts':
      return `${meta.synthesized} synthesized, ${meta.reused ?? 0} reused, ${meta.failed ?? 0} failed`;
    case 'alignment':
      return `ok ${meta.grades?.ok ?? 0} · warn ${meta.grades?.warn ?? 0} · fail ${meta.grades?.fail ?? 0}`;
    case 'timing':
      return `${meta.fitted} fitted, ${meta.segmentsNeedingTrim ?? 0} needing trim`;
    case 'mixing':
      return `${meta.mixed} mixed, ${meta.skipped ?? 0} skipped${meta.background ? ', with background' : ''}`;
    case 'rendering':
      return `${meta.container}, video ${meta.videoReencoded ? 're-encoded' : 'copied'}`;
    case 'quality':
      return `${meta.overall} (${meta.failureCount} failed, ${meta.warningCount} warned)`;
    default:
      return '';
  }
}

/**
 * Renders the segment table with client-side paging and filtering. The table is
 * built from a document fragment so a job with hundreds of rows still paints in
 * one pass.
 */
export function renderSegments(container, state) {
  clear(container);
  const { segments, page, pageSize, filter, search } = state;
  const filtered = segments.filter((segment) => {
    if (filter && segment.status !== filter) return false;
    if (search) {
      const haystack = `${segment.sourceText} ${segment.translatedText} ${segment.segmentId}`.toLowerCase();
      if (!haystack.includes(search.toLowerCase())) return false;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);
  const slice = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  const fragment = document.createDocumentFragment();
  for (const segment of slice) {
    fragment.append(segmentRow(segment, state));
  }
  container.append(fragment);

  return { total: filtered.length, page: safePage, totalPages, shown: slice.length };
}

function segmentRow(segment, state) {
  const fit = segment.timing
    ? `${segment.timing.appliedTempo}× ${segment.timing.action}`
    : (segment.alignment ? `${segment.alignment.fitRatio}×` : '—');

  const grade = segment.quality?.alignment?.grade;
  const canRetry = segment.status === 'failed' || Boolean(segment.error);

  return el('li', { class: `segment-row${segment.status === 'failed' ? ' is-failed' : ''}` }, [
    el('span', { class: 'mono', text: segment.segmentId }),
    el('span', {
      class: 'mono muted',
      text: `${segment.start.toFixed(1)}–${segment.end.toFixed(1)}s`,
      title: `${segment.durationSeconds.toFixed(2)}s window`,
    }),
    el('span', { class: `pill ${statusClass(segment.status)}`, text: segment.status }),
    el('span', {
      class: `mono${grade === 'fail' ? ' ' : ''} muted`,
      text: fit,
      title: segment.alignment?.reason ?? '',
    }),
    el('span', { class: 'segment-text', text: truncate(segment.translatedText || segment.sourceText, 90) }),
    el('span', { class: 'segment-actions' }, [
      canRetry
        ? el('button', {
            class: 'btn btn-sm btn-ghost',
            type: 'button',
            title: 'Retry this segment',
            text: 'Retry',
            onclick: () => state.onRetrySegment(segment.segmentId),
          })
        : null,
      el('button', {
        class: 'btn btn-sm btn-ghost',
        type: 'button',
        title: 'Inspect this segment',
        text: 'Inspect',
        onclick: () => state.onInspectSegment(segment),
      }),
    ]),
  ]);
}

/** Renders the word-level transcript grouped by segment window. */
export function renderTranscript(container, metaNode, data, job, segments = []) {
  clear(container);
  const transcript = data?.transcript;
  if (!transcript) {
    metaNode.textContent = 'No transcript is available yet.';
    return;
  }
  metaNode.textContent = `${transcript.wordCount} words · ${transcript.language} · ${formatDuration(transcript.durationSeconds)}`
    + (transcript.provider ? ` · via ${transcript.provider}` : '');

  // Words are grouped into the segments they belong to so the reader can see how
  // the transcript was divided, which is what drives per-segment retries.
  const words = data.words ?? [];
  let cursor = 0;

  for (const segment of segments) {
    const inSegment = [];
    while (cursor < words.length && words[cursor].start < segment.end - 0.001) {
      inSegment.push(words[cursor]);
      cursor += 1;
    }
    if (!inSegment.length) continue;
    container.append(el('div', { class: 'transcript-segment' }, [
      el('div', { class: 'transcript-window', text: `${segment.segmentId} · ${segment.start.toFixed(1)}–${segment.end.toFixed(1)}s` }),
      el('div', { class: 'transcript' }, inSegment.map((word) => el('span', {
        class: 'word has-segment',
        text: word.text,
        title: `${word.start.toFixed(2)}–${word.end.toFixed(2)}s`,
      }))),
    ]));
  }

  // Any words past the last segment are still shown, so a mismatch between
  // segmentation and transcription is visible rather than silently dropped.
  if (cursor < words.length) {
    container.append(el('div', { class: 'transcript-segment' }, [
      el('div', { class: 'transcript-window', text: 'unsegmented' }),
      el('div', { class: 'transcript' }, words.slice(cursor).map((word) => el('span', {
        class: 'word', text: word.text, title: `${word.start.toFixed(2)}–${word.end.toFixed(2)}s`,
      }))),
    ]));
  }
}

/**
 * Renders the timing chart: one row per segment with the source window as the
 * track and the generated speech length as the fill, so drift is visible at a
 * glance.
 */
export function renderTiming(chartNode, tableNode, job, segments = []) {
  clear(chartNode);
  clear(tableNode);
  if (!segments.length) {
    chartNode.append(el('p', { class: 'muted', text: 'No segments to display yet.' }));
    return;
  }

  const totalDuration = Math.max(job.source?.durationSeconds ?? 0, ...segments.map((s) => s.end), 1);
  const maxSpeech = Math.max(1, ...segments.map((s) => s.alignment?.speechSeconds ?? s.durationSeconds));

  const fragment = document.createDocumentFragment();
  for (const segment of segments) {
    const speech = segment.alignment?.speechSeconds ?? null;
    const over = speech !== null && speech > segment.durationSeconds;
    const trimmed = (segment.timing?.trimmedSeconds ?? 0) > 0;

    const track = el('div', { class: 'timing-track' }, [
      // Position of the segment window on the whole-timeline axis.
      el('div', {
        class: 'timing-fill',
        style: `left:${(segment.start / totalDuration) * 100}%;width:${(segment.durationSeconds / totalDuration) * 100}%;opacity:.35`,
      }),
      speech !== null
        ? el('div', {
            class: `timing-fill${trimmed ? ' is-trim' : (over ? ' is-over' : '')}`,
            style: `left:${(segment.start / totalDuration) * 100}%;width:${(speech / totalDuration) * 100}%`,
            title: `speech ${speech.toFixed(2)}s in a ${segment.durationSeconds.toFixed(2)}s window`,
          })
        : null,
    ]);

    fragment.append(el('div', { class: 'timing-row' }, [
      el('span', { class: 'mono', text: segment.segmentId }),
      track,
      el('span', {
        class: 'mono muted',
        text: speech !== null
          ? `${speech.toFixed(2)}s / ${segment.durationSeconds.toFixed(2)}s`
          : 'no audio',
      }),
    ]));
  }
  chartNode.append(fragment);

  // A summary table keeps the exact numbers available alongside the chart.
  const rows = segments.map((s) => el('tr', {}, [
    el('td', { class: 'mono', text: s.segmentId }),
    el('td', { text: s.start.toFixed(2) }),
    el('td', { text: s.end.toFixed(2) }),
    el('td', { text: s.durationSeconds.toFixed(2) }),
    el('td', { text: s.alignment?.speechSeconds?.toFixed(2) ?? '—' }),
    el('td', { text: s.alignment?.driftSeconds?.toFixed(2) ?? '—' }),
    el('td', { text: s.timing?.appliedTempo ?? '—' }),
    el('td', { text: s.timing?.action ?? '—' }),
    el('td', { text: s.timing?.trimmedSeconds ? `-${s.timing.trimmedSeconds.toFixed(2)}s` : '—' }),
  ]));

  tableNode.append(el('table', {}, [
    el('thead', {}, el('tr', {}, [
      'Segment', 'Start', 'End', 'Window', 'Speech', 'Drift', 'Tempo', 'Action', 'Trimmed',
    ].map((label) => el('th', { text: label })))),
    el('tbody', {}, rows),
  ]));
}

/**
 * Draws a peak envelope for the mixed dialogue track. Decoding happens in the
 * browser via WebAudio so the server never has to send waveform data.
 */
export async function renderWaveform(canvas, noteNode, job, blob, segments = []) {
  const ctx = canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  ctx.clearRect(0, 0, width, height);

  if (!blob) {
    noteNode.textContent = 'The mixed dialogue track is not available yet.';
    return;
  }

  noteNode.textContent = 'Analyzing…';
  let audioBuffer;
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const AudioCtx = window.AudioContext ?? window.webkitAudioContext;
    const audioCtx = new AudioCtx();
    try {
      audioBuffer = await audioCtx.decodeAudioData(arrayBuffer.slice(0));
    } finally {
      audioCtx.close?.();
    }
  } catch (err) {
    noteNode.textContent = `Could not decode the audio for display: ${err.message}`;
    return;
  }

  const data = audioBuffer.getChannelData(0);
  const buckets = 400;
  const perBucket = Math.max(1, Math.floor(data.length / buckets));
  const peaks = new Array(buckets).fill(0);
  for (let b = 0; b < buckets; b += 1) {
    let peak = 0;
    const start = b * perBucket;
    const end = Math.min(data.length, start + perBucket);
    for (let i = start; i < end; i += 1) {
      const value = Math.abs(data[i]);
      if (value > peak) peak = value;
    }
    peaks[b] = peak;
  }

  const styles = getComputedStyle(document.documentElement);
  const accent = styles.getPropertyValue('--accent').trim() || '#4f9cf9';
  const mid = height / 2;

  ctx.fillStyle = accent;
  const barWidth = width / buckets;
  for (let b = 0; b < buckets; b += 1) {
    const amplitude = Math.min(1, peaks[b]) * (height / 2 - 4);
    ctx.fillRect(b * barWidth, mid - amplitude, Math.max(1, barWidth - 1), amplitude * 2);
  }

  // Overlay segment boundaries so the waveform lines up with the segment table.
  const total = job.source?.durationSeconds ?? audioBuffer.duration;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--border-strong').trim() || '#3a4759';
  ctx.lineWidth = 1;
  for (const segment of segments) {
    const x = (segment.end / total) * width;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }

  noteNode.textContent = `${audioBuffer.duration.toFixed(2)}s · ${audioBuffer.numberOfChannels} channel(s)`
    + ` · ${audioBuffer.sampleRate} Hz · ${segments.length} segment markers`;
}

/** Renders quality checks and per-segment grades. */
export function renderQuality(summaryNode, checksNode, gradesNode, job) {
  clear(summaryNode);
  clear(checksNode);
  clear(gradesNode);

  const quality = job?.quality;
  if (!quality) {
    summaryNode.append(el('p', { class: 'muted', text: 'Quality validation has not run yet.' }));
    return;
  }

  summaryNode.append(el('p', {
    text: quality.summary,
    style: quality.overall === 'fail' ? 'color:var(--fail)' : (quality.overall === 'warn' ? 'color:var(--warn)' : 'color:var(--ok)'),
  }));

  for (const check of quality.checks ?? []) {
    const icon = { pass: '✓', warn: '!', fail: '✕', skip: '–' }[check.status] ?? '?';
    const detail = check.message
      ?? Object.entries(check)
        .filter(([k]) => !['id', 'status', 'message'].includes(k))
        .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' · ');
    checksNode.append(el('li', { class: `check check-${check.status}` }, [
      el('span', { class: 'check-icon', text: icon }),
      el('span', { class: 'check-id', text: check.id }),
      el('span', { class: 'muted', text: detail }),
    ]));
  }

  const grades = quality.segmentGrades ?? {};
  gradesNode.append(...Object.entries(grades).map(([grade, count]) => el('span', {
    class: `grade grade-${grade}`,
    text: `${grade}: ${count}`,
  })));
}

/** Renders structured failures with their recommended recovery action. */
export function renderFailures(listNode, stageErrorsNode, job, data) {
  clear(listNode);
  clear(stageErrorsNode);

  const failures = data?.failures ?? job?.failures ?? [];
  if (!failures.length) {
    listNode.append(el('li', { class: 'muted', text: 'No failures recorded.' }));
  } else {
    for (const failure of failures) {
      const error = failure.error ?? {};
      listNode.append(el('li', { class: 'failure' }, [
        el('div', { class: 'failure-head' }, [
          el('span', { class: 'failure-code', text: error.code ?? 'ERROR' }),
          el('span', { class: 'failure-where', text: [failure.stage, failure.segmentId].filter(Boolean).join(' / ') || 'job' }),
          el('span', { class: 'muted', text: new Date(failure.at).toLocaleTimeString() }),
          error.retryable
            ? el('span', { class: 'pill pill-running', text: 'retryable' })
            : el('span', { class: 'pill pill-cancelled', text: 'not retryable' }),
        ]),
        el('div', { text: error.message ?? 'Unknown error' }),
        error.recommendedAction
          ? el('div', { class: 'failure-action', text: `→ ${error.recommendedAction}` })
          : null,
        el('div', { class: 'muted mono', text: `scope: ${error.recoveryScope ?? 'none'}` }),
      ]));
    }
  }

  const stageErrors = data?.stageErrors ?? {};
  const entries = Object.entries(stageErrors);
  if (!entries.length) {
    stageErrorsNode.append(el('p', { class: 'muted', text: 'No stage-level errors.' }));
  } else {
    for (const [stage, error] of entries) {
      stageErrorsNode.append(el('div', { class: 'stage-error' }, [
        el('strong', { text: stage }),
        el('div', { class: 'muted', text: error.message ?? '' }),
        error.recommendedAction ? el('div', { class: 'failure-action', text: `→ ${error.recommendedAction}` }) : null,
      ]));
    }
  }
}

/** Renders the final artifact players and download links. */
export function renderOutput(container, job) {
  clear(container);
  const artifacts = job?.artifacts ?? {};

  if (artifacts.finalVideo) {
    container.append(el('div', { class: 'artifact-card' }, [
      el('h3', { text: 'Final dubbed video' }),
      el('video', {
        class: 'artifact-video',
        controls: 'controls',
        preload: 'metadata',
        src: `/api/jobs/${encodeURIComponent(job.jobId)}/artifacts/${artifacts.finalVideo}`,
      }),
      el('div', { class: 'artifact-actions' }, [
        el('a', {
          class: 'btn btn-ghost',
          href: `/api/jobs/${encodeURIComponent(job.jobId)}/artifacts/${artifacts.finalVideo}?download=true`,
          text: 'Download video',
        }),
      ]),
    ]));
  } else {
    container.append(el('p', { class: 'muted', text: 'No rendered video yet.' }));
  }

  if (artifacts.dubbedAudio) {
    container.append(el('div', { class: 'artifact-card' }, [
      el('h3', { text: 'Dubbed audio track' }),
      el('audio', {
        controls: 'controls',
        preload: 'none',
        src: `/api/jobs/${encodeURIComponent(job.jobId)}/artifacts/${artifacts.dubbedAudio}`,
      }),
      el('div', { class: 'artifact-actions' }, [
        el('a', {
          class: 'btn btn-ghost',
          href: `/api/jobs/${encodeURIComponent(job.jobId)}/artifacts/${artifacts.dubbedAudio}?download=true`,
          text: 'Download audio',
        }),
      ]),
    ]));
  }

  const other = Object.entries(artifacts).filter(
    ([key, value]) => value && !['finalVideo', 'dubbedAudio'].includes(key),
  );
  if (other.length) {
    container.append(el('div', { class: 'artifact-card' }, [
      el('h3', { text: 'Intermediate artifacts' }),
      el('ul', {}, other.map(([key, value]) => el('li', {}, [
        el('span', { class: 'muted', text: `${key}: ` }),
        el('a', {
          href: `/api/jobs/${encodeURIComponent(job.jobId)}/artifacts/${value}`,
          text: value,
        }),
      ]))),
    ]));
  }
}
