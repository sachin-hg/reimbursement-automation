require('dotenv').config();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { startIdleWatcher, fetchMessage, markAsSeen } = require('./imap-watcher');
const { prepareAllAttachments } = require('./image-processor');
const { ocrAllImages, extractFromOCR } = require('./ocr-extractor');
const { extractBillData } = require('./bill-extractor');
const { submitReimbursementClaims } = require('./portal');
const { sendReply } = require('./mailer');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

// Prevent concurrent processing of the same UID
const inFlight = new Set();

// Log key portal submission events to the daemon log
function daemonBroadcast(event, data) {
  if (event === 'submit_progress') {
    if (data.status === 'done')  logger.info(`  ✓ ${data.label}`);
    if (data.status === 'error') logger.error(`  ✗ ${data.label}`);
  }
}

// Ensure every attachment has a unique id — required by ocrAllImages / extractFromOCR
function normalizeAttachments(attachments) {
  return attachments.map((a, i) => ({ id: a.id || `img_${i + 1}`, ...a }));
}

async function processEmail(uid) {
  if (inFlight.has(uid)) return;
  inFlight.add(uid);

  const msgDir = path.join(DOWNLOADS_DIR, String(uid));
  let msgMeta = null;

  try {
    logger.info(`━━━ Processing UID=${uid} ━━━`);

    // Mark as seen immediately — prevents re-trigger on next idle cycle
    await markAsSeen(uid);

    // ── 1. Download attachments ────────────────────────────────────────────
    logger.info('Step 1: Fetching email & attachments...');
    msgMeta = await fetchMessage(uid, msgDir);
    logger.info(`  From: ${msgMeta.from} | Subject: ${msgMeta.subject}`);
    logger.info(`  Attachments: ${msgMeta.attachments.length}`);

    if (msgMeta.attachments.length === 0) {
      throw new Error('No image attachments found in this email');
    }

    // ── 2. Preprocess images ───────────────────────────────────────────────
    logger.info('Step 2: Preprocessing images (smart crop)...');
    const prepared = await prepareAllAttachments(normalizeAttachments(msgMeta.attachments));

    // ── 3. Extract bill data (OCR + Claude batch text call) ────────────────
    // autoMode=true: silently skip low-confidence images rather than sending noise to Claude
    logger.info('Step 3: Extracting bill data (OCR + Claude)...');
    const ocrResults = await ocrAllImages(prepared);
    const { bills, skipped } = await extractFromOCR(ocrResults, prepared, {
      autoMode: true,
      llmFallback: (imagePath) => extractBillData(imagePath),
    });

    if (skipped.length > 0) {
      logger.warn(`  ${skipped.length} image(s) skipped (low OCR confidence): ${skipped.map(s => s.filename).join(', ')}`);
    }
    if (bills.length === 0) {
      throw new Error(`No valid bills extracted (${skipped.length} image(s) skipped for low OCR confidence)`);
    }

    // Ensure imagePath is set for portal upload
    const billsWithPaths = bills
      .map(b => ({ ...b, imagePath: b.imagePath || b.croppedPath }))
      .filter(b => b.imagePath);

    // ── 4. Submit to payroll portal ────────────────────────────────────────
    // No waitForConfirm — daemon auto-proceeds through the confirmation gate
    logger.info(`Step 4: Submitting ${billsWithPaths.length} bill(s) to payroll portal...`);
    const result = await submitReimbursementClaims(billsWithPaths, {
      broadcast: daemonBroadcast,
    });

    if (!result.success) {
      throw new Error(result.error || 'Portal submission failed');
    }

    // ── 5. Send success reply ──────────────────────────────────────────────
    logger.info('Step 5: Sending success reply...');
    const senderEmail = extractEmailAddress(msgMeta.from);
    await sendReply({
      to: senderEmail,
      subject: msgMeta.subject,
      inReplyTo: msgMeta.messageId,
      references: msgMeta.references,
      body: successBody(result.count, result.failed || 0, bills),
    });

    logger.info(`━━━ Done — ${result.count} submitted${result.failed ? `, ${result.failed} failed` : ''} ━━━\n`);

  } catch (err) {
    logger.error(`Processing failed for UID=${uid}: ${err.message}`);

    if (msgMeta) {
      const senderEmail = extractEmailAddress(msgMeta.from);
      await sendReply({
        to: senderEmail,
        subject: msgMeta.subject,
        inReplyTo: msgMeta.messageId,
        references: msgMeta.references,
        body: errorBody(err.message),
      }).catch(e => logger.error(`Could not send error reply: ${e.message}`));
    }

  } finally {
    inFlight.delete(uid);
    fs.rm(msgDir, { recursive: true, force: true }, () => {});
  }
}

// ── Email body builders ────────────────────────────────────────────────────────

function successBody(count, failed, bills) {
  const lines = bills.map((b, i) =>
    `  ${i + 1}. Bill No: ${b.bill_no || 'N/A'} | Date: ${b.bill_date} | Amount: ₹${b.bill_amount}`
  ).join('\n');

  const failNote = failed > 0
    ? `\n⚠️  ${failed} bill(s) could not be submitted — please verify in the portal.\n`
    : '';

  return `Hi Monika,

Your petrol bill reimbursement claim has been submitted successfully!

Bills submitted (${count}):
${lines}
${failNote}
Filed under: Car Running Maintenance Allowance
Status: Submitted for payroll calculation

Regards,
Reimbursement Bot`;
}

function errorBody(errorMessage) {
  return `Hi Monika,

There was a problem processing your petrol bill reimbursement claim.

Error: ${errorMessage}

Please submit manually at:
https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA
Quick Links → Reimbursement Claim → Car Running Maintenance Allowance

Regards,
Reimbursement Bot`;
}

function extractEmailAddress(fromHeader) {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
}

// ── Start ──────────────────────────────────────────────────────────────────────

logger.info('Reimbursement automation starting...');
logger.info(`Watching: "${process.env.IMAP_LABEL_FOLDER}" for emails from ${process.env.SENDER_EMAIL}`);
logger.info('Trigger: IMAP IDLE (real-time, no polling)\n');

startIdleWatcher((uid) => processEmail(uid).catch(err =>
  logger.error(`Unhandled error for UID=${uid}: ${err.message}`)
));
