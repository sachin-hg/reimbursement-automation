// Read stored config from localStorage — included in every call that reaches Claude or the portal.
// Never sent to storage, never persisted on the server.
function storedConfig() {
  try { return JSON.parse(localStorage.getItem('reimbursement_config') || '{}'); } catch { return {}; }
}

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
  status:      ()              => call('GET',    '/api/status'),
  getConfig:   ()              => call('GET',    '/api/config'),   // read-only: which .env vars are set
  start:       (folder)       => call('POST',   '/api/start',      { folder }),
  crop:        ()              => call('POST',   '/api/crop',       { config: storedConfig() }),
  recrop:      (id, feedback)  => call('POST',   '/api/recrop',     { id, feedback, config: storedConfig() }),
  manualcrop:  (id, pcts)      => call('POST',   '/api/manualcrop', { id, ...pcts }),
  extract:     (approvedIds, mode = 'ocr') => call('POST', '/api/extract', { approvedIds, mode, config: storedConfig() }),
  reextract:   (id)            => call('POST',   '/api/reextract',  { id, config: storedConfig() }),
  saveBills:   (data)          => call('PUT',    '/api/bills',       data),
  submit:      (bills)         => call('POST',   '/api/submit',     { bills, config: storedConfig() }),
  killSubmit:  ()              => call('POST',   '/api/submit/kill'),
  pauseSubmit: ()              => call('POST',   '/api/submit/pause'),
  confirmSubmit: ()            => call('POST',   '/api/submit/confirm'),
  retryFailed:  (bills)        => call('POST',   '/api/submit/retry-failed', { bills }),
  resetRun:    ()              => call('DELETE', '/api/run'),
  listRuns:    ()              => call('GET',    '/api/runs'),
  activateRun: (id)            => call('POST',   `/api/runs/${id}/activate`),
  deleteRun:   (id)            => call('DELETE', `/api/runs/${id}`),

  upload: async (files) => {
    const form = new FormData();
    for (const file of files) form.append('images', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
};
