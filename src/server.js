require('dotenv').config();
const express = require('express');
const multer  = require('multer');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { smartCrop } = require('./image-processor');
const { extractBillData } = require('./bill-extractor');
const { extractAllBillsOCR } = require('./ocr-extractor');
const { submitReimbursementClaims } = require('./portal');
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
  return {
    id: b.id,
    filename: b.filename,
    bill_no: b.bill_no,
    bill_date: b.bill_date,
    bill_amount: b.bill_amount,
    croppedUrl: fileUrl(b.imagePath),
  };
}

function serializeSkipped(s) {
  return {
    id: s.id,
    filename: s.filename,
    error: s.error || null,
    croppedUrl: s.croppedPath ? fileUrl(s.croppedPath) : null,
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
    result: currentRun.result,
    error: currentRun.error,
  };
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => res.json({ run: getRunState() }));

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
    const dst = path.join(runDir, name);
    fs.copyFileSync(path.join(resolved, name), dst);
    return { id: `img_${i}`, filename: name, path: dst };
  });

  currentRun = { id: runId, folder: resolved, runDir, attachments, status: 'loaded' };
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
    const filename = path.basename(file.originalname);
    const dst = path.join(runDir, filename);
    fs.writeFileSync(dst, file.buffer);
    return { id: `img_${i}`, filename, path: dst };
  });

  // Derive folder name from the first file's relative path
  const folderName = imageFiles[0].originalname.includes('/')
    ? imageFiles[0].originalname.split('/')[0]
    : 'uploaded';

  currentRun = { id: runId, folder: folderName, runDir, attachments, status: 'loaded' };
  logger.info(`Run ${runId}: ${attachments.length} images uploaded (${folderName})`);

  res.json({ runId, folderName, attachments: attachments.map(serializeAtt) });
});

// Crop all images — async, streams progress via SSE
app.post('/api/crop', async (req, res) => {
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  if (currentRun.status === 'cropping') return res.status(409).json({ error: 'Already cropping' });

  res.json({ ok: true });
  currentRun.status = 'cropping';
  currentRun.prepared = [];

  const total = currentRun.attachments.length;
  for (let i = 0; i < total; i++) {
    const att = currentRun.attachments[i];
    try {
      const croppedPath = await smartCrop(att.path);
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
});

// AI re-crop single image with optional text feedback
app.post('/api/recrop', async (req, res) => {
  const { id, feedback } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });

  const att = currentRun.attachments.find(a => a.id === id);
  if (!att) return res.status(404).json({ error: 'Image not found' });

  try {
    const croppedPath = await smartCrop(att.path, feedback || null);
    const croppedUrl  = fileUrl(croppedPath);

    const idx = currentRun.prepared?.findIndex(p => p.id === id);
    if (idx >= 0) currentRun.prepared[idx] = { ...currentRun.prepared[idx], croppedPath };

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

    res.json({ id, croppedUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Extract bill data from approved images — async, streams via SSE
app.post('/api/extract', async (req, res) => {
  const { approvedIds } = req.body;
  if (!currentRun) return res.status(400).json({ error: 'No active run' });
  if (!Array.isArray(approvedIds) || !approvedIds.length)
    return res.status(400).json({ error: 'approvedIds must be a non-empty array' });

  res.json({ ok: true });
  currentRun.status = 'extracting';

  const toProcess = (currentRun.prepared || []).filter(p => approvedIds.includes(p.id));
  const total = toProcess.length;

  // Signal that OCR + batch extraction is running
  broadcast('extract_progress', { done: 0, total, phase: 'ocr' });

  let extractedBills = [];
  try {
    extractedBills = await extractAllBillsOCR(toProcess);
  } catch (err) {
    logger.error(`Batch OCR extraction failed: ${err.message}`);
  }

  // Build bills/skipped by diffing against toProcess
  const extractedIds = new Set(extractedBills.map(b => b.id));
  const bills   = extractedBills;
  const skipped = toProcess
    .filter(p => !extractedIds.has(p.id))
    .map(p => ({ id: p.id, filename: p.filename, croppedPath: p.croppedPath }));

  // Broadcast individual results so UI updates incrementally
  for (const b of bills) {
    const croppedUrl = fileUrl(b.imagePath) + (toProcess.find(p => p.id === b.id)?.cropTime ? `?t=${toProcess.find(p => p.id === b.id).cropTime}` : '');
    broadcast('extract_result', { id: b.id, type: 'bill', bill_no: b.bill_no, bill_date: b.bill_date, bill_amount: b.bill_amount, croppedUrl, filename: b.filename });
  }
  for (const s of skipped) {
    const att = toProcess.find(p => p.id === s.id);
    const croppedUrl = fileUrl(s.croppedPath) + (att?.cropTime ? `?t=${att.cropTime}` : '');
    broadcast('extract_result', { id: s.id, type: 'skipped', croppedUrl, filename: s.filename });
  }

  broadcast('extract_progress', { done: total, total });

  currentRun.bills   = bills;
  currentRun.skipped = skipped;
  currentRun.status  = 'extracted';
  broadcast('extract_complete', {
    bills: bills.map(serializeBill),
    skipped: skipped.map(serializeSkipped),
  });
});

// Submit to portal — async
app.post('/api/submit', async (req, res) => {
  const { bills: edited } = req.body;
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

  try {
    const result = await submitReimbursementClaims(billsWithPaths);
    currentRun.result = result;
    currentRun.status = result.success ? 'done' : 'error';
    broadcast('submit_complete', { result });
  } catch (err) {
    currentRun.status = 'error';
    currentRun.error  = err.message;
    broadcast('submit_error', { error: err.message });
  }
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

app.listen(PORT, () => logger.info(`Server → http://localhost:${PORT}`));
