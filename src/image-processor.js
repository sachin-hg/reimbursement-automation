require('dotenv').config();
const sharp = require('sharp');
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const logger = require('./logger');

function getClient(apiKey) {
  return new Anthropic({ apiKey: apiKey || process.env.ANTHROPIC_API_KEY });
}

// ── Smart crop ────────────────────────────────────────────────────────────────
//
// Primary path: pure computer-vision using Sharp raw pixel buffers.
//   1. Column density scan → find left/right edges of the white slip
//   2. Row density scan (within those columns) → find top/bottom edges
//   3. Gap scan within row range → detect and discard a previous bill on top
//
// Fallback (re-crop with user feedback only): Claude Sonnet with the
//   user's description as extra context.
//
// Why CV over LLM for the default:
//   - Receipt paper (brightness ≥190) is cleanly separable from wood table
//     (~60-130), hands/skin (~120-165), and metal surfaces (~140-180)
//   - Deterministic, free, ~100ms vs 3-5s per image

async function smartCrop(inputPath, feedback = null, { apiKey } = {}) {
  if (feedback) {
    return smartCropLLM(inputPath, feedback, apiKey);
  }
  return smartCropCV(inputPath);
}

// ── CV approach ───────────────────────────────────────────────────────────────

async function smartCropCV(inputPath) {
  const outputPath = inputPath.replace(/(\.[^.]+)$/, '_cropped.jpg');

  // Full-resolution dimensions (post EXIF rotation)
  const meta = await sharp(inputPath, { failOn: 'none' }).rotate().metadata();
  const W = meta.width  || 1000;
  const H = meta.height || 1000;

  // Analyse at 600px wide — cheap but detailed enough for boundary detection
  const THUMB_W = 600;
  const tw = Math.min(THUMB_W, W);
  const th = Math.round(H * (tw / W));

  const { data } = await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .resize(tw, th, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Tuning constants
  const BRIGHT      = 185;  // Pixels ≥ this are "white paper"
  const COL_MIN     = 0.22; // A column must be ≥22% white to be part of the slip
                            // (small receipts occupying ~25% of frame height pass; metal ~12-15% does not)
  const ROW_MIN     = 0.35; // A row (within slip columns) must be ≥35% white
  const GAP_MAX     = 0.12; // Row density below this is a gap between two bills
  const PAD         = 12;   // Padding in thumbnail pixels (≈20-30px in original)

  // ── Step 1: find left / right edges ──────────────────────────────────────

  const colDensity = new Float32Array(tw);
  for (let x = 0; x < tw; x++) {
    let cnt = 0;
    for (let y = 0; y < th; y++) {
      if (data[y * tw + x] >= BRIGHT) cnt++;
    }
    colDensity[x] = cnt / th;
  }

  let leftX = -1, rightX = -1;
  for (let x = 0; x < tw; x++) {
    if (colDensity[x] >= COL_MIN) { leftX = x; break; }
  }
  for (let x = tw - 1; x >= 0; x--) {
    if (colDensity[x] >= COL_MIN) { rightX = x; break; }
  }

  if (leftX < 0 || rightX <= leftX) {
    // Can't find the slip — just fix EXIF rotation
    await rotateSave(inputPath, outputPath);
    logger.info(`  No receipt region found — rotation only`);
    return outputPath;
  }

  // ── Step 2: find top / bottom edges (within slip columns) ────────────────

  const colSpan = rightX - leftX + 1;
  const rowDensity = new Float32Array(th);
  for (let y = 0; y < th; y++) {
    let cnt = 0;
    for (let x = leftX; x <= rightX; x++) {
      if (data[y * tw + x] >= BRIGHT) cnt++;
    }
    rowDensity[y] = cnt / colSpan;
  }

  let topY = -1, bottomY = -1;
  for (let y = 0; y < th; y++) {
    if (rowDensity[y] >= ROW_MIN) { topY = y; break; }
  }
  for (let y = th - 1; y >= 0; y--) {
    if (rowDensity[y] >= ROW_MIN) { bottomY = y; break; }
  }

  if (topY < 0 || bottomY <= topY) {
    await rotateSave(inputPath, outputPath);
    logger.info(`  Could not bound receipt rows — rotation only`);
    return outputPath;
  }

  // ── Step 3: double-bill detection ────────────────────────────────────────
  // Fuel stations print on a continuous roll. If a previous bill appears
  // above the current one, there will be a "gap" row where density drops
  // below GAP_MAX inside the white region.

  let gapEndY = -1;  // The row where the CURRENT (bottom) bill starts
  let inGap = false;
  let gapStart = -1;

  for (let y = topY + 1; y <= bottomY; y++) {
    if (!inGap && rowDensity[y] < GAP_MAX) {
      inGap = true;
      gapStart = y;
    } else if (inGap && rowDensity[y] >= ROW_MIN) {
      // Gap ended — the current bill starts here
      gapEndY = y;
      inGap = false;
      // Keep scanning in case there's another gap (unlikely, but safe)
    }
  }

  if (gapEndY > 0) {
    logger.info(`  Previous bill detected at rows ${topY}–${gapEndY} — discarding`);
    topY = gapEndY;
  }

  // ── Step 4: convert back to original resolution and crop ─────────────────

  const scale = W / tw; // thumb → original multiplier

  const cropLeft   = Math.max(0, Math.floor((leftX  - PAD) * scale));
  const cropTop    = Math.max(0, Math.floor((topY   - PAD) * scale));
  const cropRight  = Math.max(0, W - Math.ceil((rightX  + PAD) * scale));
  const cropBottom = Math.max(0, H - Math.ceil((bottomY + PAD) * scale));
  const cw = W - cropLeft - cropRight;
  const ch = H - cropTop  - cropBottom;

  if (cw < 80 || ch < 80) {
    await rotateSave(inputPath, outputPath);
    logger.info(`  Crop region too small — rotation only`);
    return outputPath;
  }

  await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .extract({ left: cropLeft, top: cropTop, width: cw, height: ch })
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  const lp = Math.round(cropLeft  / W * 100);
  const tp = Math.round(cropTop   / H * 100);
  const rp = Math.round(cropRight / W * 100);
  const bp = Math.round(cropBottom/ H * 100);
  logger.info(`  CV crop: ${lp}%L ${tp}%T ${rp}%R ${bp}%B → ${path.basename(outputPath)}`);

  return outputPath;
}

// ── LLM approach (used only when user provides feedback) ─────────────────────

async function smartCropLLM(inputPath, feedback, apiKey) {
  const outputPath = inputPath.replace(/(\.[^.]+)$/, '_cropped.jpg');

  const meta = await sharp(inputPath, { failOn: 'none' }).rotate().metadata();
  const W = meta.width  || 1000;
  const H = meta.height || 1000;

  let base64;
  try {
    const buf = await sharp(inputPath, { failOn: 'none' })
      .rotate()
      .resize({ width: 1500, withoutEnlargement: true })
      .jpeg({ quality: 82 })
      .toBuffer();
    base64 = buf.toString('base64');
  } catch {
    await rotateSave(inputPath, outputPath);
    return outputPath;
  }

  let cropJson;
  try {
    const resp = await getClient(apiKey).messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 256,
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
          {
            type: 'text',
            text: `You are a precise image-cropping assistant. This photo contains a narrow thermal paper receipt held in hand.

Find the TIGHT bounding box of the WHITE PAPER SLIP only. Express each edge as the % of the FULL image to discard:
- left  = % to cut from the left before the paper's left edge
- top   = % to cut from the top before the paper's top edge
- right = % to cut from the right after the paper's right edge
- bottom = % to cut from the bottom after the paper's bottom edge

If two receipts are stacked (previous bill above current), discard the top one — keep ONLY the bottom receipt.

Return ONLY JSON. No explanation.
{"crop":true,"left":N,"top":N,"right":N,"bottom":N}  or  {"crop":false}

User feedback: "${feedback}"`
          }
        ]
      }]
    });

    cropJson = JSON.parse(resp.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
  } catch (err) {
    logger.warn(`  LLM crop failed (${err.message}) — rotation only`);
    await rotateSave(inputPath, outputPath);
    return outputPath;
  }

  if (!cropJson?.crop) {
    logger.info(`  LLM: no crop needed`);
    await rotateSave(inputPath, outputPath);
    return outputPath;
  }

  const { left = 0, top = 0, right = 0, bottom = 0 } = cropJson;
  const l = Math.max(0, Math.floor(left   / 100 * W));
  const t = Math.max(0, Math.floor(top    / 100 * H));
  const r = Math.max(0, Math.floor(right  / 100 * W));
  const b = Math.max(0, Math.floor(bottom / 100 * H));
  const cw = W - l - r;
  const ch = H - t - b;

  if (cw < 80 || ch < 80) {
    await rotateSave(inputPath, outputPath);
    return outputPath;
  }

  await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .extract({ left: l, top: t, width: cw, height: ch })
    .jpeg({ quality: 92 })
    .toFile(outputPath);

  logger.info(`  LLM crop: ${left}%L ${top}%T ${right}%R ${bottom}%B → ${path.basename(outputPath)}`);
  return outputPath;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function rotateSave(inputPath, outputPath) {
  await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .jpeg({ quality: 92 })
    .toFile(outputPath);
}

async function prepareAttachment(attachment, opts = {}) {
  logger.info(`Preparing ${attachment.filename}...`);
  const croppedPath = await smartCrop(attachment.path, null, opts);
  return { ...attachment, croppedPath };
}

async function prepareAllAttachments(attachments, opts = {}) {
  const results = [];
  for (const att of attachments) {
    try {
      results.push(await prepareAttachment(att, opts));
    } catch (err) {
      logger.error(`  Failed to prepare ${att.filename}: ${err.message} — using original`);
      results.push({ ...att, croppedPath: att.path });
    }
  }
  return results;
}

module.exports = { prepareAllAttachments, smartCrop };
