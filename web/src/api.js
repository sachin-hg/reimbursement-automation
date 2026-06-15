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
  start:       (folder)       => call('POST',   '/api/start',      { folder }),
  crop:        ()              => call('POST',   '/api/crop'),
  recrop:      (id, feedback)  => call('POST',   '/api/recrop',     { id, feedback }),
  manualcrop:  (id, pcts)      => call('POST',   '/api/manualcrop', { id, ...pcts }),
  extract:     (approvedIds, mode = 'ocr') => call('POST', '/api/extract', { approvedIds, mode }),
  reextract:   (id)            => call('POST',   '/api/reextract',  { id }),
  submit:      (bills)         => call('POST',   '/api/submit',     { bills }),
  resetRun:    ()              => call('DELETE', '/api/run'),

  upload: async (files) => {
    const form = new FormData();
    for (const file of files) form.append('images', file);
    const res = await fetch('/api/upload', { method: 'POST', body: form });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json;
  },
};
