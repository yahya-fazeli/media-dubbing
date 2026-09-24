import { api, ApiError, getToken, setToken } from './api.js';
import {
  el, clear, show, debounce, formatBytes, formatDateTime, formatDuration,
  percent, statusClass, truncate,
} from './dom.js';
import {
  renderPipeline, renderSegments, renderTranscript, renderTiming,
  renderWaveform, renderQuality, renderFailures, renderOutput,
} from './views.js';

/**
 * Studio controller. State lives in one object; rendering is a pure function of
 * state. The job list refreshes on a slow poll, while the selected job refreshes
 * on a faster poll only while it is active, so an idle Studio makes no requests.
 */

const STATE = {
  meta: null,
  jobs: [],
  selectedJobId: null,
  job: null,
  segments: [],
  transcript: null,
  failures: null,
  logs: [],
  running: false,
  activeTab: 'pipeline',
  segmentPage: 0,
  segmentPageSize: 50,
  segmentFilter: '',
  segmentSearch: '',
  jobFilter: '',
  statusFilter: '',
  inspectingSegment: null,
  waveformFor: null,
};

const POLL_ACTIVE_MS = 1500;
const POLL_IDLE_MS = 8000;

const dom = {};

function cacheDom() {
  const ids = [
    'banner', 'env-badges', 'refresh-btn', 'new-job-btn',
    'job-filter', 'status-filter', 'job-list', 'job-list-empty',
    'detail-empty', 'detail', 'detail-title', 'detail-sub', 'detail-controls',
    'detail-status', 'detail-progress', 'detail-summary',
    'tabs', 'pipeline-list', 'segment-status', 'segment-search', 'segment-count',
    'segment-list', 'seg-prev', 'seg-next', 'seg-page', 'retry-failed-segments',
    'transcript-meta', 'transcript-body', 'timing-chart', 'timing-table',
    'waveform', 'waveform-note', 'audio-segment',
    'quality-summary', 'quality-checks', 'quality-grades',
    'failure-list', 'stage-errors', 'retry-job-btn', 'output-body', 'log-view',
    'new-job-dialog', 'new-job-form', 'nj-file', 'nj-file-help', 'nj-source', 'nj-target',
    'nj-voices', 'nj-separate', 'nj-reencode', 'nj-autostart', 'nj-error', 'nj-cancel', 'nj-submit',
  ];
  for (const id of ids) dom[toCamel(id)] = document.getElementById(id);
}

function toCamel(id) {
  return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// --- Bootstrap -------------------------------------------------------------

async function init() {
  cacheDom();
  wireEvents();
  await loadMeta();
  await refreshJobs();
  selectTab('pipeline');
  schedulePoll();
}

async function loadMeta() {
  try {
    STATE.meta = await api.meta();
    renderBadges();
    populateLanguages();
    dom.njFileHelp.textContent = `Allowed: ${STATE.meta.supportedExtensions.join(', ')} · up to ${formatBytes(STATE.meta.limits.maxUploadBytes)}`;
  } catch (err) {
    showBanner(err.message, 'error');
  }
}

function renderBadges() {
  clear(dom.envBadges);
  const meta = STATE.meta;
  if (!meta) return;
  dom.envBadges.append(
    el('span', { class: `badge ${meta.engine.kind === 'ffmpeg' ? 'badge-ok' : 'badge-warn'}`, text: `engine: ${meta.engine.kind}`, title: meta.engine.reason }),
    el('span', { class: `badge ${meta.provider.kind === 'gemini' ? 'badge-ok' : 'badge-warn'}`, text: `provider: ${meta.provider.kind}`, title: meta.provider.reason }),
    meta.authRequired
      ? el('span', { class: 'badge', text: 'auth: required' })
      : el('span', { class: 'badge badge-warn', text: 'auth: open' }),
  );
}

function populateLanguages() {
  const languages = STATE.meta?.languages ?? [];
  const options = languages.map((lang) => el('option', { value: lang.code, text: `${lang.name} (${lang.code})` }));
  clear(dom.njSource);
  clear(dom.njTarget);
  for (const option of options) {
    dom.njSource.append(option.cloneNode(true));
    dom.njTarget.append(option.cloneNode(true));
  }
  dom.njSource.value = 'en';
  dom.njTarget.value = 'es';
}

// --- Polling ---------------------------------------------------------------

let pollTimer = null;

function schedulePoll() {
  clearTimeout(pollTimer);
  const interval = STATE.running ? POLL_ACTIVE_MS : POLL_IDLE_MS;
  pollTimer = setTimeout(async () => {
    await refreshJobs({ silent: true });
    if (STATE.selectedJobId) await refreshJob({ silent: true });
    schedulePoll();
  }, interval);
}

// --- Events ----------------------------------------------------------------

function wireEvents() {
  dom.refreshBtn.addEventListener('click', async () => {
    await refreshJobs();
    if (STATE.selectedJobId) await refreshJob();
  });

  dom.newJobBtn.addEventListener('click', () => {
    dom.njError.hidden = true;
    dom.newJobDialog.showModal();
  });
  dom.njCancel.addEventListener('click', () => dom.newJobDialog.close());
  dom.newJobForm.addEventListener('submit', handleCreateJob);

  dom.jobFilter.addEventListener('input', debounce((event) => {
    STATE.jobFilter = event.target.value.trim().toLowerCase();
    renderJobList();
  }, 120));

  dom.statusFilter.addEventListener('change', async (event) => {
    STATE.statusFilter = event.target.value;
    await refreshJobs();
  });

  dom.tabs.addEventListener('click', (event) => {
    const tab = event.target.closest('.tab');
    if (tab) selectTab(tab.dataset.tab);
  });

  dom.segmentStatus.addEventListener('change', (event) => {
    STATE.segmentFilter = event.target.value;
    STATE.segmentPage = 0;
    renderSegmentsView();
  });
  dom.segmentSearch.addEventListener('input', debounce((event) => {
    STATE.segmentSearch = event.target.value.trim();
    STATE.segmentPage = 0;
    renderSegmentsView();
  }, 150));
  dom.segPrev.addEventListener('click', () => {
    STATE.segmentPage = Math.max(0, STATE.segmentPage - 1);
    renderSegmentsView();
  });
  dom.segNext.addEventListener('click', () => {
    STATE.segmentPage += 1;
    renderSegmentsView();
  });
  dom.retryFailedSegments.addEventListener('click', retryFailedSegments);
  dom.retryJobBtn.addEventListener('click', () => retryJob('job'));

  // An unauthenticated API returns 401 once; prompt for the token and retry.
  window.addEventListener('youtube-dub:unauthorized', requestToken);
}

function requestToken() {
  const token = window.prompt('This API requires a bearer token (DUB_API_TOKEN):', getToken());
  if (token !== null) {
    setToken(token.trim());
    refreshJobs();
    if (STATE.selectedJobId) refreshJob();
  }
}

// --- Job list --------------------------------------------------------------

async function refreshJobs({ silent = false } = {}) {
  try {
    const result = await api.listJobs({ limit: 100, status: STATE.statusFilter || undefined });
    STATE.jobs = result.jobs ?? [];
    renderJobList();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!silent) showBanner(err.message, 'error');
  }
}

function renderJobList() {
  clear(dom.jobList);
  const filter = STATE.jobFilter;
  const jobs = STATE.jobs.filter((job) => {
    if (!filter) return true;
    const haystack = `${job.jobId} ${job.source.originalName} ${job.languages.source} ${job.languages.target} ${job.status}`.toLowerCase();
    return haystack.includes(filter);
  });

  show(dom.jobListEmpty, jobs.length === 0);
  dom.jobListEmpty.textContent = STATE.jobs.length === 0 ? 'No jobs yet.' : 'No jobs match the filter.';

  const fragment = document.createDocumentFragment();
  for (const job of jobs) {
    fragment.append(jobListItem(job));
  }
  dom.jobList.append(fragment);
}

function jobListItem(job) {
  const summary = job.segmentSummary ?? {};
  const progress = percent(summary.mixed ?? 0, summary.total ?? 0);
  const isActive = job.jobId === STATE.selectedJobId;
  return el('li', {
    class: `job-item${isActive ? ' is-active' : ''}`,
    onclick: () => selectJob(job.jobId),
  }, [
    el('div', { class: 'job-item-top' }, [
      el('span', { class: 'job-id', text: job.jobId, title: job.jobId }),
      el('span', { class: `pill ${statusClass(job.status)}`, text: job.status }),
    ]),
    el('div', { class: 'job-meta' }, [
      el('span', { text: `${job.languages.source} → ${job.languages.target}` }),
      el('span', { text: truncate(job.source.originalName, 24) }),
      el('span', { text: `${summary.total ?? 0} seg` }),
    ]),
    el('div', { class: 'job-bar', title: `${progress}% segments mixed` }, [
      el('span', { style: `width:${progress}%` }),
    ]),
  ]);
}

// --- Job detail ------------------------------------------------------------

async function selectJob(jobId) {
  STATE.selectedJobId = jobId;
  STATE.segmentPage = 0;
  STATE.inspectingSegment = null;
  STATE.waveformFor = null;
  renderJobList();
  await refreshJob();
}

async function refreshJob({ silent = false } = {}) {
  const jobId = STATE.selectedJobId;
  if (!jobId) return;
  try {
    const [detail, segments, failures] = await Promise.all([
      api.getJob(jobId, { segments: false }),
      api.getSegments(jobId, { limit: 100000 }),
      api.failures(jobId).catch(() => ({ failures: [], stageErrors: {} })),
    ]);
    STATE.job = detail.job;
    STATE.logs = detail.logs ?? [];
    STATE.running = detail.running;
    STATE.segments = segments.segments ?? [];
    STATE.failures = failures;
    renderDetail();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleUnauthorized();
      return;
    }
    if (!silent) showBanner(err.message, 'error');
    if (err instanceof ApiError && err.status === 404) {
      STATE.selectedJobId = null;
      STATE.job = null;
      renderDetail();
    }
  }
}

function renderDetail() {
  const job = STATE.job;
  show(dom.detailEmpty, !job);
  show(dom.detail, Boolean(job));
  if (!job) return;

  dom.detailTitle.textContent = job.jobId;
  dom.detailSub.textContent =
    `${job.source.originalName} · ${job.languages.source} → ${job.languages.target}`
    + ` · created ${formatDateTime(job.createdAt)}`;

  clear(dom.detailStatus);
  dom.detailStatus.className = `pill ${statusClass(job.status)}`;
  dom.detailStatus.textContent = job.status;

  const summary = job.segmentSummary ?? {};
  dom.detailProgress.textContent =
    `${summary.mixed ?? 0}/${summary.total ?? 0} segments mixed`
    + (summary.failed ? ` · ${summary.failed} failed` : '')
    + (job.quality ? ` · quality: ${job.quality.overall}` : '')
    + (STATE.running ? ' · running' : '');

  renderControls(job);
  renderSummary(job);
  renderPipeline(dom.pipelineList, job);
  renderSegmentsView();
  renderTiming(dom.timingChart, dom.timingTable, job, STATE.segments);
  renderQuality(dom.qualitySummary, dom.qualityChecks, dom.qualityGrades, job);
  renderFailures(dom.failureList, dom.stageErrors, job, STATE.failures);
  renderOutput(dom.outputBody, job);
  renderLogs();
  renderTranscriptView();
  renderAudioView();
}

function renderControls(job) {
  clear(dom.detailControls);
  const running = STATE.running;
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);

  const buttons = [];
  if (!running && (job.status === 'created' || job.status === 'cancelled' || job.status === 'failed')) {
    buttons.push(el('button', {
      class: 'btn btn-primary', type: 'button', text: 'Start', onclick: () => startJob(),
    }));
  }
  if (!running && terminal) {
    buttons.push(el('button', {
      class: 'btn btn-ghost', type: 'button', text: 'Resume', title: 'Continue from the last completed stage',
      onclick: () => retryJob('job'),
    }));
  }
  if (running || job.status === 'running') {
    buttons.push(el('button', {
      class: 'btn btn-danger', type: 'button', text: 'Cancel', onclick: () => cancelJob(),
    }));
  }
  buttons.push(el('button', {
    class: 'btn btn-ghost', type: 'button', text: 'Delete',
    onclick: () => deleteJob(),
  }));
  dom.detailControls.append(...buttons);
}

function renderSummary(job) {
  clear(dom.detailSummary);
  const summary = job.segmentSummary ?? {};
  const stats = [
    ['Segments', summary.total ?? 0],
    ['Translated', summary.translated ?? 0],
    ['Synthesized', summary.synthesized ?? 0],
    ['Fitted', summary.fitted ?? 0],
    ['Mixed', summary.mixed ?? 0],
    ['Failed', summary.failed ?? 0],
    ['Duration', formatDuration(job.source.durationSeconds)],
    ['TTS audio', formatDuration(job.metrics?.ttsAudioSeconds ?? 0)],
  ];
  dom.detailSummary.append(...stats.map(([label, value]) => el('div', { class: 'stat' }, [
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-value', text: String(value) }),
  ])));
}

function renderSegmentsView() {
  const result = renderSegments(dom.segmentList, {
    segments: STATE.segments,
    page: STATE.segmentPage,
    pageSize: STATE.segmentPageSize,
    filter: STATE.segmentFilter,
    search: STATE.segmentSearch,
    onRetrySegment: (segmentId) => retrySegments([segmentId]),
    onInspectSegment: (segment) => inspectSegment(segment),
  });
  STATE.segmentPage = result.page;
  dom.segmentCount.textContent = `${result.total} segment(s)`;
  dom.segPage.textContent = `Page ${result.page + 1} of ${result.totalPages}`;
  dom.segPrev.disabled = result.page === 0;
  dom.segNext.disabled = result.page >= result.totalPages - 1;
}

function renderLogs() {
  dom.logView.textContent = STATE.logs.length
    ? STATE.logs.map((line) => {
        const fields = line.fields ? ` ${JSON.stringify(line.fields)}` : '';
        return `${timeOf(line.ts)} ${String(line.level ?? '').toUpperCase().padEnd(5)} ${line.msg}${fields}`;
      }).join('\n')
    : 'No log lines recorded for this job yet.';
}

function timeOf(iso) {
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return '';
  }
}

async function renderTranscriptView() {
  if (!STATE.selectedJobId) return;
  if (STATE.transcript === null) {
    try {
      STATE.transcript = await api.transcript(STATE.selectedJobId);
    } catch {
      STATE.transcript = {};
    }
  }
  renderTranscript(dom.transcriptBody, dom.transcriptMeta, STATE.transcript, STATE.job, STATE.segments);
}

async function renderAudioView() {
  const job = STATE.job;
  if (!job) return;
  const audioRelative = job.artifacts?.dubbedAudio;
  if (!audioRelative) {
    renderWaveform(dom.waveform, dom.waveformNote, job, null, STATE.segments);
    return;
  }
  // Only fetch and decode when the artifact actually changed, so polling does
  // not repeatedly download the full mix.
  if (STATE.waveformFor === audioRelative) return;
  STATE.waveformFor = audioRelative;
  try {
    const blob = await api.artifactBlob(job.jobId, audioRelative);
    await renderWaveform(dom.waveform, dom.waveformNote, job, blob, STATE.segments);
  } catch (err) {
    dom.waveformNote.textContent = `Could not load the waveform: ${err.message}`;
  }
}

function inspectSegment(segment) {
  STATE.inspectingSegment = segment;
  clear(dom.audioSegment);
  const lines = [
    ['Segment', segment.segmentId],
    ['Window', `${segment.start.toFixed(2)}s – ${segment.end.toFixed(2)}s (${segment.durationSeconds.toFixed(2)}s)`],
    ['Status', segment.status],
    ['Voice', segment.voice ?? '—'],
    ['Attempts', String(segment.attempts ?? 0)],
    ['Source', segment.sourceText],
    ['Translation', segment.translatedText],
    ['Speech', segment.alignment ? `${segment.alignment.speechSeconds}s` : '—'],
    ['Fit', segment.alignment ? `${segment.alignment.fitRatio}× (${segment.alignment.grade})` : '—'],
    ['Tempo', segment.timing ? `${segment.timing.appliedTempo}× ${segment.timing.action}` : '—'],
  ];
  dom.audioSegment.append(el('dl', {}, lines.flatMap(([label, value]) => [
    el('dt', { class: 'muted', text: label }),
    el('dd', { text: String(value ?? '—') }),
  ])));

  if (segment.hasTtsAudio) {
    dom.audioSegment.append(el('audio', {
      controls: 'controls',
      preload: 'none',
      src: api.artifactUrl(STATE.selectedJobId, `tts/${segment.segmentId}.wav`),
    }));
    dom.audioSegment.append(el('p', {}, el('a', {
      class: 'btn btn-sm btn-ghost',
      href: api.artifactUrl(STATE.selectedJobId, `tts/${segment.segmentId}.wav`, { download: true }),
      text: 'Download segment audio',
    })));
  } else {
    dom.audioSegment.append(el('p', { class: 'muted', text: 'No synthesized audio for this segment.' }));
  }
}

// --- Actions ---------------------------------------------------------------

async function handleCreateJob(event) {
  event.preventDefault();
  const file = dom.njFile.files?.[0];
  if (!file) {
    dom.njError.hidden = false;
    dom.njError.textContent = 'Choose a source file.';
    return;
  }
  dom.njError.hidden = true;
  dom.njSubmit.disabled = true;
  dom.njSubmit.textContent = 'Creating…';

  const form = new FormData();
  form.append('file', file, file.name);
  form.append('sourceLanguage', dom.njSource.value);
  form.append('targetLanguage', dom.njTarget.value);
  if (dom.njVoices.value.trim()) form.append('voices', dom.njVoices.value.trim());
  if (dom.njSeparate.checked) form.append('separateVocals', 'true');
  if (dom.njReencode.checked) form.append('reencodeVideo', 'true');
  form.append('autoStart', dom.njAutostart.checked ? 'true' : 'false');

  try {
    const result = await api.createJob(form);
    dom.newJobDialog.close();
    dom.newJobForm.reset();
    STATE.transcript = null;
    await refreshJobs();
    await selectJob(result.job.jobId);
    showBanner(`Created ${result.job.jobId}`, 'info');
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      handleUnauthorized();
    } else {
      dom.njError.hidden = false;
      dom.njError.textContent = err.message;
    }
  } finally {
    dom.njSubmit.disabled = false;
    dom.njSubmit.textContent = 'Create job';
  }
}

async function startJob() {
  await runAction('Starting job…', () => api.start(STATE.selectedJobId));
}

async function cancelJob() {
  if (!window.confirm('Cancel this job? Completed segment work is preserved and the job can be resumed.')) return;
  await runAction('Cancelling…', () => api.cancel(STATE.selectedJobId, 'Cancelled from the Studio'));
}

async function retryJob(scope, stage = null, segmentIds = null) {
  await runAction('Retrying…', () => api.retry(STATE.selectedJobId, { scope, stage, segmentIds }));
}

async function retrySegments(segmentIds) {
  await runAction(`Retrying ${segmentIds.length} segment(s)…`, () => api.retry(STATE.selectedJobId, {
    scope: 'segment',
    segmentIds,
  }));
}

async function retryFailedSegments() {
  const failed = STATE.segments.filter((s) => s.status === 'failed').map((s) => s.segmentId);
  if (!failed.length) {
    showBanner('No failed segments to retry.', 'info');
    return;
  }
  await retrySegments(failed);
}

async function deleteJob() {
  if (!window.confirm('Delete this job and all of its artifacts? This cannot be undone.')) return;
  try {
    await api.deleteJob(STATE.selectedJobId);
    STATE.selectedJobId = null;
    STATE.job = null;
    STATE.transcript = null;
    STATE.waveformFor = null;
    await refreshJobs();
    renderDetail();
    showBanner('Job deleted.', 'info');
  } catch (err) {
    showBanner(err.message, 'error');
  }
}

async function runAction(message, fn) {
  showBanner(message, 'info');
  try {
    await fn();
    STATE.transcript = null;
    STATE.waveformFor = null;
    await refreshJobs();
    await refreshJob();
    hideBanner();
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) handleUnauthorized();
    else showBanner(err.message, 'error');
  }
}

function handleUnauthorized() {
  showBanner('Authentication required. Enter an API token to continue.', 'error');
  requestToken();
}

// --- Tabs and banner -------------------------------------------------------

function selectTab(name) {
  STATE.activeTab = name;
  for (const tab of dom.tabs.querySelectorAll('.tab')) {
    tab.classList.toggle('is-active', tab.dataset.tab === name);
  }
  for (const panel of document.querySelectorAll('.tab-panel')) {
    panel.classList.toggle('is-active', panel.dataset.panel === name);
  }
  // Re-render the newly visible panel so it reflects the latest state.
  if (name === 'segments') renderSegmentsView();
  if (name === 'timing' && STATE.job) renderTiming(dom.timingChart, dom.timingTable, STATE.job, STATE.segments);
  if (name === 'output' && STATE.job) renderOutput(dom.outputBody, STATE.job);
  if (name === 'audio') renderAudioView();
  if (name === 'transcript') renderTranscriptView();
}

let bannerTimer = null;
function showBanner(message, kind = 'info') {
  clearTimeout(bannerTimer);
  dom.banner.textContent = message;
  dom.banner.className = `banner banner-${kind}`;
  dom.banner.hidden = false;
  if (kind === 'info') bannerTimer = setTimeout(hideBanner, 4000);
}
function hideBanner() {
  dom.banner.hidden = true;
}

init().catch((err) => {
  const banner = document.getElementById('banner');
  if (banner) {
    banner.textContent = `Studio failed to start: ${err.message}`;
    banner.className = 'banner banner-error';
    banner.hidden = false;
  }
});
