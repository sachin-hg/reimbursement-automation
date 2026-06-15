// Read stored config from localStorage — included in every call that reaches Claude or the portal.
// Never sent to storage, never persisted on the server.
function storedConfig() {
  try { return JSON.parse(localStorage.getItem('reimbursement_config') || '{}'); } catch { return {}; }
}

// Module-level runId — set by App when a run is started or activated.
// Auto-included in all run-scoped API calls so callers don't have to pass it every time.
let _runId = null;

async function call(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
  return json;
}

export const api = {
  // Set by App whenever runId state changes — keeps all subsequent calls scoped to this run.
  setRunId: (id) => { _runId = id; },

  status:    () => _runId ? call('GET', `/api/status?runId=${encodeURIComponent(_runId)}`) : call('GET', '/api/status'),
  getConfig: () => call('GET', '/api/config'),

  // Session token management
  getToken:     () => call('GET',  '/api/token'),
  newToken:     () => call('POST', '/api/token/new'),
  restoreToken: (token) => call('POST', '/api/token/restore', { token }),

  // start/upload create a new run — they don't send runId (they return one)
  start:  (folder) => call('POST', '/api/start',  { folder }),
  upload: async (files) => {
    const form = new FormData();
    for (const file of files) form.append('images', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },

  crop:      () => call('POST', '/api/crop',      { runId: _runId, config: storedConfig() }),
  recrop:    (id, feedback) => call('POST', '/api/recrop',    { runId: _runId, id, feedback, config: storedConfig() }),
  manualcrop:(id, pcts)    => call('POST', '/api/manualcrop', { runId: _runId, id, ...pcts }),
  extract:   (approvedIds, mode = 'ocr') => call('POST', '/api/extract', { runId: _runId, approvedIds, mode, config: storedConfig() }),
  reextract: (id)          => call('POST', '/api/reextract',  { runId: _runId, id, config: storedConfig() }),
  saveBills: (data)        => call('PUT',  '/api/bills',      { runId: _runId, ...data }),
  submit:    (bills)       => call('POST', '/api/submit',     { runId: _runId, bills, config: storedConfig() }),

  killSubmit:    () => call('POST', '/api/submit/kill',        { runId: _runId }),
  pauseSubmit:   () => call('POST', '/api/submit/pause',       { runId: _runId }),
  confirmSubmit: () => call('POST', '/api/submit/confirm',     { runId: _runId }),
  retryFailed: (bills) => call('POST', '/api/submit/retry-failed', { runId: _runId, bills }),

  resetRun:    () => call('DELETE', _runId ? `/api/run?runId=${encodeURIComponent(_runId)}` : '/api/run'),
  listRuns:    () => call('GET',  '/api/runs'),
  activateRun: (id) => call('POST',   `/api/runs/${id}/activate`),
  deleteRun:   (id) => call('DELETE', `/api/runs/${id}`),
};
