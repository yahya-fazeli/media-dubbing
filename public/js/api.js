/**
 * Thin API client for the Studio. A bearer token entered by the operator is kept
 * in sessionStorage only — never in a cookie or localStorage — so it does not
 * outlive the tab or travel with cross-site requests.
 */

const TOKEN_KEY = 'youtube-dub.api-token';

export function getToken() {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    // Private browsing may block storage; the app still works with an open API.
  }
}

export class ApiError extends Error {
  constructor(message, { status, code, recoveryScope, recommendedAction, details } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.recoveryScope = recoveryScope;
    this.recommendedAction = recommendedAction;
    this.details = details;
  }
}

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  const token = getToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  if (options.body && !(options.body instanceof FormData)) {
    headers.set('content-type', 'application/json');
  }

  let response;
  try {
    response = await fetch(`/api${path}`, { ...options, headers });
  } catch (err) {
    throw new ApiError('Cannot reach the server', { status: 0, code: 'NETWORK', details: err.message });
  }

  if (response.status === 204) return null;

  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    let payload = null;
    if (contentType.includes('application/json')) {
      payload = await response.json().catch(() => null);
    }
    const error = payload?.error ?? {};
    if (response.status === 401) setToken('');
    throw new ApiError(error.message ?? `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
      recoveryScope: error.recoveryScope,
      recommendedAction: error.recommendedAction,
      details: error.details,
    });
  }

  if (contentType.includes('application/json')) return response.json();
  return response.text();
}

export const api = {
  meta: () => request('/meta'),
  health: () => request('/health'),
  metrics: () => request('/metrics'),

  listJobs: ({ limit = 50, offset = 0, status } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) params.set('status', status);
    return request(`/jobs?${params}`);
  },
  getJob: (jobId, { segments = true, limit = 100, offset = 0 } = {}) => {
    const params = new URLSearchParams({ segments: String(segments), limit: String(limit), offset: String(offset) });
    return request(`/jobs/${encodeURIComponent(jobId)}?${params}`);
  },
  getSegments: (jobId, { limit = 200, offset = 0, status } = {}) => {
    const params = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (status) params.set('status', status);
    return request(`/jobs/${encodeURIComponent(jobId)}/segments?${params}`);
  },
  transcript: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/transcript`),
  translations: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/translations`),
  failures: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/failures`),
  artifacts: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/artifacts`),

  createJob: (formData) => request('/jobs', { method: 'POST', body: formData }),
  start: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/start`, { method: 'POST' }),
  resume: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}/resume`, { method: 'POST' }),
  cancel: (jobId, reason) => request(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  }),
  retry: (jobId, payload) => request(`/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: 'POST',
    body: JSON.stringify(payload),
  }),
  deleteJob: (jobId) => request(`/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' }),

  artifactUrl: (jobId, relative, { download = false } = {}) => {
    const encoded = String(relative).split('/').map(encodeURIComponent).join('/');
    return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encoded}${download ? '?download=true' : ''}`;
  },

  /** Fetches an artifact as a Blob, used for client-side waveform analysis. */
  async artifactBlob(jobId, relative) {
    const headers = new Headers();
    const token = getToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const response = await fetch(api.artifactUrl(jobId, relative), { headers });
    if (!response.ok) throw new ApiError('Could not load audio artifact', { status: response.status });
    return response.blob();
  },
};
