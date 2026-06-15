# Reimbursement Automation — Setup Guide

Watches Gmail in real-time via IMAP IDLE → downloads bill photos → enhances/crops images → extracts data with Claude Vision → submits to payroll portal via Puppeteer → replies to Monika.

---

## How it works

```
Gmail IMAP IDLE (real-time push — no polling)
  └─ New email: monika.aggarwal1992@gmail.com | "Petrol Bills" | label: Petrol Bill
      └─ Download image attachments
          └─ Smart crop (Claude Haiku detects & removes background)
              └─ Preprocess: grayscale → normalize → sharpen → contrast boost
                  └─ Claude Opus Vision → extract Bill No / Date / Amount
                      └─ Puppeteer → login portal → submit each bill → final submit
                          └─ Reply to Monika via Gmail SMTP
```

### Why IMAP IDLE instead of polling

IMAP IDLE is a standard protocol where Gmail's server **pushes** an EXISTS notification
the instant a new email arrives in the watched folder. The daemon holds one persistent
connection and reacts within ~1 second — no polling loop, no delay, no public webhook URL
required, no Google Cloud setup.

### Why App Password instead of OAuth2

An App Password is a 16-character token Google issues for a specific app. It authenticates
directly over IMAP/SMTP — no OAuth flow, no `client_id`, no refresh tokens, no Google Cloud
Console project. Setup takes 2 minutes.

### On the Gmail MCP connector

The Gmail MCP in Claude Code is an **interactive** tool — it works when you're chatting with
Claude and want Claude to read/send emails on your behalf in that session. It cannot run as a
background service or receive push notifications. For always-on automation, IMAP is the right
layer.

---

## Prerequisites

- Node.js 18+
- An Anthropic API key (console.anthropic.com)
- Gmail with 2-Step Verification enabled

---

## Step 1 — Generate a Gmail App Password

1. Go to **myaccount.google.com → Security → 2-Step Verification** (enable if not already)
2. Scroll to **App passwords** (at the bottom of the 2-Step Verification page)
3. Select app: **Mail** | Select device: **Other** → name it "Reimbursement Bot"
4. Google gives you a 16-character password — copy it (you won't see it again)

That's the whole credential setup. No Google Cloud project, no OAuth consent screen.

---

## Step 2 — Gmail Label Setup

In **your** Gmail (the account that receives the email from Monika):

1. Create a label called exactly: **`Petrol Bill`**
2. Create a filter:
   - From: `monika.aggarwal1992@gmail.com`
   - Subject contains: `Petrol Bills`
   - Action: Apply label **Petrol Bill**

The daemon watches the `Petrol Bill` IMAP folder for unread emails.

---

## Step 3 — Configure .env

```bash
cp .env.example .env
```

Fill in your `.env`:

```env
GMAIL_ADDRESS=your.email@gmail.com
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx    # from Step 1

ANTHROPIC_API_KEY=sk-ant-...

PORTAL_USERNAME=your_employee_id
PORTAL_PASSWORD=your_portal_password

SENDER_EMAIL=monika.aggarwal1992@gmail.com
SUBJECT_FILTER=Petrol Bills
IMAP_LABEL_FOLDER=Petrol Bill

HEADLESS=false    # set to true once portal selectors are confirmed working
```

---

## Step 4 — Verify the IMAP folder name

Gmail labels appear as IMAP folders, but the exact name can vary (e.g. `Petrol Bill` vs
`[Gmail]/Petrol Bill`). Run this to see all your folders:

```bash
npm run list-folders
```

Set `IMAP_LABEL_FOLDER` in `.env` to the exact folder name shown.

---

## Step 5 — Test image preprocessing (optional but recommended)

Point at any crumpled/faded petrol bill photo:

```bash
node scripts/test-preprocess.js ~/Downloads/petrol-bill.jpg
```

It outputs three files in the same directory:
- `*_cropped.jpg` — after smart crop
- `*_ocr.jpg` — high-contrast grayscale for Claude Vision
- `*_upload.jpg` — colour-corrected for portal upload

Open them to verify quality before running the full workflow.

---

## Step 6 — Test full OCR pipeline

```bash
node scripts/test-extract.js ~/Downloads/petrol-bill.jpg
```

Shows extracted JSON: `bill_no`, `bill_date`, `bill_amount`, `valid`.

---

## Step 7 — Test portal login

```bash
# Keep HEADLESS=false in .env so you can see the browser
node scripts/test-portal.js
```

This logs all input element IDs/names it finds on the login page and after login.
If portal selectors don't work, inspect those logs and update the selector arrays in
`src/portal.js`. (See "Adjusting portal selectors" below.)

---

## Step 8 — Run the daemon

```bash
npm start
```

Send a test email from Monika's account (or forward a matching one) to trigger the workflow.
The daemon responds within ~1 second of the email arriving in the `Petrol Bill` folder.

**Run in the background:**

```bash
# Simple nohup
nohup npm start >> logs/automation.log 2>&1 &
echo $! > daemon.pid
kill $(cat daemon.pid)   # to stop

# Better: pm2
npm install -g pm2
pm2 start src/index.js --name reimbursement-bot
pm2 save && pm2 startup  # survive reboots
pm2 logs reimbursement-bot
```

---

## Image processing pipeline

For each bill photo:

1. **Smart crop** (Claude Haiku): detects if there's significant background (table,
   floor, hand, wallet) around the bill and crops it out. Fast and cheap call.

2. **OCR preprocessing** (Sharp):
   - Auto-rotate via EXIF (fixes phone camera orientation)
   - Convert to grayscale (removes colour noise)
   - Normalize histogram (auto-levels faded/underexposed images)
   - Sharpen (crisps up soft/crumpled text edges)
   - Contrast boost (makes faded ink stand out)
   - Upscale if < 1200px wide

3. **Upload preprocessing** (Sharp):
   - Auto-rotate + normalize only — keeps colour, looks natural to HR

Claude Vision sees the OCR-preprocessed version. The portal upload gets the
colour-corrected version.

---

## Bill validation rules

- Amount must be **₹400–₹4000** — outside this range → silently skipped
- If bill_no, bill_date, and bill_amount are ALL null → skipped (unreadable)
- Bills are submitted under **Car Running Maintenance Allowance**

---

## Abort conditions

- A modal/popup visible on the Reimbursement Claim page → abort entire run
- Any Puppeteer error during submission → abort, send failure email to Monika

---

## Adjusting portal selectors

The payroll portal uses ASP.NET WebForms. Input IDs often look like
`ContentPlaceHolder1_txtBillNo`. Run `node scripts/test-portal.js` with `HEADLESS=false`,
open DevTools in the browser window, and find the real IDs.

Key places to update in `src/portal.js`:
- `fillField(page, [...selectors], value)` — login form fields
- `fillSidebarField(page, [...labelHints], value)` — bill sidebar fields
- The `page.evaluate()` block that clicks "Click here to add bills +"

---

## File structure

```
src/
  index.js           # IMAP IDLE daemon + orchestrator
  imap-watcher.js    # IMAP IDLE watching, message download, mark-seen
  mailer.js          # Gmail SMTP reply via nodemailer
  image-processor.js # Smart crop (Claude Haiku) + Sharp preprocessing
  bill-extractor.js  # Claude Opus Vision OCR
  portal.js          # Puppeteer portal automation
  logger.js          # Winston logger

scripts/
  list-imap-folders.js  # Verify label folder name
  test-preprocess.js    # Test image pipeline on a local photo
  test-extract.js       # Test OCR on a local photo
  test-portal.js        # Test portal login and log selectors

downloads/            # Temp storage — auto-deleted after each run
logs/                 # Rotating logs
```
