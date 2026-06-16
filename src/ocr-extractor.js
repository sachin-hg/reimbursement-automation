require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const logger = require('./logger');

function getClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
}

// Images with Tesseract mean-word confidence below this are flagged low-confidence.
// In auto mode these are skipped; in human mode they're sorted to the top for review.
const LOW_CONFIDENCE_THRESHOLD = 55;

// ── Tesseract worker pool ─────────────────────────────────────────────────────
// Multiple workers so OCR runs in parallel across CPU cores.
// In memory-constrained environments (Railway, etc.) reduce via OCR_WORKERS=1.
// Each worker loads ~25MB of WASM + language data, so 4 workers ≈ 100MB resident.

const POOL_SIZE = parseInt(process.env.OCR_WORKERS || '4', 10);
let _pool = null;
let _poolBusy = null;
let _poolQueue = [];

async function initPool() {
  if (_pool) return;
  _pool = await Promise.all(
    Array.from({ length: POOL_SIZE }, () => createWorker('eng', 1, { logger: () => {} }))
  );
  _poolBusy = new Array(POOL_SIZE).fill(false);
}

function acquireWorker() {
  return new Promise(resolve => {
    function tryGet() {
      const idx = _poolBusy.findIndex(b => !b);
      if (idx >= 0) {
        _poolBusy[idx] = true;
        resolve({
          worker: _pool[idx],
          release() { _poolBusy[idx] = false; if (_poolQueue.length) _poolQueue.shift()(); },
        });
      } else {
        _poolQueue.push(tryGet);
      }
    }
    tryGet();
  });
}

// ── Domain-specific confidence score ─────────────────────────────────────────
// Scores extracted text on presence of key petrol-bill fields.
// More meaningful than Tesseract's character-recognition confidence for our use case.
//
//  40 pts — amount found (₹/Rs/AMOUNT/Total + digits)
//  30 pts — date found (DD/MM/YYYY or similar pattern)
//  20 pts — bill/invoice identifier found
//  10 pts — petrol-station or payment-terminal context found
// ─────────────────────────────────────────────────────────────────────────────

function computeConfidence(text) {
  if (!text || text.length < 15) return 0;
  let score = 0;

  // Amount indicator — keyword + optional noise + digits
  if (/(?:amount|total|rs\.?|₹|inr|sale|net\s*amt|base\s*amt)[^0-9]{0,12}[\d,]+\.?\d*/i.test(text) ||
      /(?:₹|rs\.?\s*)[\d,]+/i.test(text)) {
    score += 40;
  } else if (/\b\d{3,5}\.\d{2}\b/.test(text)) {
    score += 20;
  }

  // Date pattern — DD/MM/YYYY, YYYY-MM-DD, or DD MMM YYYY (abbreviated month)
  if (/\b\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4}\b/.test(text) ||
      /\b\d{4}[\/\-\.]\d{1,2}[\/\-\.]\d{1,2}\b/.test(text) ||
      /\b\d{1,2}[\s\-](?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\s\-]\d{2,4}\b/i.test(text)) {
    score += 30;
  }

  // Bill / invoice identifier — match the keyword stem, OCR often garbles the suffix
  if (/\b(?:invoice|receipt|voucher)\b/i.test(text) ||
      /\b(?:inv|txn|appr|batch|slip|ref)\b/i.test(text) ||
      /bill\s*no/i.test(text)) {
    score += 20;
  }

  // Petrol-station brand or payment terminal — confirms receipt type
  if (/\b(?:petrol|diesel|fuel|ltr|litre|hpcl|bpcl|iocl|essar|reliance|shell|nayara)\b/i.test(text) ||
      /\b(?:pine\s*labs|hdfc|icici|sbi|axis|kotak|paytm|bharatpe|rupay|visa|mastercard)\b/i.test(text)) {
    score += 10;
  }

  return Math.min(100, score);
}

// ── OCR one image ─────────────────────────────────────────────────────────────
// Pre-processes with Sharp (greyscale + normalize + sharpen) for better accuracy.
// Returns { text, confidence } where confidence is 0-100 domain-specific score.

async function ocrImage(imagePath) {
  await initPool();

  const meta = await sharp(imagePath, { failOn: 'none' }).metadata();
  const targetW = Math.max(1200, meta.width || 1200);

  const tmpPath = path.join(os.tmpdir(), `ocr_${Date.now()}_${path.basename(imagePath)}.png`);
  await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .resize(targetW, null, { withoutEnlargement: false })
    .greyscale()
    .normalise()
    .sharpen({ sigma: 1 })
    .png()
    .toFile(tmpPath);

  const { worker, release } = await acquireWorker();
  try {
    const { data } = await worker.recognize(tmpPath);
    const text = data.text.trim();
    const confidence = computeConfidence(text);
    return { text, confidence };
  } finally {
    release();
    fs.unlink(tmpPath, () => {});
  }
}

// ── Step 1: OCR all images (no Claude call) ───────────────────────────────────
// Called during crop review so confidence scores are ready before extraction.

async function ocrAllImages(preparedAttachments) {
  logger.info(`OCR scanning ${preparedAttachments.length} images for confidence scores…`);
  const results = await Promise.all(
    preparedAttachments.map(async att => {
      try {
        const { text, confidence } = await ocrImage(att.croppedPath);
        logger.info(`  OCR ${att.filename}: ${text.length} chars, confidence ${confidence}`);
        return { id: att.id, text, confidence, ocrOk: text.length >= 40 };
      } catch (err) {
        logger.warn(`  OCR failed ${att.filename}: ${err.message}`);
        return { id: att.id, text: '', confidence: 0, ocrOk: false };
      }
    })
  );
  return results; // [{ id, text, confidence, ocrOk }]
}

// ── Step 2: Batch Claude text extraction ──────────────────────────────────────
// Sends OCR texts to Claude in one call. Low-confidence images are included and
// Claude handles the noise — human reviews results and can re-extract with LLM.
// In auto mode, low-confidence images are skipped (or fall back to LLM vision if llmFallback is supplied).

async function extractFromOCR(ocrResults, preparedAttachments, { autoMode = false, apiKey, llmFallback } = {}) {
  const attById = Object.fromEntries(preparedAttachments.map(a => [a.id, a]));

  // Auto mode: only process high-confidence images, send the rest to llmFallback (or skip).
  // Human mode: send ALL images with readable text to Claude text batch (including low-confidence).
  const toExtract = ocrResults.filter(r => r.ocrOk &&
    (autoMode ? r.confidence >= LOW_CONFIDENCE_THRESHOLD : true));
  const noText    = ocrResults.filter(r => !r.ocrOk);
  const lowConf   = autoMode ? ocrResults.filter(r => r.ocrOk && r.confidence < LOW_CONFIDENCE_THRESHOLD) : [];

  if (autoMode) {
    [...noText, ...lowConf].forEach(r =>
      logger.warn(`  Low/no OCR confidence ${attById[r.id]?.filename} (${r.confidence})${llmFallback ? ' — will try LLM vision' : ' — skipping'}`)
    );
  } else {
    if (lowConf.length) logger.info(`  ${lowConf.length} low-confidence image(s) included in batch — human will review`);
  }

  const bills = [], skipped = [];

  // ── Batch text call for good-OCR images ──────────────────────────────────
  if (toExtract.length) {
    const receiptBlocks = toExtract.map(r =>
      `RECEIPT ${r.id} (${attById[r.id]?.filename}):\n${r.text}`
    ).join('\n\n---\n\n');

    // ~150 tokens per bill for the JSON output; give plenty of headroom
    const maxTokens = Math.max(2048, toExtract.length * 200 + 512);
    logger.info(`Sending ${toExtract.length} OCR texts to Claude (max_tokens=${maxTokens})…`);
    let parsed = [];
    try {
      const response = await getClient(apiKey).messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: maxTokens,
        system: [
          'You are an expert at parsing Indian petrol/fuel receipt text extracted by OCR.',
          'OCR text may have noise, misrecognised characters, or missing spaces — use context to correct.',
          'Always return valid JSON only — no markdown, no prose.',
        ].join(' '),
        messages: [{
          role: 'user',
          content: `Extract structured data from these OCR-scanned petrol receipts.

${receiptBlocks}

Return ONLY a JSON array (one object per receipt):
[
  {
    "id": "<receipt id from the header>",
    "bill_no": "<invoice/receipt/slip/txn number — null if not found>",
    "bill_date": "<date as DD/MM/YYYY — null if not found>",
    "bill_amount": <total amount paid as a number — null if not found>,
    "valid": <true if all three fields present AND amount 400–5000 AND NOT clearly restaurant/grocery>,
    "skip_reason": "<brief reason if valid=false, else null>"
  }
]

Tips:
- bill_no: "Invoice No", "INV NO", "Receipt No", "Slip No", "TXN NO", "APPR CODE"
- bill_date: any date format → DD/MM/YYYY
- bill_amount: "AMOUNT", "Total", "Rs.", "₹", "INR", "Sale", "BASE AMT" — keep decimals
- Accept fuel bills AND card machine receipts (Pine Labs, HDFC, etc.) from petrol stations`,
        }],
      }, { timeout: 90_000, maxRetries: 1 });

      const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
      parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)[0]);
    } catch (err) {
      logger.error(`Claude batch call failed: ${err.message}`);
    }

    for (const item of parsed) {
      const att = attById[item.id];
      if (!att) continue;
      if (!item.valid || !item.bill_amount || item.bill_amount < 400 || item.bill_amount > 5000) {
        logger.warn(`  Skipping ${att.filename}: ${item.skip_reason || 'invalid'}`);
        skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath });
        continue;
      }
      logger.info(`  ✓ No: ${item.bill_no} | Date: ${item.bill_date} | Amount: ₹${item.bill_amount}`);
      bills.push({ id: att.id, filename: att.filename, imagePath: att.croppedPath,
        bill_no: item.bill_no, bill_date: item.bill_date, bill_amount: item.bill_amount });
    }

    // Mark any IDs that came back from Claude but weren't in parsed (shouldn't happen)
    const parsedIds = new Set(parsed.map(p => p.id));
    for (const r of toExtract) {
      if (!parsedIds.has(r.id) && !bills.find(b => b.id === r.id) && !skipped.find(s => s.id === r.id)) {
        skipped.push({ id: r.id, filename: attById[r.id]?.filename, croppedPath: attById[r.id]?.croppedPath });
      }
    }
  }

  // ── LLM vision fallback for low/no-confidence images ────────────────────────
  // Used when the caller supplies llmFallback (e.g. daemon mode, CLI without --human).
  // Images with no OCR text OR low confidence are sent to the vision model directly.
  const needFallback = [...noText, ...lowConf];
  if (llmFallback && needFallback.length) {
    logger.info(`LLM vision fallback for ${needFallback.length} image(s)…`);
    for (const r of needFallback) {
      const att = attById[r.id];
      if (!att) continue;
      try {
        const data = await llmFallback(att.croppedPath);
        if (data) {
          logger.info(`  ✓ LLM fallback ${att.filename}: No: ${data.bill_no} | Date: ${data.bill_date} | ₹${data.bill_amount}`);
          bills.push({ id: att.id, filename: att.filename, imagePath: att.croppedPath,
            bill_no: data.bill_no, bill_date: data.bill_date, bill_amount: data.bill_amount });
        } else {
          skipped.push({ id: r.id, filename: att.filename, croppedPath: att.croppedPath,
            error: 'LLM vision could not extract valid data' });
        }
      } catch (err) {
        logger.warn(`  LLM fallback failed ${att.filename}: ${err.message}`);
        skipped.push({ id: r.id, filename: att.filename, croppedPath: att.croppedPath, error: err.message });
      }
    }
  } else {
    // No fallback — put all no-text images into skipped
    for (const r of noText) {
      const att = attById[r.id];
      skipped.push({ id: r.id, filename: att?.filename, croppedPath: att?.croppedPath,
        error: 'OCR returned no readable text' });
    }
    // In autoMode without fallback, low-confidence images were already warned above;
    // they're not in toExtract so they silently end up absent from both bills and skipped.
    // Add them to skipped so callers know about them.
    for (const r of lowConf) {
      const att = attById[r.id];
      skipped.push({ id: r.id, filename: att?.filename, croppedPath: att?.croppedPath,
        error: `Low OCR confidence (${r.confidence})` });
    }
  }

  return { bills, skipped };
}

// ── Single-image Claude text extraction ───────────────────────────────────────
// Used in the per-image streaming pipeline. Returns bill object or null.

async function extractSingleFromText(ocrResult, att, apiKey) {
  try {
    const response = await getClient(apiKey).messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      system: 'You are an expert at parsing Indian petrol/fuel receipt text extracted by OCR. OCR text may have noise — use context to correct. Return valid JSON only, no markdown.',
      messages: [{
        role: 'user',
        content: `Extract structured data from this OCR-scanned petrol receipt (${att.filename}):

${ocrResult.text}

Return ONLY a JSON object:
{
  "bill_no": "<invoice/receipt/slip/txn number — null if not found>",
  "bill_date": "<date as DD/MM/YYYY — null if not found>",
  "bill_amount": <total amount paid as a number — null if not found>,
  "valid": <true if all three fields present AND amount 400–5000 AND NOT clearly restaurant/grocery>,
  "skip_reason": "<brief reason if valid=false, else null>"
}

Tips:
- bill_no: "Invoice No", "INV NO", "Receipt No", "Slip No", "TXN NO", "APPR CODE"
- bill_date: any date format → DD/MM/YYYY
- bill_amount: "AMOUNT", "Total", "Rs.", "₹", "INR", "Sale", "BASE AMT" — keep decimals
- Accept fuel bills AND card machine receipts (Pine Labs, HDFC, etc.) from petrol stations`,
      }],
    });

    const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    const item = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);

    if (!item.valid || !item.bill_amount || item.bill_amount < 400 || item.bill_amount > 5000) {
      logger.warn(`  Skip ${att.filename}: ${item.skip_reason || 'invalid'}`);
      return null;
    }
    logger.info(`  ✓ No: ${item.bill_no} | Date: ${item.bill_date} | Amount: ₹${item.bill_amount}`);
    return { id: att.id, filename: att.filename, imagePath: att.croppedPath,
      bill_no: item.bill_no, bill_date: item.bill_date, bill_amount: item.bill_amount };
  } catch (err) {
    logger.warn(`  Text extract failed ${att.filename}: ${err.message}`);
    return null;
  }
}

async function terminateWorker() {
  if (_pool) { await Promise.all(_pool.map(w => w.terminate())); _pool = null; _poolBusy = null; }
}

module.exports = { ocrAllImages, extractFromOCR, ocrImage, extractSingleFromText, terminateWorker, LOW_CONFIDENCE_THRESHOLD };
