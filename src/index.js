require('dotenv').config();
const path = require('path');
const fs = require('fs');
const logger = require('./logger');
const { startIdleWatcher, fetchMessage, markAsSeen } = require('./imap-watcher');
const { prepareAllAttachments } = require('./image-processor');
const { extractAllBills } = require('./bill-extractor');
const { submitReimbursementClaims } = require('./portal');
const { sendReply } = require('./mailer');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

// Prevent concurrent processing of the same UID
const inFlight = new Set();

async function processEmail(uid) {
  if (inFlight.has(uid)) return;
  inFlight.add(uid);

  const msgDir = path.join(DOWNLOADS_DIR, String(uid));
  let msgMeta = null;

  try {
    logger.info(`━━━ Processing UID=${uid} ━━━`);

    // Mark as seen immediately — prevents re-trigger on next idle cycle
    await markAsSeen(uid);

    // ── 1. Download attachments ──────────────────────────────────────────────
    logger.info('Step 1: Fetching email & attachments...');
    msgMeta = await fetchMessage(uid, msgDir);
    logger.info(`  From: ${msgMeta.from} | Subject: ${msgMeta.subject}`);
    logger.info(`  Attachments: ${msgMeta.attachments.length}`);

    if (msgMeta.attachments.length === 0) {
      throw new Error('No image attachments found in this email');
    }

    // ── 2. Preprocess images ─────────────────────────────────────────────────
    logger.info('Step 2: Preprocessing images (crop + enhance)...');
    const prepared = await prepareAllAttachments(msgMeta.attachments);

    // ── 3. Extract bill data via Claude Vision ───────────────────────────────
    logger.info('Step 3: Extracting bill data with Claude Vision...');
    const bills = await extractAllBills(prepared);

    if (bills.length === 0) {
      throw new Error('No valid bills found — all were unreadable or outside ₹400–₹4000 range');
    }

    // ── 4. Submit to payroll portal via Puppeteer ────────────────────────────
    logger.info(`Step 4: Submitting ${bills.length} bill(s) to payroll portal...`);
    const result = await submitReimbursementClaims(bills);

    if (!result.success) {
      throw new Error(result.error || 'Portal submission failed');
    }

    // ── 5. Send success reply ────────────────────────────────────────────────
    logger.info('Step 5: Sending success reply...');
    const senderEmail = extractEmailAddress(msgMeta.from);
    await sendReply({
      to: senderEmail,
      subject: msgMeta.subject,
      inReplyTo: msgMeta.messageId,
      references: msgMeta.references,
      body: successBody(result.count, bills)
    });

    logger.info(`━━━ Done — ${result.count} bill(s) submitted ━━━\n`);

  } catch (err) {
    logger.error(`Processing failed for UID=${uid}: ${err.message}`);

    if (msgMeta) {
      const senderEmail = extractEmailAddress(msgMeta.from);
      await sendReply({
        to: senderEmail,
        subject: msgMeta.subject,
        inReplyTo: msgMeta.messageId,
        references: msgMeta.references,
        body: errorBody(err.message)
      }).catch(e => logger.error(`Could not send error reply: ${e.message}`));
    }

  } finally {
    inFlight.delete(uid);
    // Clean up downloaded + processed images
    fs.rm(msgDir, { recursive: true, force: true }, () => {});
  }
}

// ── Email body builders ───────────────────────────────────────────────────────

function successBody(count, bills) {
  const lines = bills.map((b, i) =>
    `  ${i + 1}. Bill No: ${b.bill_no || 'N/A'} | Date: ${b.bill_date} | Amount: ₹${b.bill_amount}`
  ).join('\n');

  return `Hi Monika,

Your petrol bill reimbursement claim has been submitted successfully!

Bills submitted (${count}):
${lines}

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

// ── Start ─────────────────────────────────────────────────────────────────────

logger.info('Reimbursement automation starting...');
logger.info(`Watching: "${process.env.IMAP_LABEL_FOLDER}" for emails from ${process.env.SENDER_EMAIL}`);
logger.info('Trigger: IMAP IDLE (real-time, no polling)\n');

startIdleWatcher((uid) => processEmail(uid).catch(err =>
  logger.error(`Unhandled error for UID=${uid}: ${err.message}`)
));
