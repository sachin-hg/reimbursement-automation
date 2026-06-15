require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { createWorker } = require('tesseract.js');
const logger = require('./logger');

// Images whose OCR text scores below this threshold fall back to vision
const OCR_QUALITY_THRESHOLD = 80;

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── OCR ───────────────────────────────────────────────────────────────────────
// Pre-process with Sharp (greyscale + contrast) then run Tesseract.
// Returns raw extracted text, or empty string if unreadable.

let _worker = null;

async function getWorker() {
  if (!_worker) {
    _worker = await createWorker('eng', 1, { logger: () => {} });
  }
  return _worker;
}

async function ocrImage(imagePath) {
  // Pre-process: greyscale, normalize contrast, scale up to ~1200px wide
  const meta = await sharp(imagePath, { failOn: 'none' }).metadata();
  const targetW = Math.max(1200, meta.width || 1200);

  const tmpPath = path.join(os.tmpdir(), `ocr_${path.basename(imagePath)}_${Date.now()}.png`);
  await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .resize(targetW, null, { withoutEnlargement: false })
    .greyscale()
    .normalise()           // auto stretch contrast
    .sharpen({ sigma: 1 })
    .png()
    .toFile(tmpPath);

  try {
    const worker = await getWorker();
    const { data: { text } } = await worker.recognize(tmpPath);
    return text.trim();
  } finally {
    fs.unlink(tmpPath, () => {});
  }
}

// ── Batch LLM extraction ──────────────────────────────────────────────────────
// Send all OCR texts in a single Claude call. Much cheaper than sending images.

async function extractAllBillsOCR(preparedAttachments) {
  const results = [];

  // 1. OCR all images in parallel
  logger.info(`OCR: processing ${preparedAttachments.length} images…`);
  const ocrResults = await Promise.all(
    preparedAttachments.map(async att => {
      try {
        const text = await ocrImage(att.croppedPath);
        logger.info(`  OCR ${att.filename}: ${text.length} chars`);
        return { att, text };
      } catch (err) {
        logger.warn(`  OCR failed ${att.filename}: ${err.message}`);
        return { att, text: '' };
      }
    })
  );

  // 2. Split: good OCR → batch text call; poor OCR → vision fallback
  const readable   = ocrResults.filter(r => r.text.length >= OCR_QUALITY_THRESHOLD);
  const needVision = ocrResults.filter(r => r.text.length <  OCR_QUALITY_THRESHOLD);

  needVision.forEach(r => logger.warn(`  Poor OCR on ${r.att.filename} (${r.text.length} chars) — falling back to vision`));

  if (!readable.length) {
    logger.warn('No readable images after OCR');
    return [];
  }

  // 3. Single Claude call with all OCR texts
  const receiptBlocks = readable.map((r, i) =>
    `RECEIPT ${r.att.id} (${r.att.filename}):\n${r.text}`
  ).join('\n\n---\n\n');

  logger.info(`Sending ${readable.length} OCR texts to Claude in one call…`);

  let parsed;
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
        content: `Extract structured data from these OCR-scanned petrol receipts. For each receipt return an object in the JSON array.

${receiptBlocks}

Return ONLY a JSON array (one object per receipt, in the same order):
[
  {
    "id": "<receipt id from the header>",
    "bill_no": "<invoice/receipt/slip/txn number — null if not found>",
    "bill_date": "<date as DD/MM/YYYY — null if not found>",
    "bill_amount": <total amount paid as number — null if not found>,
    "valid": <true if all three fields present AND amount 400–5000 AND NOT clearly restaurant/grocery>,
    "skip_reason": "<brief reason if valid=false, else null>"
  }
]

Tips:
- bill_no: "Invoice No", "INV NO", "Receipt No", "Slip No", "TXN NO", "APPR CODE"
- bill_date: any date format → DD/MM/YYYY
- bill_amount: "AMOUNT", "Total", "Rs.", "₹", "INR", "Sale", "BASE AMT" — keep decimals
- Accept both fuel bills AND card machine receipts (Pine Labs, HDFC, etc.) from petrol stations`,
      }],
    });

    const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
    parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)[0]);
  } catch (err) {
    logger.error(`Claude batch call failed: ${err.message}`);
    return [];
  }

  // 4. Vision fallback for poor-OCR images (individual calls, already fast since few images)
  if (needVision.length) {
    logger.info(`Vision fallback for ${needVision.length} image(s)…`);
    const { extractBillData } = require('./bill-extractor');
    const fallbackResults = await Promise.all(needVision.map(async r => {
      try {
        const data = await extractBillData(r.att.croppedPath);
        if (data) {
          logger.info(`  ✓ Vision fallback ${r.att.filename}: ₹${data.bill_amount}`);
          return { id: r.att.id, bill_no: data.bill_no, bill_date: data.bill_date, bill_amount: data.bill_amount, valid: true };
        }
      } catch (err) {
        logger.warn(`  Vision fallback failed ${r.att.filename}: ${err.message}`);
      }
      return null;
    }));

    for (const item of fallbackResults) {
      if (!item) continue;
      const att = needVision.find(r => r.att.id === item.id)?.att;
      if (att) parsed.push({ ...item, _fromVision: true });
    }
  }

  // 5. Map results back, log each
  const idToAtt = Object.fromEntries([...readable, ...needVision].map(r => [r.att.id, r.att]));

  for (const item of parsed) {
    const att = idToAtt[item.id];
    if (!att) continue;

    if (!item.valid) {
      logger.warn(`  Skipping ${att.filename}: ${item.skip_reason || 'marked invalid'}`);
      continue;
    }
    if (!item.bill_amount || item.bill_amount < 400 || item.bill_amount > 5000) {
      logger.warn(`  Skipping ${att.filename}: amount ₹${item.bill_amount} outside 400–5000`);
      continue;
    }

    logger.info(`  ✓ No: ${item.bill_no} | Date: ${item.bill_date} | Amount: ₹${item.bill_amount}`);
    results.push({
      bill_no: item.bill_no,
      bill_date: item.bill_date,
      bill_amount: item.bill_amount,
      valid: true,
      imagePath: att.croppedPath,
      filename: att.filename,
      id: att.id,
    });
  }

  return results;
}

async function terminateWorker() {
  if (_worker) { await _worker.terminate(); _worker = null; }
}

module.exports = { extractAllBillsOCR, ocrImage, terminateWorker };
