require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { smartCrop } = require('./image-processor');
const { extractBillData } = require('./bill-extractor');
const { ocrImage, extractFromOCR, LOW_CONFIDENCE_THRESHOLD } = require('./ocr-extractor');
const { submitReimbursementClaims, retryFailedBills } = require('./portal');
const { resolveConfig } = require('./config');
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

function saveRunMeta(run) {
  if (!run || !run.runDir) return;
  try {
    const { killController, paused, _pausePromise, _pauseResolve, _confirmResolve, ...meta } = run;
    fs.writeFileSync(path.join(run.runDir, 'meta.json'), JSON.stringify(meta, null, 2));
  } catch (e) {
    logger.warn(`saveRunMeta failed: ${e.message}`);
  }
}

app.use(express.json({ limit: '10mb' }));
app.use('/files', express.static(DOWNLOADS_DIR));

if (fs.existsSync(WEB_DIST)) app.use(express.static(WEB_DIST));

// ── SSE ───────────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(type, payload = {}) {
  const msg = `data: ${JSON.stringify({ type, ...payload })}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));

  // Send current state so a page refresh can recover
  if (currentRun) res.write(`data: ${JSON.stringify({ type: 'state', run: getRunState() })}\n\n`);

  const hb = setInterval(() => { try { res.write(': ping\n\n'); } catch { clearInterval(hb); } }, 20000);
  res.on('close', () => clearInterval(hb));
});

// ── Run state ─────────────────────────────────────────────────────────────────

let currentRun = null;

function fileUrl(filename) {
  return `/files/${currentRun.id}/${path.basename(filename)}`;
}

function serializeAtt(a) {
  return { id: a.id, filename: a.filename, originalUrl: fileUrl(a.path) };
}

function serializePrepared(p) {
  return {
    id: p.id,
    filename: p.filename,
    originalUrl: fileUrl(p.path),
    croppedUrl: fileUrl(p.croppedPath),
    cropStatus: p.cropStatus || 'done',
  };
}

function serializeBill(b) {
  const base = b.imagePath ? fileUrl(b.imagePath) : null;
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

function serializeSkipped(s) {
  const base = s.croppedPath ? fileUrl(s.croppedPath) : null;
  return {
    id: s.id,
    filename: s.filename,
    error: s.error || null,
    croppedUrl: base ? base + (s.cropTime ? `?t=${s.cropTime}` : '') : null,
    ocrConfidence: s.ocrConfidence ?? null,
    ocrText: s.ocrText ?? null,
  };
}

function getRunState() {
  if (!currentRun) return null;
  return {
    id: currentRun.id,
    folder: currentRun.folder,
    status: currentRun.status,
    attachments: currentRun.attachments?.map(serializeAtt),
    prepared: currentRun.prepared?.map(serializePrepared),
    bills: currentRun.bills?.map(serializeBill),
    skipped: currentRun.skipped?.map(serializeSkipped),
    removedIds: currentRun.removedIds || [],
    includedSkippedIds: currentRun.includedSkippedIds || [],
    result: currentRun.result,
    error: currentRun.error,
  };
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => res.json({ run: getRunState() }));

// Report which env vars are set — UI uses this to show "configured in .env" hints.
// Never returns actual values for sensitive fields.
app.get('/api/config', (req, res) => {
  const SENSITIVE = new Set(['PORTAL_PASSWORD', 'ANTHROPIC_API_KEY']);
  const KEYS = ['ANTHROPIC_API_KEY', 'PORTAL_USERNAME', 'PORTAL_PASSWORD',
                'HEADLESS', 'GMAIL_ADDRESS', 'SENDER_EMAIL', 'GMAIL_LABEL', 'LOOKBACK_DAYS'];
  const result = {};
  for (const k of KEYS) {
    if (SENSITIVE.has(k)) {
      result[k] = !!process.env[k];  // boolean: is it set in .env?
    } else if (k === 'HEADLESS') {
      result[k] = process.env[k] !== undefined ? process.env[k] !== 'false' : null;
    } else if (k === 'LOOKBACK_DAYS') {
      result[k] = process.env[k] ? parseInt(process.env[k], 10) : null;
    } else {
      result[k] = process.env[k] || null;
    }
  }
  res.json(result);
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

  const runId  = `run_${Date.now()}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  const attachments = files.map((name, i) => {
    const ext = path.extname(name).toLowerCase();
    const diskName = `img_${i}${ext}`;
    const dst = path.join(runDir, diskName);
    fs.copyFileSync(path.join(resolved, name), dst);
    return { id: `img_${i}`, filename: name, path: dst };
  });

  currentRun = { id: runId, folder: resolved, runDir, attachments, status: 'loaded', createdAt: new Date().toISOString() };
  saveRunMeta(currentRun);
  logger.info(`Run ${runId}: ${attachments.length} images from ${resolved}`);

  res.json({ runId, attachments: attachments.map(serializeAtt) });
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

  const runId  = `run_${Date.now()}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  // webkitRelativePath comes through as originalname "FolderName/file.jpg" — strip the folder prefix
  const attachments = imageFiles.map((file, i) => {
    const filename = path.basename(file.originalname);  // original name for display only
    const ext = path.extname(filename).toLowerCase();
    const diskName = `img_${i}${ext}`;                  // short name on disk → short cropped name
    const dst = path.join(runDir, diskName);
    fs.writeFileSync(dst, file.buffer);
    return { id: `img_${i}`, filename, path: dst };
  });

  // Derive folder name from the first file's relative path
  const folderName = imageFiles[0].originalname.includes('/')
    ? imageFiles[0].originalname.split('/')[0]
    : 'uploaded';

  currentRun = { id: runId, folder: folderName, runDir, attachments, status: 'loaded', createdAt: new Date().toISOString() };
  saveRunMeta(currentRun);
  logger.info(`Run ${runId}: ${attachments.length} images uploaded (${folderName})`);

  res.json({ runId, folderName, attachments: attachments.map(serializeAtt) });
});

// Crop all images — async, streams progress via SSE
app.post('/api/crop', async (req, res) => {
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  if (currentRun.status === 'cropping') return res.status(409).json({ error: 'Already cropping' });
  const { config: clientConfig = {} } = req.body || {};
  const apiKey = resolveConfig(clientConfig).ANTHROPIC_API_KEY;

  res.json({ ok: true });
  currentRun.status = 'cropping';
  currentRun.prepared = [];

  const total = currentRun.attachments.length;
  for (let i = 0; i < total; i++) {
    const att = currentRun.attachments[i];
    try {
      const croppedPath = await smartCrop(att.path, null, { apiKey });
      const prepared = { ...att, croppedPath, cropStatus: 'done' };
      currentRun.prepared.push(prepared);
      broadcast('crop_progress', {
        id: att.id, filename: att.filename,
        originalUrl: fileUrl(att.path), croppedUrl: fileUrl(croppedPath),
        done: i + 1, total,
      });
    } catch (err) {
      logger.warn(`Crop failed ${att.filename}: ${err.message}`);
      currentRun.prepared.push({ ...att, croppedPath: att.path, cropStatus: 'error' });
      broadcast('crop_error', { id: att.id, filename: att.filename, error: err.message, done: i + 1, total });
    }
  }

  currentRun.status = 'crop_done';
  broadcast('crop_complete', { prepared: currentRun.prepared.map(serializePrepared) });
  saveRunMeta(currentRun);
});

// AI re-crop single image with optional text feedback
app.post('/api/recrop', async (req, res) => {
  const { id, feedback, config: clientConfig = {} } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });

  const att = currentRun.attachments.find(a => a.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const croppedPath = await smartCrop(att.path, feedback || null, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
    const croppedUrl  = fileUrl(croppedPath);

    const idx = currentRun.prepared?.findIndex(p => p.id === id);
    if (idx >= 0) currentRun.prepared[idx] = { ...currentRun.prepared[idx], croppedPath };

    saveRunMeta(currentRun);
    res.json({ id, croppedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Manual crop via pixel percentages — bypasses AI, uses sharp directly
app.post('/api/manualcrop', async (req, res) => {
  const { id, leftPct = 0, topPct = 0, rightPct = 0, bottomPct = 0 } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });

  const att = currentRun.attachments.find(a => a.id === id);
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
    const croppedUrl = fileUrl(outPath) + `?t=${cropTime}`;
    const idx = currentRun.prepared?.findIndex(p => p.id === id);
    if (idx >= 0) currentRun.prepared[idx] = { ...currentRun.prepared[idx], croppedPath: outPath, cropTime };

    saveRunMeta(currentRun);
    res.json({ id, croppedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract bill data — mode: 'ocr' (default, fast) or 'llm' (vision, accurate)
app.post('/api/extract', async (req, res) => {
  const { approvedIds, mode = 'ocr', config: clientConfig = {} } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  if (!Array.isArray(approvedIds) || !approvedIds.length)
    return res.status(400).json({ error: 'approvedIds must be a non-empty array' });

  res.json({ ok: true });
  currentRun.status = 'extracting';

  const toProcess = (currentRun.prepared || []).filter(p => approvedIds.includes(p.id));
  const total = toProcess.length;
  const bills = [], skipped = [];

  if (mode === 'llm') {
    // ── LLM vision mode: 4-concurrent Claude Vision calls ──────────────────
    const CONCURRENCY = 4;
    async function processOne(att) {
      const croppedUrl = fileUrl(att.croppedPath) + (att.cropTime ? `?t=${att.cropTime}` : '');
      try {
        const data = await extractBillData(att.croppedPath, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
        if (data) {
          bills.push({ ...data, id: att.id, imagePath: att.croppedPath, filename: att.filename, cropTime: att.cropTime ?? null });
          broadcast('extract_result', { id: att.id, type: 'bill', ...data, croppedUrl, filename: att.filename });
        } else {
          skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath, cropTime: att.cropTime ?? null });
          broadcast('extract_result', { id: att.id, type: 'skipped', croppedUrl, filename: att.filename });
        }
      } catch (err) {
        logger.error(`Extract ${att.filename}: ${err.message}`);
        skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath, cropTime: att.cropTime ?? null, error: err.message });
        broadcast('extract_result', { id: att.id, type: 'skipped', croppedUrl, filename: att.filename, error: err.message });
      }
      broadcast('extract_progress', { done: bills.length + skipped.length, total });
    }
    for (let i = 0; i < toProcess.length; i += CONCURRENCY) {
      await Promise.all(toProcess.slice(i, i + CONCURRENCY).map(processOne));
    }

  } else {
    // ── OCR mode: two phases ─────────────────────────────────────────────────
    // Phase 1: All images OCR in parallel (worker pool). Each card appears as
    //          soon as its OCR completes (ocr_result event), showing the raw text.
    // Phase 2: One batch Claude text call. extract_result events then update the
    //          cards with structured bill_no / bill_date / bill_amount.

    broadcast('extract_progress', { done: 0, total, phase: 'ocr' });

    const ocrResults = [];
    await Promise.all(toProcess.map(async att => {
      const croppedUrl = fileUrl(att.croppedPath) + (att.cropTime ? `?t=${att.cropTime}` : '');
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
      broadcast('ocr_result', { id: att.id, filename: att.filename, croppedUrl, ocrText: text, ocrConfidence: confidence });
    }));

    // Phase 2: batch Claude extraction
    broadcast('extract_progress', { done: 0, total, phase: 'claude' });
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
      const croppedUrl = fileUrl(b.imagePath) + (att?.cropTime ? `?t=${att.cropTime}` : '');
      broadcast('extract_result', { id: b.id, type: 'bill', bill_no: b.bill_no,
        bill_date: b.bill_date, bill_amount: b.bill_amount, croppedUrl,
        filename: b.filename, ocrConfidence: b.ocrConfidence, ocrText: b.ocrText });
    }
    for (const s of skipped) {
      const att = toProcess.find(p => p.id === s.id);
      const croppedUrl = fileUrl(s.croppedPath || '') + (att?.cropTime ? `?t=${att.cropTime}` : '');
      broadcast('extract_result', { id: s.id, type: 'skipped', croppedUrl,
        filename: s.filename, error: s.error, ocrConfidence: s.ocrConfidence, ocrText: s.ocrText });
    }
    broadcast('extract_progress', { done: total, total });
  }

  currentRun.bills   = bills;
  currentRun.skipped = skipped;
  currentRun.status  = 'extracted';
  broadcast('extract_complete', {
    bills: bills.map(serializeBill),
    skipped: skipped.map(serializeSkipped),
  });
  saveRunMeta(currentRun);
});

// Re-extract a single bill using LLM vision (called from Step 3 review)
app.post('/api/reextract', async (req, res) => {
  const { id, config: clientConfig = {} } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });

  const att = (currentRun.prepared || []).find(p => p.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const data = await extractBillData(att.croppedPath, { apiKey: resolveConfig(clientConfig).ANTHROPIC_API_KEY });
    if (!data) return res.json({ id, found: false });

    // Update in-memory bills list
    const existing = currentRun.bills?.find(b => b.id === id);
    if (existing) {
      Object.assign(existing, data);
    } else {
      currentRun.bills = currentRun.bills || [];
      currentRun.bills.push({ ...data, id, imagePath: att.croppedPath, filename: att.filename });
      currentRun.skipped = (currentRun.skipped || []).filter(s => s.id !== id);
    }

    saveRunMeta(currentRun);
    res.json({ id, found: true, bill_no: data.bill_no, bill_date: data.bill_date, bill_amount: data.bill_amount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Save user-edited bill data + removed/included sets (called before portal submit and after edits)
app.put('/api/bills', (req, res) => {
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  const { bills, skipped, removedIds, includedSkippedIds } = req.body;

  if (Array.isArray(bills)) {
    currentRun.bills = bills.map(b => {
      const orig = (currentRun.bills || []).find(o => o.id === b.id) || {};
      return { ...orig, bill_no: b.bill_no, bill_date: b.bill_date, bill_amount: b.bill_amount };
    });
  }
  if (Array.isArray(skipped)) {
    currentRun.skipped = (currentRun.skipped || []).map(s => {
      const edited = skipped.find(e => e.id === s.id);
      return edited ? { ...s, bill_no: edited.bill_no, bill_date: edited.bill_date, bill_amount: edited.bill_amount } : s;
    });
  }
  if (Array.isArray(removedIds))          currentRun.removedIds = removedIds;
  if (Array.isArray(includedSkippedIds))  currentRun.includedSkippedIds = includedSkippedIds;

  saveRunMeta(currentRun);
  res.json({ ok: true });
});

// Submit to portal — async
app.post('/api/submit', async (req, res) => {
  const { bills: edited, config: clientConfig = {} } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  if (!Array.isArray(edited) || !edited.length)
    return res.status(400).json({ error: 'bills must be a non-empty array' });

  res.json({ ok: true });
  currentRun.status = 'submitting';
  broadcast('submit_start', { total: edited.length });

  const lookup = [
    ...(currentRun.bills   || []),
    ...(currentRun.skipped || []).map(s => ({ ...s, imagePath: s.croppedPath })),
  ];

  const billsWithPaths = edited.map(b => {
    const orig = lookup.find(p => p.id === b.id);
    return { ...b, imagePath: orig?.imagePath || null };
  }).filter(b => b.imagePath);

  const killController = new AbortController();
  currentRun.killController = killController;
  currentRun.paused = false;

  // waitIfPaused: portal calls this between steps; resolves instantly or waits until resumed
  function waitIfPaused() {
    return currentRun?.paused ? (currentRun._pausePromise || Promise.resolve()) : Promise.resolve();
  }

  // waitForConfirm: portal calls this after all bills are saved; waits for POST /api/submit/confirm
  function waitForConfirm() {
    return new Promise(resolve => { currentRun._confirmResolve = resolve; });
  }

  try {
    const result = await submitReimbursementClaims(billsWithPaths, {
      broadcast,
      signal: killController.signal,
      waitIfPaused,
      waitForConfirm,
      config: clientConfig,
    });
    currentRun.result = result;
    currentRun.status = result.success ? 'done' : 'error';
    saveRunMeta(currentRun);
    broadcast('submit_complete', { result });
  } catch (err) {
    currentRun.status = 'error';
    currentRun.error  = err.message;
    saveRunMeta(currentRun);
    broadcast('submit_error', { error: err.message });
  } finally {
    if (currentRun) {
      currentRun.killController = null;
      if (currentRun._confirmResolve) { currentRun._confirmResolve(); currentRun._confirmResolve = null; }
      if (currentRun._pauseResolve) { currentRun._pauseResolve(); currentRun._pauseResolve = null; }
    }
  }
});

// Kill an in-progress submission
app.post('/api/submit/kill', (req, res) => {
  if (currentRun?.killController) {
    currentRun.killController.abort();
    res.json({ ok: true });
  } else {
    res.json({ ok: false, message: 'No active submission' });
  }
});

// Pause / resume submission (honoured between bill entries)
app.post('/api/submit/pause', (req, res) => {
  if (!currentRun) return res.status(400).json({ ok: false });
  if (!currentRun.paused) {
    currentRun.paused = true;
    // Create a latch that portal's waitIfPaused() will wait on
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    currentRun._pausePromise = promise;
    currentRun._pauseResolve = resolve;
    broadcast('submit_paused', { paused: true });
  } else {
    currentRun.paused = false;
    if (currentRun._pauseResolve) { currentRun._pauseResolve(); }
    currentRun._pausePromise = null;
    currentRun._pauseResolve = null;
    broadcast('submit_paused', { paused: false });
  }
  res.json({ ok: true, paused: currentRun.paused });
});

// Confirm final submit (called from UI after user reviews portal entries)
app.post('/api/submit/confirm', (req, res) => {
  if (currentRun?._confirmResolve) {
    currentRun._confirmResolve();
    currentRun._confirmResolve = null;
  }
  broadcast('submit_confirmed');
  res.json({ ok: true });
});

// Retry specific failed bills — portal page is still open during confirm gate
app.post('/api/submit/retry-failed', async (req, res) => {
  const { bills } = req.body;
  if (!Array.isArray(bills) || !bills.length) return res.status(400).json({ error: 'bills required' });
  res.json({ ok: true });  // respond immediately; result comes via SSE
  try {
    await retryFailedBills(bills);
  } catch (err) {
    broadcast('submit_progress', { id: 'retry_error', step: 'error', label: `Retry error: ${err.message}`, status: 'error' });
  }
});

// List all saved runs (newest first)
app.get('/api/runs', (req, res) => {
  if (!fs.existsSync(DOWNLOADS_DIR)) return res.json([]);
  try {
    const runs = fs.readdirSync(DOWNLOADS_DIR)
      .filter(name => /^run_\d+$/.test(name))
      .map(name => {
        const metaPath = path.join(DOWNLOADS_DIR, name, 'meta.json');
        if (!fs.existsSync(metaPath)) return null;
        try {
          const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
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

// Activate a saved run as currentRun
app.post('/api/runs/:id/activate', (req, res) => {
  const runDir = path.join(DOWNLOADS_DIR, req.params.id);
  const metaPath = path.join(runDir, 'meta.json');
  if (!fs.existsSync(metaPath)) return res.status(404).json({ error: 'Run not found' });
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    // Don't leave it stuck in submitting state on reload
    if (meta.status === 'submitting') meta.status = 'extracted';
    currentRun = { ...meta, killController: null, paused: false };
    res.json({ run: getRunState() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a saved run (removes directory and clears currentRun if it matches)
app.delete('/api/runs/:id', (req, res) => {
  const { id } = req.params;
  const runDir = path.join(DOWNLOADS_DIR, id);
  if (!fs.existsSync(runDir)) return res.status(404).json({ error: 'Run not found' });
  if (currentRun?.id === id) currentRun = null;
  fs.rmSync(runDir, { recursive: true, force: true });
  res.json({ ok: true });
});

app.delete('/api/run', (req, res) => {
  currentRun = null;
  res.json({ ok: true });
});

// SPA fallback
app.use((req, res) => {
  const idx = path.join(WEB_DIST, 'index.html');
  if (fs.existsSync(idx)) res.sendFile(idx);
  else res.status(404).send('Web app not built yet. Run: cd web && npm run build');
});

app.listen(PORT, () => {
  logger.info(`Server → http://localhost:${PORT}`);
  migrateOldRuns();
});

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

      // Derive a display folder name from the run timestamp
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
