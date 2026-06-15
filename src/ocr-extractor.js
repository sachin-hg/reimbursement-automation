require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Images with Tesseract mean-word confidence below this are flagged low-confidence.
// In auto mode these are skipped; in human mode they're sorted to the top for review.
const LOW_CONFIDENCE_THRESHOLD = 55;

// ── Tesseract worker (singleton, reused across calls) ─────────────────────────

let _worker = null;

async function getWorker() {
  if (!_worker) {
    _worker = await createWorker('eng', 1, { logger: () => {} });
  }
  return _worker;
}

// ── OCR one image ─────────────────────────────────────────────────────────────
// Pre-processes with Sharp (greyscale + normalize + sharpen) for better accuracy.
// Returns { text, confidence } where confidence is 0-100 (Tesseract mean word confidence).

async function ocrImage(imagePath) {
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

  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(tmpPath);
    const words = data.words || [];
    const confidence = words.length
      ? Math.round(words.reduce((s, w) => s + w.confidence, 0) / words.length)
      : 0;
    return { text: data.text.trim(), confidence };
  } finally {
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
// Takes OCR results + prepared attachments; sends all texts in one Claude call.
// For low-confidence or blank OCR, falls back to individual vision calls.

async function extractFromOCR(ocrResults, preparedAttachments, { autoMode = false } = {}) {
  const attById = Object.fromEntries(preparedAttachments.map(a => [a.id, a]));

  // In auto mode: skip low-confidence results entirely (don't even vision-fallback)
  // In human mode: vision-fallback for low-confidence so human can review/correct
  const toExtract  = ocrResults.filter(r => r.ocrOk && (autoMode ? r.confidence >= LOW_CONFIDENCE_THRESHOLD : true));
  const lowConf    = ocrResults.filter(r => r.ocrOk && !autoMode && r.confidence < LOW_CONFIDENCE_THRESHOLD);
  const noText     = ocrResults.filter(r => !r.ocrOk);

  if (autoMode) {
    noText.concat(ocrResults.filter(r => r.ocrOk && r.confidence < LOW_CONFIDENCE_THRESHOLD))
      .forEach(r => logger.warn(`  Auto-skip ${attById[r.id]?.filename}: low confidence (${r.confidence})`));
  }

  const bills = [], skipped = [];

  // ── Batch text call for good-OCR images ──────────────────────────────────
  if (toExtract.length) {
    const receiptBlocks = toExtract.map(r =>
      `RECEIPT ${r.id} (${attById[r.id]?.filename}):\n${r.text}`
    ).join('\n\n---\n\n');

    logger.info(`Sending ${toExtract.length} OCR texts to Claude in one call…`);
    let parsed = [];
    try {
      const response = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
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
      });

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

  // ── Vision fallback for low-confidence OCR (human mode only) ─────────────
  if (lowConf.length) {
    logger.info(`Vision fallback for ${lowConf.length} low-confidence image(s)…`);
    const { extractBillData } = require('./bill-extractor');
    await Promise.all(lowConf.map(async r => {
      const att = attById[r.id];
      try {
        const data = await extractBillData(att.croppedPath);
        if (data) {
          logger.info(`  ✓ Vision ${att.filename}: ₹${data.bill_amount}`);
          bills.push({ id: att.id, filename: att.filename, imagePath: att.croppedPath, ...data });
        } else {
          skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath });
        }
      } catch (err) {
        logger.warn(`  Vision fallback failed ${att.filename}: ${err.message}`);
        skipped.push({ id: att.id, filename: att.filename, croppedPath: att.croppedPath, error: err.message });
      }
    }));
  }

  // ── No-text images always go to skipped ──────────────────────────────────
  for (const r of noText) {
    const att = attById[r.id];
    skipped.push({ id: r.id, filename: att?.filename, croppedPath: att?.croppedPath,
      error: 'OCR returned no readable text' });
  }

  return { bills, skipped };
}

async function terminateWorker() {
  if (_worker) { await _worker.terminate(); _worker = null; }
}

module.exports = { ocrAllImages, extractFromOCR, ocrImage, terminateWorker, LOW_CONFIDENCE_THRESHOLD };
