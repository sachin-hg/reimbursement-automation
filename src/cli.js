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
const { submitReimbursementClaims } = require('./portal');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

// ── CLI arg parsing ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    email: process.env.GMAIL_ADDRESS,
    sender: process.env.SENDER_EMAIL || 'monika.aggarwal1992@gmail.com',
    days: parseInt(process.env.LOOKBACK_DAYS || '2', 10),
    folder: null,
    human: false,
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--email'  || args[i] === '-e') opts.email  = args[++i];
    else if (args[i] === '--sender' || args[i] === '-s') opts.sender = args[++i];
    else if (args[i] === '--days'   || args[i] === '-d') opts.days   = parseInt(args[++i], 10);
    else if (args[i] === '--folder' || args[i] === '-f') opts.folder = args[++i];
    else if (args[i] === '--human'  || args[i] === '-H') opts.human = true;
    else if (args[i] === '--help'   || args[i] === '-h') {
      console.log(`
Usage: node src/cli.js [options]

Options:
  --email,  -e  <addr>    Gmail account to use (default: GMAIL_ADDRESS in .env)
  --sender, -s  <addr>    Who to look for bills from (default: SENDER_EMAIL in .env)
  --days,   -d  <n>       Look back N days in Gmail (default: 2)
  --folder, -f  <path>    Use pre-downloaded images from this folder — skips Gmail entirely
  --human,  -H            Human-in-the-loop: pause for confirmation after each step
  --help,   -h            Show this help

Examples:
  node src/cli.js --email a.sachin533@gmail.com --days 3
  node src/cli.js --folder ~/Downloads/petrol-bills --human
`);
      process.exit(0);
    }
  }

  // Validate folder mode
  if (opts.folder) {
    const resolved = path.resolve(opts.folder);
    if (!fs.existsSync(resolved)) {
      console.error(`Error: folder not found: ${resolved}`);
      process.exit(1);
    }
    if (!fs.statSync(resolved).isDirectory()) {
      console.error(`Error: not a directory: ${resolved}`);
      process.exit(1);
    }
    opts.folder = resolved;
    return opts; // email/sender/days not required in folder mode
  }

  // Validate Gmail mode
  if (!opts.email) {
    console.error('Error: Gmail address required. Pass --email <addr> or set GMAIL_ADDRESS in .env');
    process.exit(1);
  }
  if (!opts.sender) {
    console.error('Error: Sender email required. Pass --sender <addr> or set SENDER_EMAIL in .env');
    process.exit(1);
  }
  if (isNaN(opts.days) || opts.days < 1) {
    console.error('Error: --days must be a positive integer');
    process.exit(1);
  }

  return opts;
}

// ── Load images from a local folder ──────────────────────────────────────────

function loadFromFolder(folderPath, runDir) {
  const files = fs.readdirSync(folderPath).filter(name => {
    const ext = path.extname(name).toLowerCase();
    // Skip hidden files, and any file that looks like a previous processing output
    return IMAGE_EXTS.has(ext) && !name.startsWith('.') && !name.includes('_cropped');
  });

  if (files.length === 0) {
    logger.warn(`No image files found in ${folderPath}`);
    return [];
  }

  logger.info(`Found ${files.length} image(s) in folder`);

  // Copy to runDir so that _cropped.jpg outputs land there, not in the source folder
  return files.map(name => {
    const src = path.join(folderPath, name);
    const dst = path.join(runDir, name);
    fs.copyFileSync(src, dst);
    return { filename: name, path: dst, mimeType: guessMimeType(name) };
  });
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
  return map[ext] || 'image/jpeg';
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { email: targetEmail, sender: senderEmail, days, folder, human } = parseArgs();

  const runDir = path.join(DOWNLOADS_DIR, `run_${Date.now()}`);
  fs.mkdirSync(runDir, { recursive: true });

  console.log('');
  logger.info('Reimbursement automation — manual trigger');
  if (human) logger.info('  Mode          : human-in-the-loop (confirming each step)');

  let attachments;

  // ── Step 1: Get images ────────────────────────────────────────────────────

  if (folder) {
    logger.info(`  Mode          : local folder`);
    logger.info(`  Folder        : ${folder}`);
    console.log('');
    logger.info('━━━ Step 1: Loading images from folder ━━━');
    attachments = loadFromFolder(folder, runDir);
  } else {
    logger.info(`  Gmail account : ${targetEmail}`);
    logger.info(`  Looking for   : emails from ${senderEmail}`);
    logger.info(`  Time window   : last ${days} day(s)`);
    console.log('');
    logger.info('━━━ Step 1: Fetching Gmail attachments ━━━');
    attachments = await fetchGmailAttachments({ targetEmail, senderEmail, days, downloadDir: runDir });
  }

  if (attachments.length === 0) {
    logger.warn('No image attachments found. Nothing to process.');
    cleanup(runDir);
    process.exit(0);
  }

  logger.info(`Found ${attachments.length} attachment(s):`);
  attachments.forEach((a, i) => logger.info(`  ${i + 1}. ${a.filename}`));

  await confirmStep(human, 'Step 1 complete', `${attachments.length} image(s) ready. Proceed to crop?`);

  // ── Step 2: Smart crop + display ──────────────────────────────────────────
  console.log('');
  logger.info('━━━ Step 2: Cropping images ━━━');
  const prepared = await prepareAllAttachments(attachments);

  const openCmd = process.platform === 'linux' ? 'xdg-open' : 'open';
  for (const att of prepared) {
    // stdio:'ignore' prevents child processes from inheriting our stdin and closing it
    try { execSync(`${openCmd} "${att.croppedPath}"`, { stdio: 'ignore' }); } catch {}
  }
  logger.info(`Opened ${prepared.length} cropped image(s) for review.`);

  await confirmStep(human, 'Step 2 complete', 'Cropped images opened above. Proceed to extract bill data?');

  // ── Step 3: Extract bill data ─────────────────────────────────────────────
  console.log('');
  logger.info('━━━ Step 3: Extracting bill data ━━━');
  const bills = await extractAllBills(prepared);

  if (bills.length === 0) {
    logger.warn('\nNo valid bills extracted. Check the images and try again.');
    cleanup(runDir);
    process.exit(0);
  }

  console.log('');
  logger.info(`Extracted ${bills.length} valid bill(s):`);
  bills.forEach((b, i) => {
    logger.info(`  ${i + 1}. No: ${b.bill_no || 'N/A'} | Date: ${b.bill_date} | Amount: ₹${b.bill_amount}`);
  });

  // Step 3 confirmation always shown (HIL or not) — this is the last safety gate before money moves
  await confirmStep(true, 'Step 3 complete', 'Proceed with portal submission?');

  // ── Step 4: Submit to portal ──────────────────────────────────────────────
  console.log('');
  logger.info('━━━ Step 4: Submitting to payroll portal ━━━');
  const result = await submitReimbursementClaims(bills);

  if (result.success) {
    console.log('');
    logger.info(`━━━ Done — ${result.count} bill(s) submitted successfully ━━━`);
  } else {
    console.log('');
    logger.error(`━━━ Portal submission failed: ${result.error} ━━━`);
    logger.info('Submit manually at: https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA');
    logger.info('Quick Links → Reimbursement Claim → Car Running Maintenance Allowance');
    closeRL();
    cleanup(runDir);
    process.exit(1);
  }

  closeRL();
  cleanup(runDir);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Single readline instance — creating/closing multiple rl instances on the
// same process.stdin destroys stdin for subsequent reads.
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

// Pauses for user confirmation when active (always active when force=true).
// Exits the process on anything other than 'y'.
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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

main().catch(err => {
  logger.error(`Fatal: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
});
