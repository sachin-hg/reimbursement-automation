# Petrol Bill Reimbursement Automation

Automates monthly petrol bill reimbursement claims against the Mynd Solutions payroll portal (`mypayroll2.myndsolution.com`). Three ways to run it:

| Mode | Best for | What it does |
|---|---|---|
| **Web UI** | Day-to-day use | Full visual workflow — load images, review crops, fix extracted data, submit with live portal view |
| **CLI** | Power users / scripting | Same pipeline in the terminal with `--human` review gates |
| **IMAP Daemon** | Fully automated | Watches Gmail in real-time, runs end-to-end on new email, sends a reply when done |

---

## How it works

```
Images (folder / Gmail)
  └─ Smart crop — CV pixel-density scan detects receipt boundary
      └─ OCR scan — Tesseract parallel scan, confidence score per image
          └─ Claude text extraction — batch call with all OCR text
             (low-confidence images fall back to Claude Vision)
              └─ Human review — edit bill_no / date / amount, remove/include
                  └─ Puppeteer — login portal → enter each bill → attach image
                      └─ Confirmation gate — review portal entries before final submit
                          └─ I Agree checkbox + Submit → done
```

---

## Prerequisites

- Node.js 18+
- `npm install` (root) + `cd web && npm install`
- Tesseract OCR — macOS: `brew install tesseract`; Ubuntu: `apt install tesseract-ocr`
- A `.env` file — see configuration section below

---

## Configuration — `.env`

Copy the block below to `.env` in the project root and fill in your values.

```dotenv
# ── Gmail (required for Gmail mode and IMAP daemon) ───────────────────────────
# Your Gmail address — the account that owns the inbox
GMAIL_ADDRESS=you@gmail.com

# ── Email filters (Gmail + IMAP daemon) ───────────────────────────────────────
# Who sends the petrol bill images
SENDER_EMAIL=sender@example.com

# Gmail label applied to petrol bill emails
# Web UI Gmail mode and CLI --email mode: used to build the search query
GMAIL_LABEL=Petrol Bill

# How many days back to search for emails (CLI --email mode default)
LOOKBACK_DAYS=2

# ── IMAP daemon only ──────────────────────────────────────────────────────────
# Gmail App Password (16 chars, no spaces) — NOT your Google account password.
# Generate at: myaccount.google.com → Security → App passwords
# Requires 2-Step Verification to be enabled on the account.
GMAIL_APP_PASSWORD=xxxx xxxx xxxx xxxx

# The IMAP folder name that matches your Gmail label exactly
# (Gmail labels appear as IMAP folders; check with: node -e "require('./src/imap-watcher').listFolders()")
IMAP_LABEL_FOLDER=Petrol Bill

# ── Anthropic / Claude ────────────────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-api03-...

# ── Payroll portal credentials ────────────────────────────────────────────────
# If set, the browser fills login fields automatically.
# If left blank, the browser window opens and you fill them manually.
PORTAL_USERNAME=your_employee_id
PORTAL_PASSWORD=your_portal_password

# ── Browser visibility ────────────────────────────────────────────────────────
# false = show the browser window (recommended — lets you see what's happening)
# true  = headless mode (no window, faster; use only once you trust the automation)
HEADLESS=false
```

### Which variables are required for each mode

| Variable | Web UI | CLI `--folder` | CLI `--email` | IMAP daemon |
|---|:---:|:---:|:---:|:---:|
| `ANTHROPIC_API_KEY` | ✓ | ✓ | ✓ | ✓ |
| `PORTAL_USERNAME` / `PORTAL_PASSWORD` | ✓ | ✓ | ✓ | ✓ |
| `GMAIL_ADDRESS` | — | — | ✓ | ✓ |
| `GMAIL_LABEL` | — | — | ✓ | — |
| `SENDER_EMAIL` | — | — | ✓ | ✓ |
| `LOOKBACK_DAYS` | — | — | optional | — |
| `GMAIL_APP_PASSWORD` | — | — | — | ✓ |
| `IMAP_LABEL_FOLDER` | — | — | — | ✓ |

---

## Web UI

The recommended way. A local server + React frontend with live progress, crop review, bill editing, and a real-time browser view during portal submission.

### Start

```bash
# Terminal 1 — API server (port 3333)
npm run server

# Terminal 2 — Vite dev server with hot reload (port 5173)
npm run web:dev

# Or both in one terminal:
npm run dev

# Open: http://localhost:5173
```

For production (serves built assets from the API server):

```bash
npm run web:build
npm run server
# Open: http://localhost:3333
```

### Workflow

1. **Load** — paste a folder path or drag-and-drop images, or fetch from Gmail
2. **Crop** — auto-crop runs; review each image, use AI feedback or draw a manual crop if needed
3. **Extract** — OCR scans + Claude extracts bill number, date, amount; edit any field inline; remove/include images; re-extract with LLM if OCR quality is poor
4. **Submit** — live browser view shows portal automation; review entries before final confirm; retry any failed bills without restarting

### Recent runs

The homepage shows all previous runs. Click **Continue** to resume a run — edits, crops, and extracted data are all restored. Runs are stored under `downloads/run_<timestamp>/`.

---

## CLI

Runs the same pipeline in your terminal.

### Syntax

```
node src/cli.js [options]
```

### Options

**Source**

| Flag | Short | Default | Description |
|---|---|---|---|
| `--folder <path>` | `-f` | — | Load images from a local folder instead of Gmail |
| `--email <addr>` | `-e` | `GMAIL_ADDRESS` in `.env` | Gmail account to fetch bills from |
| `--sender <addr>` | `-s` | `SENDER_EMAIL` in `.env` | Filter emails by sender address |
| `--days <n>` | `-d` | `LOOKBACK_DAYS` (default 2) | Look back N days in Gmail |

**Behaviour**

| Flag | Short | Default | Description |
|---|---|---|---|
| `--mode <ocr\|llm>` | `-m` | `ocr` | Extraction mode: `ocr` (Tesseract + Claude text, faster) or `llm` (Claude Vision, more accurate on low-quality scans) |
| `--human` | `-H` | off | Pause for `[y/N]` confirmation after each step |
| `--help` | `-h` | — | Show help |

**Config overrides** (all fall back to `.env` if not provided)

| Flag | Short | Default | Description |
|---|---|---|---|
| `--api-key <key>` | `-k` | `ANTHROPIC_API_KEY` | Anthropic API key |
| `--username <id>` | `-u` | `PORTAL_USERNAME` | Portal username / employee ID |
| `--password <pwd>` | `-p` | `PORTAL_PASSWORD` | Portal password |
| `--headless` / `--no-headless` | — | `HEADLESS` | Run browser headless or visible |
| `--gmail-label <label>` | `-l` | `GMAIL_LABEL` | Gmail label to search |

### Examples

```bash
# Load from a local folder — simplest usage
node src/cli.js --folder ~/Downloads/petrol-bills

# Same, but pause for review after each step and open cropped images
node src/cli.js --folder ~/Downloads/petrol-bills --human

# Force LLM Vision extraction (slower but handles blurry/low-contrast scans better)
node src/cli.js --folder ~/Downloads/petrol-bills --mode llm

# Fetch from Gmail — last 2 days (uses GMAIL_ADDRESS and SENDER_EMAIL from .env)
node src/cli.js

# Fetch from Gmail — explicit email and sender
node src/cli.js --email you@gmail.com --sender sender@example.com

# Fetch from Gmail — look back 5 days, pause for human review
node src/cli.js --email you@gmail.com --days 5 --human

# Fetch from Gmail — LLM mode, full human review
node src/cli.js --email you@gmail.com --mode llm --human

# Override credentials entirely (no .env needed)
node src/cli.js --folder ~/bills --api-key sk-ant-... --username emp123 --password secret

# Run headless (no visible browser window)
node src/cli.js --folder ~/bills --headless

# Use a different Gmail label
node src/cli.js --email you@gmail.com --gmail-label "Fuel Bills"
```

### What `--human` does

- After loading images: shows count, asks to proceed to crop
- After cropping: opens each cropped image, asks to proceed to extract
- After extraction: prints all extracted bills, always asks before submitting (even without `--human`)
- Before final portal submit: pauses after all bills are entered so you can review the browser window

### Output

Each run is saved to `downloads/run_<timestamp>/` with a `meta.json` file. Runs are visible in the Web UI under **Recent Runs**.

---

## Gmail mode — one-time browser setup

The CLI `--email` mode opens a real Chrome window to log into Gmail. It stores the session in `.browser-profile/` so you only log in once.

```bash
# First run — Chrome opens, log in manually, then the script proceeds
node src/cli.js --email you@gmail.com --sender sender@example.com

# Subsequent runs — session is reused, no login needed
node src/cli.js
```

The `.browser-profile/` directory persists your Google session. If it expires, delete it and log in again:

```bash
rm -rf .browser-profile
```

**Required `.env` for Gmail CLI mode:**

```dotenv
GMAIL_ADDRESS=you@gmail.com
SENDER_EMAIL=sender@example.com
GMAIL_LABEL=Petrol Bill
```

---

## IMAP Daemon (fully automated)

Watches your Gmail label folder in real-time via IMAP IDLE. When a new email arrives from the configured sender, it automatically: crops → OCR extracts → submits to portal → replies to sender with a summary.

### Setup

**1. Enable 2-Step Verification** on the Gmail account at [myaccount.google.com](https://myaccount.google.com).

**2. Generate an App Password:**
- Go to myaccount.google.com → Security → App passwords
- Select "Mail" + any device name, click Generate
- Copy the 16-character password (shown once, spaces don't matter)

**3. Find your IMAP label folder name:**

Gmail labels become IMAP folders, but the exact name can differ from what the UI shows.

```bash
node -e "require('./src/imap-watcher').listFolders()"
```

This prints all IMAP folders — find the one matching your label and use that exact string as `IMAP_LABEL_FOLDER`.

**4. Configure `.env`:**

```dotenv
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=abcd efgh ijkl mnop
IMAP_LABEL_FOLDER=Petrol Bill
SENDER_EMAIL=sender@example.com
ANTHROPIC_API_KEY=sk-ant-...
PORTAL_USERNAME=your_employee_id
PORTAL_PASSWORD=your_portal_password
HEADLESS=true
```

**5. Start the daemon:**

```bash
node src/index.js
```

Output:

```
Reimbursement automation starting...
Watching: "Petrol Bill" for emails from sender@example.com
Trigger: IMAP IDLE (real-time, no polling)
```

The daemon reconnects automatically if the connection drops. To keep it running persistently:

```bash
npm install -g pm2
pm2 start src/index.js --name reimbursement-daemon
pm2 save
```

### How the daemon handles failures

- **Low OCR confidence images**: skipped silently — not sent to Claude with bad text
- **Portal submission failure**: sends an error reply email to the original sender with the error message and the manual submission URL
- **Network/IMAP disconnect**: reconnects after 30 seconds automatically

---

## Extraction modes

| Mode | Flag | How it works | Best for |
|---|---|---|---|
| `ocr` (default) | `--mode ocr` | Tesseract scans all images in parallel → Claude processes all text in one batch call | Clear photos, good lighting, standard receipts |
| `llm` | `--mode llm` | Claude Vision reads each image directly (one API call per image) | Blurry, dark, or skewed scans where OCR fails |

In the **Web UI**, toggle between modes using the **Extract via: OCR / LLM Vision** switch before clicking Extract. You can also re-extract individual bills with LLM Vision from the bill card.

---

## Project structure

```
.
├── src/
│   ├── server.js          # Express API server (Web UI backend, port 3333)
│   ├── cli.js             # CLI pipeline (manual trigger)
│   ├── index.js           # IMAP daemon (automated trigger)
│   ├── portal.js          # Puppeteer portal automation
│   ├── image-processor.js # Smart crop (Claude Haiku + sharp)
│   ├── bill-extractor.js  # Claude Vision extraction (LLM mode)
│   ├── ocr-extractor.js   # Tesseract OCR + Claude text extraction (OCR mode)
│   ├── gmail-browser.js   # Puppeteer Gmail scraper (CLI --email mode)
│   ├── imap-watcher.js    # IMAP IDLE connection (daemon)
│   ├── mailer.js          # SMTP reply sender (daemon)
│   └── logger.js          # Winston logger
├── web/                   # React + Vite frontend
│   └── src/
│       ├── App.jsx        # Main app shell, phase state machine
│       ├── api.js         # Fetch wrappers for all API endpoints
│       └── components/    # StepBar, Step1–4 panels, BillCard, RunList, …
├── downloads/             # Persistent run storage (one dir per run)
│   └── run_<timestamp>/
│       ├── meta.json      # Full run state — bills, crops, results
│       └── img_*.jpg      # Cropped receipt images
├── .browser-profile/      # Persistent Chrome session for Gmail CLI mode
└── .env                   # Your configuration (never commit this)
```

---

## Troubleshooting

**Portal says "Fields not set" for a bill**
The date field didn't register. Use the **Retry Failed Bills** button in the confirmation gate (Web UI) or re-run from Step 3 with the correct date format (`DD/MM/YYYY`).

**Extraction shows wrong amount**
Edit the amount field directly in Step 3 (Web UI) or check the OCR confidence badge. Low-confidence images (below ~60%) are flagged — click **Re-extract with LLM** on the card for better accuracy.

**Extracting spinner doesn't disappear**
SSE connection dropped mid-extraction. Refresh the page — the server restores run state from `meta.json` and shows the correct completed state.

**Gmail CLI mode opens wrong account**
Delete `.browser-profile/` and re-run — Chrome will prompt you to log in again.

**IMAP daemon: can't find label folder**
Run `node -e "require('./src/imap-watcher').listFolders()"` and match the exact folder path. Gmail often nests labels differently from what the UI shows.
