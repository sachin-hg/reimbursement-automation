#!/usr/bin/env node
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');
const logger = require('./logger');
const { fetchGmailAttachments } = require('./gmail-browser');
const { prepareAllAttachments } = require('./image-processor');
const { extractAllBills } = require('./bill-extractor');
const { ocrAllImages, extractFromOCR } = require('./ocr-extractor');
const { submitReimbursementClaims } = require('./portal');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

// ── CLI arg parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    email:  process.env.GMAIL_ADDRESS,
    sender: process.env.SENDER_EMAIL || 'monika.aggarwal1992@gmail.com',
    days:   parseInt(process.env.LOOKBACK_DAYS || '2', 10),
    folder: null,
    human:  false,
    mode:   'ocr',   // 'ocr' (default) | 'llm'
  };

  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--email'  || args[i] === '-e') opts.email  = args[++i];
    else if (args[i] === '--sender' || args[i] === '-s') opts.sender = args[++i];
    else if (args[i] === '--days'   || args[i] === '-d') opts.days   = parseInt(args[++i], 10);
    else if (args[i] === '--folder' || args[i] === '-f') opts.folder = args[++i];
    else if (args[i] === '--human'  || args[i] === '-H') opts.human  = true;
    else if (args[i] === '--mode'   || args[i] === '-m') opts.mode   = args[++i];
    else if (args[i] === '--help'   || args[i] === '-h') {
      console.log(`
Usage: node src/cli.js [options]

Options:
  --email,  -e  <addr>      Gmail account to use (default: GMAIL_ADDRESS in .env)
  --sender, -s  <addr>      Who to look for bills from (default: SENDER_EMAIL in .env)
  --days,   -d  <n>         Look back N days in Gmail (default: 2)
  --folder, -f  <path>      Use pre-downloaded images from this folder — skips Gmail
  --mode,   -m  <ocr|llm>   Extraction mode: ocr (default, faster) or llm (vision, accurate)
  --human,  -H              Human-in-the-loop: pause for confirmation after each step
  --help,   -h              Show this help

Examples:
  node src/cli.js --email a.sachin533@gmail.com --days 3
  node src/cli.js --folder ~/Downloads/petrol-bills --human
  node src/cli.js --folder ~/Downloads/petrol-bills --mode llm
`);
      process.exit(0);
    }
  }

  if (!['ocr', 'llm'].includes(opts.mode)) {
    console.error(`Error: --mode must be 'ocr' or 'llm'`);
    process.exit(1);
  }

  if (opts.folder) {
    const resolved = path.resolve(opts.folder);
    if (!fs.existsSync(resolved)) { console.error(`Error: folder not found: ${resolved}`); process.exit(1); }
    if (!fs.statSync(resolved).isDirectory()) { console.error(`Error: not a directory: ${resolved}`); process.exit(1); }
    opts.folder = resolved;
    return opts;
  }

  if (!opts.email)  { console.error('Error: Gmail address required. Pass --email <addr> or set GMAIL_ADDRESS in .env'); process.exit(1); }
  if (!opts.sender) { console.error('Error: Sender email required. Pass --sender <addr> or set SENDER_EMAIL in .env');  process.exit(1); }
  if (isNaN(opts.days) || opts.days < 1) { console.error('Error: --days must be a positive integer'); process.exit(1); }

  return opts;
}

// ── Load images from a local folder ───────────────────────────────────────────

function loadFromFolder(folderPath, runDir) {
  const files = fs.readdirSync(folderPath).filter(name => {
    const ext = path.extname(name).toLowerCase();
    return IMAGE_EXTS.has(ext) && !name.startsWith('.') && !name.includes('_cropped');
  });

  if (files.length === 0) { logger.warn(`No image files found in ${folderPath}`); return []; }
  logger.info(`Found ${files.length} image(s) in folder`);

  return files.map((name, i) => {
    const ext = path.extname(name).toLowerCase();
    // Short safe name — portal enforces ≤49-char filename limit on uploads
    const safeName = `img_${i + 1}${ext}`;
    const src = path.join(folderPath, name);
    const dst = path.join(runDir, safeName);
    fs.copyFileSync(src, dst);
    return { id: `img_${i + 1}`, filename: name, path: dst, mimeType: guessMimeType(name) };
  });
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
  return map[ext] || 'image/jpeg';
}

// Ensure every attachment has a unique id — required by ocrAllImages / extractFromOCR
function normalizeAttachments(attachments) {
  return attachments.map((a, i) => ({ id: a.id || `img_${i + 1}`, ...a }));
}

// ── Terminal broadcast — logs key submission events ────────────────────────────

function cliBroadcast(event, data) {
  if (event === 'submit_progress') {
    if (data.status === 'done')  logger.info(`  ✓ ${data.label}`);
    if (data.status === 'error') logger.error(`  ✗ ${data.label}`);
    // 'active' entries are skipped — terminal doesn't need live spinners
  }
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  const { email: targetEmail, sender: senderEmail, days, folder, human, mode } = parseArgs();

  const runId  = `run_${Date.now()}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  console.log('');
  logger.info('Reimbursement automation — manual trigger');
  if (human) logger.info('  Mode          : human-in-the-loop');
  logger.info(`  Extract mode  : ${mode}`);

  let rawAttachments;

  // ── Step 1: Get images ─────────────────────────────────────────────────────

  if (folder) {
    logger.info(`  Source        : local folder — ${folder}`);
    console.log('');
    logger.info('━━━ Step 1: Loading images from folder ━━━');
    rawAttachments = loadFromFolder(folder, runDir);
  } else {
    logger.info(`  Gmail account : ${targetEmail}`);
    logger.info(`  Looking for   : emails from ${senderEmail}`);
    logger.info(`  Time window   : last ${days} day(s)`);
    console.log('');
    logger.info('━━━ Step 1: Fetching Gmail attachments ━━━');
    rawAttachments = await fetchGmailAttachments({ targetEmail, senderEmail, days, downloadDir: runDir });
  }

  if (rawAttachments.length === 0) {
    logger.warn('No image attachments found. Nothing to process.');
    cleanup(runDir);
    process.exit(0);
  }

  const attachments = normalizeAttachments(rawAttachments);
  logger.info(`Found ${attachments.length} attachment(s):`);
  attachments.forEach((a, i) => logger.info(`  ${i + 1}. ${a.filename}`));

  await confirmStep(human, 'Step 1 complete', `${attachments.length} image(s) ready. Proceed to crop?`);

  // ── Step 2: Smart crop ─────────────────────────────────────────────────────

  console.log('');
  logger.info('━━━ Step 2: Cropping images ━━━');
  const prepared = await prepareAllAttachments(attachments);

  if (human) {
    const openCmd = process.platform === 'linux' ? 'xdg-open' : 'open';
    for (const att of prepared) {
      try { execSync(`${openCmd} "${att.croppedPath}"`, { stdio: 'ignore' }); } catch {}
    }
    logger.info(`Opened ${prepared.length} cropped image(s) for review.`);
  }

  await confirmStep(human, 'Step 2 complete', 'Proceed to extract bill data?');

  // ── Step 3: Extract bill data ──────────────────────────────────────────────

  console.log('');
  let bills, skipped;

  if (mode === 'ocr') {
    logger.info('━━━ Step 3: OCR scan + Claude text extraction ━━━');
    const ocrResults = await ocrAllImages(prepared);
    const extracted  = await extractFromOCR(ocrResults, prepared);
    bills   = extracted.bills;
    skipped = extracted.skipped;
  } else {
    logger.info('━━━ Step 3: LLM Vision extraction ━━━');
    bills   = await extractAllBills(prepared);
    skipped = [];
  }

  console.log('');
  if (bills.length > 0) {
    logger.info(`Extracted ${bills.length} valid bill(s):`);
    bills.forEach((b, i) =>
      logger.info(`  ${i + 1}. No: ${b.bill_no || 'N/A'} | Date: ${b.bill_date} | Amount: ₹${b.bill_amount}`)
    );
  }
  if (skipped.length > 0) {
    logger.warn(`Skipped ${skipped.length} image(s) (low OCR confidence — use --mode llm to force vision):`);
    skipped.forEach((s, i) => logger.warn(`  ${i + 1}. ${s.filename} — ${s.error || 'low confidence'}`));
  }

  if (bills.length === 0) {
    logger.warn('\nNo valid bills to submit.');
    cleanup(runDir);
    process.exit(0);
  }

  // Ensure imagePath is set for portal upload (OCR path has croppedPath; LLM path already has imagePath)
  const billsWithPaths = bills
    .map(b => ({ ...b, imagePath: b.imagePath || b.croppedPath }))
    .filter(b => b.imagePath);

  // Step 3 confirm always shown — last safety gate before money moves
  await confirmStep(true, 'Step 3 complete', `${billsWithPaths.length} bill(s) ready. Proceed with portal submission?`);

  // ── Step 4: Submit to portal ───────────────────────────────────────────────

  console.log('');
  logger.info('━━━ Step 4: Submitting to payroll portal ━━━');

  // Matches the web UI confirmation gate: portal pauses after entering all bills
  // so you can review the browser before the final "I Agree + Submit" click
  const waitForConfirm = () => new Promise(resolve =>
    confirmStep(true, 'Portal review',
      'All bills entered in portal. Review browser window then proceed with final submission?'
    ).then(resolve)
  );

  const result = await submitReimbursementClaims(billsWithPaths, {
    broadcast: cliBroadcast,
    waitForConfirm,
  });

  // ── Persist run record ─────────────────────────────────────────────────────

  const meta = {
    id: runId, runDir,
    source: folder ? 'folder' : 'gmail',
    mode,
    createdAt: new Date().toISOString(),
    status: result.success ? 'done' : 'error',
    attachments: attachments.map(({ id, filename }) => ({ id, filename })),
    bills: billsWithPaths,
    skipped,
    result,
  };
  fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify(meta, null, 2));

  if (result.success) {
    console.log('');
    logger.info(`━━━ Done — ${result.count} bill(s) submitted successfully ━━━`);
    if (result.failed > 0) logger.warn(`  (${result.failed} bill(s) failed — verify in portal)`);
    logger.info(`  Run saved to: ${runDir}`);
  } else {
    console.log('');
    logger.error(`━━━ Portal submission failed: ${result.error || 'unknown error'} ━━━`);
    logger.info('Submit manually at: https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA');
    logger.info('Quick Links → Reimbursement Claim → Car Running Maintenance Allowance');
    closeRL();
    process.exit(1);
  }

  closeRL();
}

// ── Utilities ──────────────────────────────────────────────────────────────────

let _rl = null;
function getRL() {
  if (!_rl) _rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return _rl;
}
function closeRL() {
  if (_rl) { _rl.close(); _rl = null; }
}
function prompt(question) {
  return new Promise(resolve => getRL().question(question, resolve));
}

async function confirmStep(active, label, question) {
  if (!active) return;
  console.log('');
  const answer = await prompt(`[${label}] ${question} [y/N] `);
  if (answer.toLowerCase() !== 'y') {
    logger.info('Aborted by user.');
    closeRL();
    process.exit(0);
  }
  console.log('');
}

function cleanup(dir) {
  fs.rm(dir, { recursive: true, force: true }, () => {});
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
