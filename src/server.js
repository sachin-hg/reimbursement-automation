require('dotenv').config();
const crypto  = require('crypto');
const express = require('express');
const multer  = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { smartCrop } = require('./image-processor');
const { extractBillData } = require('./bill-extractor');
const { ocrImage, extractFromOCR, terminateWorker, LOW_CONFIDENCE_THRESHOLD } = require('./ocr-extractor');
const { submitReimbursementClaims, retryFailedBills } = require('./portal');
const { resolveConfig, isProd } = require('./config');
const logger = require('./logger');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024, files: 100 },
});

const app = express();
const PORT = process.env.PORT || 3333;

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const WEB_DIST      = path.join(__dirname, '..', 'web', 'dist');
const IMAGE_EXTS    = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

// ── Session tokens ────────────────────────────────────────────────────────────
// Each browser gets a UUID cookie (userToken) that namespaces its runs.
// Not real auth — tokens are unguessable but not signed. Good enough for a
// shared-server "don't see each other's runs" requirement.

const TEN_YEARS_MS = 315360000000;

// CORS — comma-separated list of allowed origins (e.g. https://myapp.vercel.app).
// Leave unset for same-origin / local dev where the Vite proxy handles routing.
const CORS_ORIGINS = new Set(
  (process.env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean)
);

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = decodeURIComponent(part.slice(0, idx).trim());
    const v = decodeURIComponent(part.slice(idx + 1).trim());
    if (k) out[k] = v;
  }
  return out;
}

// When cross-origin CORS is active, cookies need SameSite=None; Secure so the browser
// sends them with credentialed cross-origin requests.
const isCrossOrigin = CORS_ORIGINS.size > 0;
const COOKIE_OPTS = {
  maxAge:   TEN_YEARS_MS,
  httpOnly: false,   // JS-readable so the UI can display / copy it
  sameSite: isCrossOrigin ? 'None' : 'Strict',
  secure:   isCrossOrigin,   // SameSite=None requires Secure
  path:     '/',
};

// Returns the caller's token, creating + setting a cookie if this is their first visit.
// Must be called before res.json() / res.send() so the Set-Cookie header makes it out.
function getToken(req, res) {
  const cookies = parseCookies(req);
  if (cookies.userToken) return cookies.userToken;
  const token = crypto.randomUUID();
  res.cookie('userToken', token, COOKIE_OPTS);
  return token;
}

// ── Per-run state ─────────────────────────────────────────────────────────────
// Each active run lives in this Map; runs are added on /start or /upload,
// loaded on /runs/:id/activate, and removed on /run DELETE or /runs/:id DELETE.
// Multiple runs can be in flight simultaneously (parallel tabs / CLI + server).

const activeRuns = new Map();          // runId → run object
const sseClientsByRun = new Map();     // runId → Set<res>

function saveRunMeta(run) {
  if (!run || !run.runDir) return;
  try {
    const { killController, paused, _pausePromise, _pauseResolve, _confirmResolve, _retryCtx, ...meta } = run;
    fs.writeFileSync(path.join(run.runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (e) {
    logger.warn(`saveRunMeta failed: ${e.message}`);
  }
}

function broadcastTo(runId, type, payload = {}) {
  const clients = sseClientsByRun.get(runId);
  if (!clients || !clients.size) return;
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  clients.forEach(res => { try { res.write(msg); } catch {} });
}

// Look up run and write a 400/404 error response if missing.
function getRun(runId, res) {
  if (!runId) { res.status(400).json({ error: 'runId required' }); return null; }
  const run = activeRuns.get(runId);
  if (!run) { res.status(400).json({ error: 'Run not active — start or activate a run first' }); return null; }
  return run;
}

// CORS — only active when CORS_ORIGINS is configured (cross-origin / Vercel deployments).
if (isCrossOrigin) {
  app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin && CORS_ORIGINS.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
}

app.use(express.json({ limit: '10mb' }));
app.use('/files', express.static(DOWNLOADS_DIR));

if (fs.existsSync(WEB_DIST)) app.use(express.static(WEB_DIST));

// ── SSE ───────────────────────────────────────────────────────────────────────

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const { runId } = req.query;
  if (runId) {
    if (!sseClientsByRun.has(runId)) sseClientsByRun.set(runId, new Set());
    sseClientsByRun.get(runId).add(res);
    res.on('close', () => {
      const clients = sseClientsByRun.get(runId);
      if (clients) {
        clients.delete(res);
        if (!clients.size) sseClientsByRun.delete(runId);
      }
    });

    // Send current state so a reconnecting client can recover
    const run = activeRuns.get(runId);
    if (run) res.write(`data: ${JSON.stringify({ type: 'state', run: getRunState(run) })}\n\n`);
  }

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 20000);
  res.on('close', () => clearInterval(hb));
});

// ── Serialisation helpers (all take run as first arg) ────────────────────────

function fileUrl(run, filename) {
  return `/files/${run.id}/${path.basename(filename)}`;
}

function serializeAtt(run, a) {
  return { id: a.id, filename: a.filename, originalUrl: fileUrl(run, a.path) };
}

function serializePrepared(run, p) {
  return {
    id: p.id,
    filename: p.filename,
    originalUrl: fileUrl(run, p.path),
    croppedUrl: fileUrl(run, p.croppedPath),
    cropStatus: p.cropStatus || 'done',
  };
}

function serializeBill(run, b) {
  const base = b.imagePath ? fileUrl(run, b.imagePath) : null;
  return {
    id: b.id,
    filename: b.filename,
    bill_no: b.bill_no,
    bill_date: b.bill_date,
    bill_amount: b.bill_amount,
    croppedUrl: base ? base + (b.cropTime ? `?t=${b.cropTime}` : '') : null,
    ocrConfidence: b.ocrConfidence ?? null,
    ocrText: b.ocrText ?? null,
  };
}

function serializeSkipped(run, s) {
  const base = s.croppedPath ? fileUrl(run, s.croppedPath) : null;
  return {
    id: s.id,
    filename: s.filename,
    error: s.error || null,
    croppedUrl: base ? base + (s.cropTime ? `?t=${s.cropTime}` : '') : null,
    ocrConfidence: s.ocrConfidence ?? null,
    ocrText: s.ocrText ?? null,
  };
}

function getRunState(run) {
  if (!run) return null;
  return {
    id: run.id,
    folder: run.folder,
    status: run.status,
    attachments: run.attachments?.map(a => serializeAtt(run, a)),
    prepared: run.prepared?.map(p => serializePrepared(run, p)),
    bills: run.bills?.map(b => serializeBill(run, b)),
    skipped: run.skipped?.map(s => serializeSkipped(run, s)),
    removedIds: run.removedIds || [],
    includedSkippedIds: run.includedSkippedIds || [],
    result: run.result,
    error: run.error,
  };
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  getToken(req, res);  // ensure session cookie is set on first visit
  const { runId } = req.query;
  if (runId) {
    const run = activeRuns.get(runId);
    return res.json({ run: run ? getRunState(run) : null });
  }
  res.json({ run: null });
});

// Report which env vars are set — UI uses this to show "configured in .env" hints.
// Never returns actual values for sensitive fields.
app.get('/api/config', (req, res) => {
  const SENSITIVE = new Set(['PORTAL_PASSWORD', 'ANTHROPIC_API_KEY']);
  const KEYS = ['ANTHROPIC_API_KEY', 'PORTAL_USERNAME', 'PORTAL_PASSWORD',
                'HEADLESS', 'GMAIL_ADDRESS', 'SENDER_EMAIL', 'GMAIL_LABEL', 'LOOKBACK_DAYS'];
  const result = {};
  for (const k of KEYS) {
    if (SENSITIVE.has(k)) {
      result[k] = !!process.env[k];
    } else if (k === 'HEADLESS') {
      result[k] = process.env[k] !== undefined ? process.env[k] !== 'false' : null;
    } else if (k === 'LOOKBACK_DAYS') {
      result[k] = process.env[k] ? parseInt(process.env[k], 10) : null;
    } else {
      result[k] = process.env[k] || null;
    }
  }
  result.isProd = isProd;
  res.json(result);
});

// ── Token management ─────────────────────────────────────────────────────────

// Return (creating if needed) the caller's session token.
app.get('/api/token', (req, res) => {
  const token = getToken(req, res);
  res.json({ token });
});

// Generate a brand-new token — caller loses access to old runs unless they saved their token.
app.post('/api/token/new', (req, res) => {
  const token = crypto.randomUUID();
  res.cookie('userToken', token, COOKIE_OPTS);
  res.json({ token });
});

// Restore a previously saved token — caller regains access to runs from that token.
app.post('/api/token/restore', (req, res) => {
  const { token } = req.body;
  if (!token || typeof token !== 'string' || !token.trim())
    return res.status(400).json({ error: 'token is required' });
  const t = token.trim();
  res.cookie('userToken', t, COOKIE_OPTS);
  res.json({ token: t });
});

// Load images from local folder
app.post('/api/start', (req, res) => {
  const { folder } = req.body;
  if (!folder) return res.status(400).json({ error: 'folder is required' });

  const resolved = path.resolve(folder);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
    return res.status(400).json({ error: `Not a valid directory: ${resolved}` });

  const files = fs.readdirSync(resolved).filter(name => {
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXTS.has(ext) && !name.startsWith('.') && !name.includes('_cropped');
  });

  if (files.length === 0)
    return res.status(400).json({ error: 'No image files found in folder' });

  const runId  = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const attachments = files.map((name, i) => {
    const ext = path.extname(name).toLowerCase();
    const diskName = `img_${i}${ext}`;
    const dst = path.join(runDir, diskName);
    fs.copyFileSync(path.join(resolved, name), dst);
    return { id: `img_${i}`, filename: name, path: dst };
  });

  const token = getToken(req, res);
  const run = { id: runId, folder: resolved, runDir, attachments, status: 'loaded', createdAt: new Date().toISOString(), userToken: token };
  activeRuns.set(runId, run);
  saveRunMeta(run);
  logger.info(`Run ${runId}: ${attachments.length} images from ${resolved}`);

  res.json({ runId, attachments: attachments.map(a => serializeAtt(run, a)) });
});

// Upload images directly from browser folder picker
app.post('/api/upload', upload.array('images'), (req, res) => {
  const files = req.files || [];
  const imageFiles = files.filter(f => {
    const ext = path.extname(f.originalname).toLowerCase();
    return IMAGE_EXTS.has(ext) && !f.originalname.includes('_cropped');
  });

  if (!imageFiles.length)
    return res.status(400).json({ error: 'No image files found in the selected folder' });

  const runId  = `run_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // webkitRelativePath comes through as originalname "FolderName/file.jpg" — strip the folder prefix
  const attachments = imageFiles.map((file, i) => {
    const filename = path.basename(file.originalname);
    const ext = path.extname(filename).toLowerCase();
    const diskName = `img_${i}${ext}`;
    const dst = path.join(runDir, diskName);
    fs.writeFileSync(dst, file.buffer);
    return { id: `img_${i}`, filename, path: dst };
  });

  const folderName = imageFiles[0].originalname.includes('/')
    ? imageFiles[0].originalname.split('/')[0]
    : 'uploaded';

  const token = getToken(req, res);
  const run = { id: runId, folder: folderName, runDir, attachments, status: 'loaded', createdAt: new Date().toISOString(), userToken: token };
  activeRuns.set(runId, run);
  saveRunMeta(run);
  logger.info(`Run ${runId}: ${attachments.length} images uploaded (${folderName})`);

  res.json({ runId, folderName, attachments: attachments.map(a => serializeAtt(run, a)) });
});

// Crop all images — async, streams progress via SSE
app.post('/api/crop', async (req, res) => {
  const { runId, config: clientConfig = {} } = req.body || {};
  const run = getRun(runId, res);
  if (!run) return;
  if (run.status === 'cropping') return res.status(409).json({ error: 'Already cropping' });
  const apiKey = resolveConfig(clientConfig).ANTHROPIC_API_KEY;

  res.json({ ok: true });
  run.status = 'cropping';
  run.prepared = [];

  const total = run.attachments.length;
  for (let i = 0; i < total; i++) {
    const att = run.attachments[i];
    try {
      const croppedPath = await smartCrop(att.path, null, { apiKey });
      const prepared = { ...att, croppedPath, cropStatus: 'done' };
      run.prepared.push(prepared);
      broadcastTo(runId, 'crop_progress', {
        id: att.id, filename: att.filename,
        originalUrl: fileUrl(run, att.path), croppedUrl: fileUrl(run, croppedPath),
        done: i + 1, total,
      });
    } catch (err) {
      logger.warn(`Crop failed ${att.filename}: ${err.message}`);
      run.prepared.push({ ...att, croppedPath: att.path, cropStatus: 'error' });
      broadcastTo(runId, 'crop_error', { id: att.id, filename: att.filename, error: err.message, done: i + 1, total });
    }
  }

  run.status = 'crop_done';
  broadcastTo(runId, 'crop_complete', { prepared: run.prepared.map(p => serializePrepared(run, p)) });
  saveRunMeta(run);
});

// AI re-crop single image with optional text feedback
app.post('/api/recrop', async (req, res) => {
  const { runId, id, feedback, config: clientConfig = {} } = req.body;
  const run = getRun(runId, res);
  if (!run) return;

  const att = run.attachments.find(a => a.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const croppedPath = await smartCrop(att.path, feedback || null, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
    const croppedUrl  = fileUrl(run, croppedPath);

    const idx = run.prepared?.findIndex(p => p.id === id);
    if (idx >= 0) run.prepared[idx] = { ...run.prepared[idx], croppedPath };

    saveRunMeta(run);
    res.json({ id, croppedUrl });
    broadcastTo(runId, 'recrop_done', { id, croppedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual crop via pixel percentages — bypasses AI, uses sharp directly
app.post('/api/manualcrop', async (req, res) => {
  const { runId, id, leftPct = 0, topPct = 0, rightPct = 0, bottomPct = 0 } = req.body;
  const run = getRun(runId, res);
  if (!run) return;

  const att = run.attachments.find(a => a.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const meta  = await sharp(att.path, { failOn: 'none' }).rotate().metadata();
    const w = meta.width, h = meta.height;

    const l = Math.max(0, Math.floor(leftPct   / 100 * w));
    const t = Math.max(0, Math.floor(topPct    / 100 * h));
    const r = Math.max(0, Math.floor(rightPct  / 100 * w));
    const b = Math.max(0, Math.floor(bottomPct / 100 * h));
    const cw = w - l - r, ch = h - t - b;

    if (cw < 50 || ch < 50) return res.status(400).json({ error: 'Selection too small' });

    const outPath = att.path.replace(/(\.[^.]+)$/, '_cropped.jpg');
    await sharp(att.path, { failOn: 'none' })
      .rotate()
      .extract({ left: l, top: t, width: cw, height: ch })
      .jpeg({ quality: 92 })
      .toFile(outPath);

    const cropTime = Date.now();
    const croppedUrl = fileUrl(run, outPath) + `?t=${cropTime}`;
    const idx = run.prepared?.findIndex(p => p.id === id);
    if (idx >= 0) run.prepared[idx] = { ...run.prepared[idx], croppedPath: outPath, cropTime };

    saveRunMeta(run);
    res.json({ id, croppedUrl });
    broadcastTo(runId, 'manualcrop_done', { id, croppedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract bill data — mode: 'ocr' (default, fast) or 'llm' (vision, accurate)
app.post('/api/extract', async (req, res) => {
  const { runId, approvedIds, mode = 'ocr', config: clientConfig = {} } = req.body;
  const run = getRun(runId, res);
  if (!run) return;
  if (run.status === 'extracting') return res.status(409).json({ error: 'Already extracting' });
  if (!Array.isArray(approvedIds) || !approvedIds.length)
    return res.status(400).json({ error: 'approvedIds must be a non-empty array' });

  res.json({ ok: true });
  run.status = 'extracting';

  const toProcess = (run.prepared || []).filter(p => approvedIds.includes(p.id));
  const total = toProcess.length;
  const bills = [], skipped = [];

  if (mode === 'llm') {
    // ── LLM vision mode: 4-concurrent Claude Vision calls ──────────────────
    const CONCURRENCY = 4;
    async function processOne(att) {
      const croppedUrl = fileUrl(run, att.croppedPath) + (att.cropTime ? `?t=${att.cropTime}` : '');
      try {
        const data = await extractBillData(att.croppedPath, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
        if (data) {
          bills.push({ ...data, id: att.id, imagePath: att.croppedPath, filename: att.filename, cropTime: att.cropTime ?? null });
          broadcastTo(runId, 'extract_result', { id: att.id, type: 'bill', ...data, croppedUrl, filename: att.filename });
        } else {
          skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath, cropTime: att.cropTime ?? null });
          broadcastTo(runId, 'extract_result', { id: att.id, type: 'skipped', croppedUrl, filename: att.filename });
        }
      } catch (err) {
        logger.error(`Extract ${att.filename}: ${err.message}`);
        skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath, cropTime: att.cropTime ?? null, error: err.message });
        broadcastTo(runId, 'extract_result', { id: att.id, type: 'skipped', croppedUrl, filename: att.filename, error: err.message });
      }
      broadcastTo(runId, 'extract_progress', { done: bills.length + skipped.length, total });
    }
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      await Promise.all(toProcess.slice(i, i + CONCURRENCY).map(processOne));
    }

  } else {
    // ── OCR mode: two phases ─────────────────────────────────────────────────
    broadcastTo(runId, 'extract_progress', { done: 0, total, phase: 'ocr' });

    const ocrResults = [];
    await Promise.all(toProcess.map(async att => {
      const croppedUrl = fileUrl(run, att.croppedPath) + (att.cropTime ? `?t=${att.cropTime}` : '');
      let text = '', confidence = 0;
      try {
        ({ text, confidence } = await ocrImage(att.croppedPath));
        att.ocrText = text;
        att.ocrConfidence = confidence;
        logger.info(`  OCR ${att.filename}: ${text.length} chars, confidence ${confidence}`);
      } catch (err) {
        logger.warn(`  OCR failed ${att.filename}: ${err.message}`);
      }
      ocrResults.push({ id: att.id, text, confidence, ocrOk: text.length >= 40 });
      broadcastTo(runId, 'ocr_result', { id: att.id, filename: att.filename, croppedUrl, ocrText: text, ocrConfidence: confidence });
    }));

    broadcastTo(runId, 'extract_progress', { done: 0, total, phase: 'claude' });
    const result = await extractFromOCR(ocrResults, toProcess, { autoMode: false, apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });

    for (const b of result.bills) {
      const att = toProcess.find(p => p.id === b.id);
      const ocr = ocrResults.find(r => r.id === b.id);
      b.ocrConfidence = ocr?.confidence ?? null;
      b.ocrText = ocr?.text ?? null;
      b.cropTime = att?.cropTime ?? null;
    }
    for (const s of result.skipped) {
      const att = toProcess.find(p => p.id === s.id);
      const ocr = ocrResults.find(r => r.id === s.id);
      s.ocrConfidence = ocr?.confidence ?? null;
      s.ocrText = ocr?.text ?? null;
      s.cropTime = att?.cropTime ?? null;
    }
    bills.push(...result.bills);
    skipped.push(...result.skipped);

    for (const b of bills) {
      const att = toProcess.find(p => p.id === b.id);
      const croppedUrl = fileUrl(run, b.imagePath) + (att?.cropTime ? `?t=${att.cropTime}` : '');
      broadcastTo(runId, 'extract_result', { id: b.id, type: 'bill', bill_no: b.bill_no,
        bill_date: b.bill_date, bill_amount: b.bill_amount, croppedUrl,
        filename: b.filename, ocrConfidence: b.ocrConfidence, ocrText: b.ocrText });
    }
    for (const s of skipped) {
      const att = toProcess.find(p => p.id === s.id);
      const croppedUrl = fileUrl(run, s.croppedPath || '') + (att?.cropTime ? `?t=${att.cropTime}` : '');
      broadcastTo(runId, 'extract_result', { id: s.id, type: 'skipped', croppedUrl,
        filename: s.filename, error: s.error, ocrConfidence: s.ocrConfidence, ocrText: s.ocrText });
    }
    broadcastTo(runId, 'extract_progress', { done: total, total });
  }

  run.bills   = bills;
  run.skipped = skipped;
  run.status  = 'extracted';
  broadcastTo(runId, 'extract_complete', {
    bills: bills.map(b => serializeBill(run, b)),
    skipped: skipped.map(s => serializeSkipped(run, s)),
  });
  saveRunMeta(run);

  // Free Tesseract WASM workers — they hold ~25MB each and are only needed during extraction.
  // The pool re-initialises lazily on the next extract call.
  terminateWorker().catch(() => {});
});

// Re-extract a single bill using LLM vision (called from Step 3 review)
app.post('/api/reextract', async (req, res) => {
  const { runId, id, config: clientConfig = {} } = req.body;
  const run = getRun(runId, res);
  if (!run) return;

  const att = (run.prepared || []).find(p => p.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const data = await extractBillData(att.croppedPath, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
    if (!data) return res.json({ id, found: false });

    const existing = run.bills?.find(b => b.id === id);
    if (existing) {
      Object.assign(existing, data);
    } else {
      run.bills = run.bills || [];
      run.bills.push({ ...data, id, imagePath: att.croppedPath, filename: att.filename });
      run.skipped = (run.skipped || []).filter(s => s.id !== id);
    }

    saveRunMeta(run);
    res.json({ id, found: true, bill_no: data.bill_no, bill_date: data.bill_date, bill_amount: data.bill_amount });
    broadcastTo(runId, 'reextract_done', { id, bill_no: data.bill_no, bill_date: data.bill_date, bill_amount: data.bill_amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save user-edited bill data + removed/included sets
app.put('/api/bills', (req, res) => {
  const { runId, bills, skipped, removedIds, includedSkippedIds } = req.body;
  const run = getRun(runId, res);
  if (!run) return;

  if (Array.isArray(bills)) {
    run.bills = bills.map(b => {
      const orig = (run.bills || []).find(o => o.id === b.id) || {};
      return { ...orig, bill_no: b.bill_no, bill_date: b.bill_date, bill_amount: b.bill_amount };
    });
  }
  if (Array.isArray(skipped)) {
    run.skipped = (run.skipped || []).map(s => {
      const edited = skipped.find(e => e.id === s.id);
      return edited ? { ...s, bill_no: edited.bill_no, bill_date: edited.bill_date, bill_amount: edited.bill_amount } : s;
    });
  }
  if (Array.isArray(removedIds))          run.removedIds = removedIds;
  if (Array.isArray(includedSkippedIds))  run.includedSkippedIds = includedSkippedIds;

  saveRunMeta(run);
  res.json({ ok: true });
});

// Submit to portal — async
app.post('/api/submit', async (req, res) => {
  const { runId, bills: edited, config: clientConfig = {} } = req.body;
  const run = getRun(runId, res);
  if (!run) return;
  if (run.status === 'submitting') return res.status(409).json({ error: 'Already submitting' });
  if (!Array.isArray(edited) || !edited.length)
    return res.status(400).json({ error: 'bills must be a non-empty array' });

  res.json({ ok: true });
  run.status = 'submitting';
  broadcastTo(runId, 'submit_start', { total: edited.length });

  const lookup = [
    ...(run.bills   || []),
    ...(run.skipped || []).map(s => ({ ...s, imagePath: s.croppedPath })),
  ];

  const billsWithPaths = edited.map(b => {
    const orig = lookup.find(p => p.id === b.id);
    return { ...b, imagePath: orig?.imagePath || null };
  }).filter(b => b.imagePath);

  const killController = new AbortController();
  run.killController = killController;
  run.paused = false;
  run._retryCtx = null;

  function waitIfPaused() {
    return run?.paused ? (run._pausePromise || Promise.resolve()) : Promise.resolve();
  }

  function waitForConfirm() {
    return new Promise(resolve => { run._confirmResolve = resolve; });
  }

  try {
    const result = await submitReimbursementClaims(billsWithPaths, {
      broadcast: (type, payload) => broadcastTo(runId, type, payload),
      signal: killController.signal,
      waitIfPaused,
      waitForConfirm,
      onRetryCtx: (ctx) => { run._retryCtx = ctx; },
      config: clientConfig,
    });
    run.result = result;
    run.status = result.success ? 'done' : 'error';
    saveRunMeta(run);
    broadcastTo(runId, 'submit_complete', { result });
  } catch (err) {
    run.status = 'error';
    run.error  = err.message;
    saveRunMeta(run);
    broadcastTo(runId, 'submit_error', { error: err.message });
  } finally {
    run.killController = null;
    run._retryCtx = null;
    if (run._confirmResolve) { run._confirmResolve(); run._confirmResolve = null; }
    if (run._pauseResolve)   { run._pauseResolve();   run._pauseResolve  = null; }
  }
});

// Kill an in-progress submission
app.post('/api/submit/kill', (req, res) => {
  const { runId } = req.body || {};
  const run = getRun(runId, res);
  if (!run) return;
  if (run.killController) {
    run.killController.abort();
    res.json({ ok: true });
  } else {
    res.json({ ok: false, message: 'No active submission' });
  }
});

// Pause / resume submission (honoured between bill entries)
app.post('/api/submit/pause', (req, res) => {
  const { runId } = req.body || {};
  const run = getRun(runId, res);
  if (!run) return;
  if (!run.paused) {
    run.paused = true;
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    run._pausePromise = promise;
    run._pauseResolve = resolve;
    broadcastTo(runId, 'submit_paused', { paused: true });
  } else {
    run.paused = false;
    if (run._pauseResolve) { run._pauseResolve(); }
    run._pausePromise = null;
    run._pauseResolve = null;
    broadcastTo(runId, 'submit_paused', { paused: false });
  }
  res.json({ ok: true, paused: run.paused });
});

// Confirm final submit (called from UI after user reviews portal entries)
app.post('/api/submit/confirm', (req, res) => {
  const { runId } = req.body || {};
  const run = getRun(runId, res);
  if (!run) return;
  if (run._confirmResolve) {
    run._confirmResolve();
    run._confirmResolve = null;
  }
  broadcastTo(runId, 'submit_confirmed');
  res.json({ ok: true });
});

// Retry specific failed bills — portal page is still open during confirm gate
app.post('/api/submit/retry-failed', async (req, res) => {
  const { runId, bills } = req.body;
  const run = getRun(runId, res);
  if (!run) return;
  if (!Array.isArray(bills) || !bills.length) return res.status(400).json({ error: 'bills required' });
  res.json({ ok: true });  // respond immediately; result comes via SSE
  try {
    await retryFailedBills(bills, run._retryCtx);
  } catch (err) {
    broadcastTo(runId, 'submit_progress', { id: 'retry_error', step: 'error', label: `Retry error: ${err.message}`, status: 'error' });
  }
});

// List all saved runs for this user token (newest first)
app.get('/api/runs', (req, res) => {
  const token = getToken(req, res);
  if (!fs.existsSync(DOWNLOADS_DIR)) return res.json([]);
  try {
    const runs = fs.readdirSync(DOWNLOADS_DIR)
      .filter(name => /^run_[a-z0-9_]+$/.test(name))
      .map(name => {
        const metaPath = path.join(DOWNLOADS_DIR, name, 'meta.json');
        if (!fs.existsSync(metaPath)) return null;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
          // Runs with no stored token are legacy — visible to everyone.
          if (meta.userToken && meta.userToken !== token) return null;
          return {
            id: meta.id,
            folder: meta.folder,
            status: meta.status,
            createdAt: meta.createdAt,
            billCount: meta.bills?.length || 0,
            attachmentCount: meta.attachments?.length || 0,
          };
        } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.id.localeCompare(a.id));
    res.json(runs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate a saved run — loads from disk into activeRuns (verifies token ownership)
app.post('/api/runs/:id/activate', (req, res) => {
  const token = getToken(req, res);
  const runDir = path.join(DOWNLOADS_DIR, req.params.id);
  const metaPath = path.join(runDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Run not found' });
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    // Runs with no stored token are legacy — allow any token to activate them.
    if (meta.userToken && meta.userToken !== token)
      return res.status(403).json({ error: 'This run belongs to a different session' });
    if (meta.status === 'submitting') meta.status = 'extracted';
    const run = { ...meta, killController: null, paused: false };
    activeRuns.set(run.id, run);
    res.json({ run: getRunState(run) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a saved run (removes directory and evicts from activeRuns; verifies ownership)
app.delete('/api/runs/:id', (req, res) => {
  const token = getToken(req, res);
  const { id } = req.params;
  const runDir = path.join(DOWNLOADS_DIR, id);
  if (!fs.existsSync(runDir)) return res.status(404).json({ error: 'Run not found' });
  try {
    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      if (meta.userToken && meta.userToken !== token)
        return res.status(403).json({ error: 'This run belongs to a different session' });
    }
  } catch {}
  activeRuns.delete(id);
  fs.rmSync(runDir, { recursive: true, force: true });
  res.json({ ok: true });
});

// Deactivate a run from this client's view (removes from activeRuns but keeps on disk)
app.delete('/api/run', (req, res) => {
  const runId = req.query.runId || req.body?.runId;
  if (runId) activeRuns.delete(runId);
  res.json({ ok: true });
});

// SPA fallback
app.use((req, res) => {
  const idx = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('Web app not built yet. Run: cd web && npm run build');
});

if (require.main === module) {
  app.listen(PORT, () => {
    logger.info(`Server → http://localhost:${PORT}`);
    migrateOldRuns();
  });
} else {
  migrateOldRuns();
}

module.exports = app;

// Backfill meta.json for run directories created before persistence was added.
function migrateOldRuns() {
  if (!fs.existsSync(DOWNLOADS_DIR)) return;
  const dirs = fs.readdirSync(DOWNLOADS_DIR).filter(n => /^run_\d+$/.test(n));
  let migrated = 0;
  for (const name of dirs) {
    const runDir = path.join(DOWNLOADS_DIR, name);
    const metaPath = path.join(runDir, 'meta.json');
    if (fs.existsSync(metaPath)) continue;
    try {
      const files = fs.readdirSync(runDir);
      const originals = files.filter(f => {
        const ext = path.extname(f).toLowerCase();
        return IMAGE_EXTS.has(ext) && !f.includes('_cropped') && !f.startsWith('.');
      });
      if (!originals.length) continue;

      const ts = parseInt(name.replace('run_', ''), 10);
      const createdAt = isNaN(ts) ? new Date().toISOString() : new Date(ts).toISOString();

      const attachments = originals.map((f, i) => ({
        id: `img_${i}`, filename: f, path: path.join(runDir, f),
      }));

      const prepared = attachments.map(a => {
        const base = path.basename(a.filename, path.extname(a.filename));
        const croppedPath = path.join(runDir, base + '_cropped.jpg');
        return {
          ...a,
          croppedPath: fs.existsSync(croppedPath) ? croppedPath : a.path,
          cropStatus: fs.existsSync(croppedPath) ? 'done' : 'error',
        };
      });

      const hasCrops = prepared.some(p => p.cropStatus === 'done');
      const dateStr = isNaN(ts) ? '' : new Date(ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
      const folder = `Run from ${dateStr}`;

      const meta = {
        id: name, folder, runDir,
        status: hasCrops ? 'crop_done' : 'loaded',
        createdAt,
        attachments,
        prepared: hasCrops ? prepared : null,
        bills: [], skipped: [],
      };
      fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
      migrated++;
    } catch { /* skip */ }
  }
  if (migrated) logger.info(`Migrated ${migrated} old run(s) to meta.json`);
}
