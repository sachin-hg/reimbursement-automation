#!/usr/bin/env node
require('dotenv').config();
const crypto = require('crypto');
const os = require('os');
const path = require('path');
const fs = require('fs');
const readline = require('readline');
const { execSync } = require('child_process');
const logger = require('./logger');
const { resolveConfig } = require('./config');
const { fetchGmailAttachments } = require('./gmail-browser');
const { prepareAllAttachments } = require('./image-processor');
const { extractAllBills } = require('./bill-extractor');
const { ocrAllImages, extractFromOCR } = require('./ocr-extractor');
const { extractBillData } = require('./bill-extractor');
const { submitReimbursementClaims } = require('./portal');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.heic', '.heif']);

// ── Session token ─────────────────────────────────────────────────────────────
// Stored in ~/.reimbursement-automation-token so CLI runs are associated with
// the same user across sessions. Use --token to override or restore a saved token.
const TOKEN_FILE = path.join(os.homedir(), '.reimbursement-automation-token');

function getCliToken(explicit) {
  if (explicit) {
    try { fs.writeFileSync(TOKEN_FILE, explicit.trim(), 'utf8'); } catch {}
    return explicit.trim();
  }
  try {
    const saved = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
    if (saved) return saved;
  } catch {}
  const token = crypto.randomUUID();
  try { fs.writeFileSync(TOKEN_FILE, token, 'utf8'); } catch {}
  return token;
}

// ── CLI arg parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    // Source
    email:  null,
    sender: null,
    days:   null,
    folder: null,
    // Behaviour
    human:  false,
    mode:   'ocr',
    // Config overrides (all optional — fall back to .env)
    apiKey:     null,
    username:   null,
    password:   null,
    headless:   null,  // null = use .env; true/false = explicit override
    gmailLabel: null,
    token:      null,  // session token — defaults to ~/.reimbursement-automation-token
  };

  for (let i = 0; i < args.length; i++) {
    if      (args[i] === '--email'       || args[i] === '-e') opts.email      = args[++i];
    else if (args[i] === '--sender'      || args[i] === '-s') opts.sender     = args[++i];
    else if (args[i] === '--days'        || args[i] === '-d') opts.days       = parseInt(args[++i], 10);
    else if (args[i] === '--folder'      || args[i] === '-f') opts.folder     = args[++i];
    else if (args[i] === '--human'       || args[i] === '-H') opts.human      = true;
    else if (args[i] === '--mode'        || args[i] === '-m') opts.mode       = args[++i];
    else if (args[i] === '--api-key'     || args[i] === '-k') opts.apiKey     = args[++i];
    else if (args[i] === '--username'    || args[i] === '-u') opts.username   = args[++i];
    else if (args[i] === '--password'    || args[i] === '-p') opts.password   = args[++i];
    else if (args[i] === '--headless')                        opts.headless   = true;
    else if (args[i] === '--no-headless')                     opts.headless   = false;
    else if (args[i] === '--gmail-label' || args[i] === '-l') opts.gmailLabel = args[++i];
    else if (args[i] === '--token'       || args[i] === '-t') opts.token      = args[++i];
    else if (args[i] === '--help'        || args[i] === '-h') {
      console.log(`
Usage: node src/cli.js [options]

Source:
  --folder, -f  <path>      Load images from this folder — skips Gmail
  --email,  -e  <addr>      Gmail account to fetch from (default: GMAIL_ADDRESS in .env)
  --sender, -s  <addr>      Filter emails by sender (default: SENDER_EMAIL in .env)
  --days,   -d  <n>         Look back N days in Gmail (default: LOOKBACK_DAYS in .env, or 2)

Behaviour:
  --mode,   -m  <ocr|llm>   Extraction mode: ocr (default, faster) or llm (vision, accurate)
  --human,  -H              Pause for confirmation after each step

Config overrides (all fall back to .env if not provided):
  --api-key,     -k  <key>    Anthropic API key
  --username,    -u  <id>     Portal username / employee ID
  --password,    -p  <pwd>    Portal password
  --headless / --no-headless  Run browser headless (default: HEADLESS in .env, or false)
  --gmail-label, -l  <lbl>    Gmail label to search (default: GMAIL_LABEL in .env, or "Petrol Bill")
  --token,       -t  <uuid>   Session token (default: ~/.reimbursement-automation-token)
                              Use to associate CLI runs with a specific browser session, or
                              to restore access to runs created with a different token.

  --help,   -h                Show this help

Examples:
  node src/cli.js --folder ~/Downloads/petrol-bills
  node src/cli.js --folder ~/Downloads/petrol-bills --human --mode llm
  node src/cli.js --email you@gmail.com --days 3
  node src/cli.js --email you@gmail.com --username emp123 --password secret --api-key sk-ant-...
  node src/cli.js --folder ~/bills --headless
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

  // Gmail mode — resolve email/sender from opts or env
  const email  = opts.email  || process.env.GMAIL_ADDRESS;
  const sender = opts.sender || process.env.SENDER_EMAIL;
  if (!email)  { console.error('Error: Gmail address required. Pass --email <addr> or set GMAIL_ADDRESS in .env'); process.exit(1); }
  if (!sender) { console.error('Error: Sender email required. Pass --sender <addr> or set SENDER_EMAIL in .env');  process.exit(1); }
  opts.email  = email;
  opts.sender = sender;
  if (opts.days === null) opts.days = parseInt(process.env.LOOKBACK_DAYS || '2', 10);
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
  const { email: targetEmail, sender: senderEmail, days, folder, human, mode,
          apiKey, username, password, headless, gmailLabel, token: tokenArg } = parseArgs();

  // Build CLI config overrides — only non-null values override .env
  const cliOverrides = {};
  if (apiKey   != null) cliOverrides.ANTHROPIC_API_KEY = apiKey;
  if (username != null) cliOverrides.PORTAL_USERNAME   = username;
  if (password != null) cliOverrides.PORTAL_PASSWORD   = password;
  if (headless != null) cliOverrides.HEADLESS           = headless;
  if (gmailLabel != null) cliOverrides.GMAIL_LABEL      = gmailLabel;
  const cfg = resolveConfig(cliOverrides);

  // Resolve session token — associates this CLI run with a browser session.
  const token = getCliToken(tokenArg);

  const runId  = `run_${Date.now()}`;
  const runDir = path.join(DOWNLOADS_DIR, runId);
  fs.mkdirSync(runDir, { recursive: true });

  console.log('');
  logger.info('Reimbursement automation — manual trigger');
  if (human) logger.info('  Mode          : human-in-the-loop');
  logger.info(`  Extract mode  : ${mode}`);
  logger.info(`  Session token : ${token.slice(0, 8)}… (${TOKEN_FILE})`);

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
    rawAttachments = await fetchGmailAttachments({ targetEmail, senderEmail, days, downloadDir: runDir, gmailLabel: cfg.GMAIL_LABEL });
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
  const prepared = await prepareAllAttachments(attachments, { apiKey: cfg.ANTHROPIC_API_KEY });

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
    // In autonomous mode (no --human): low-confidence images fall back to LLM vision automatically.
    // In human mode: they're included in the batch for human review (user can re-extract per-card).
    const extracted  = await extractFromOCR(ocrResults, prepared, {
      apiKey: cfg.ANTHROPIC_API_KEY,
      llmFallback: human ? null : (imagePath) => extractBillData(imagePath, { apiKey: cfg.ANTHROPIC_API_KEY }),
    });
    bills   = extracted.bills;
    skipped = extracted.skipped;
  } else {
    logger.info('━━━ Step 3: LLM Vision extraction ━━━');
    bills   = await extractAllBills(prepared, { apiKey: cfg.ANTHROPIC_API_KEY });
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

  await confirmStep(human, 'Step 3 complete', `${billsWithPaths.length} bill(s) ready. Proceed with portal submission?`);

  // ── Step 4: Submit to portal ───────────────────────────────────────────────

  console.log('');
  logger.info('━━━ Step 4: Submitting to payroll portal ━━━');

  // In human mode: pause after all bills are entered so user can review the browser window.
  // In autonomous mode: proceed immediately.
  const waitForConfirm = human ? () => new Promise(resolve =>
    confirmStep(true, 'Portal review',
      'All bills entered in portal. Review browser window then proceed with final submission?'
    ).then(resolve)
  ) : null;

  const result = await submitReimbursementClaims(billsWithPaths, {
    broadcast: cliBroadcast,
    waitForConfirm,
    config: cliOverrides,
  });

  // ── Persist run record ─────────────────────────────────────────────────────

  const meta = {
    id: runId, runDir,
    userToken: token,
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
