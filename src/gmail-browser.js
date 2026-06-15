require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const logger = require('./logger');

const BROWSER_PROFILE_DIR = path.join(__dirname, '..', '.browser-profile');

async function fetchGmailAttachments({ targetEmail, senderEmail, days, downloadDir }) {
  fs.mkdirSync(BROWSER_PROFILE_DIR, { recursive: true });
  fs.mkdirSync(downloadDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: BROWSER_PROFILE_DIR,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'],
    defaultViewport: null,
  });

  try {
    const page = await browser.newPage();

    // ── 1. Navigate to Gmail ─────────────────────────────────────────────────
    logger.info('Opening Gmail...');
    await page.goto('https://mail.google.com', { waitUntil: 'domcontentloaded', timeout: 60000 });

    if (page.url().includes('accounts.google.com')) {
      logger.info('Not logged in — please sign in to Google in the browser window (120s timeout)...');
      await page.waitForFunction(
        () => window.location.hostname === 'mail.google.com',
        { timeout: 120000 }
      );
    }

    await sleep(4000);

    // ── 2. Find the right account index ─────────────────────────────────────
    const accountIndex = await findAccountIndex(page, targetEmail);
    if (accountIndex === -1) {
      throw new Error(
        `Account ${targetEmail} is not signed in to this browser. ` +
        `Please add it via the Google Account Switcher and re-run.`
      );
    }
    logger.info(`Using Gmail account index ${accountIndex} for ${targetEmail}`);

    // ── 3. Search for emails ─────────────────────────────────────────────────
    // No "has:attachment" filter — emails may contain Drive links instead of attachments
    const label = (process.env.GMAIL_LABEL || 'Petrol Bill').replace(/ /g, '-');
    const query = `from:${senderEmail} label:${label} newer_than:${days}d`;
    const searchUrl = `https://mail.google.com/mail/u/${accountIndex}/#search/${encodeURIComponent(query)}`;

    logger.info(`Searching: ${query}`);
    await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(2000);

    await page.waitForFunction(
      () => document.querySelector('[role="main"] tr, [role="main"] [data-thread-id]') !== null ||
            document.body.innerText.includes('No results found') ||
            document.body.innerText.includes('No matching conversations'),
      { timeout: 15000 }
    ).catch(() => {});

    // ── 4. Count threads ──────────────────────────────────────────────────────
    const threadCount = await page.evaluate(() =>
      document.querySelectorAll('[role="main"] tr[jscontroller], [role="main"] tr.zA').length
    );

    if (threadCount === 0) {
      logger.warn(`No emails found matching: ${query}`);
      return [];
    }

    logger.info(`Found ${threadCount} thread(s)`);

    // ── 5. Process each thread ────────────────────────────────────────────────
    const downloadedFiles = [];

    for (let i = 0; i < threadCount; i++) {
      await page.goto(searchUrl, { waitUntil: 'networkidle2', timeout: 30000 });
      await sleep(1500);

      const rows = await page.$$('[role="main"] tr[jscontroller], [role="main"] tr.zA');
      if (!rows[i]) continue;

      await rows[i].click();
      await sleep(2500);

      logger.info(`  Thread ${i + 1}/${threadCount}:`);

      // ── 5a. Try direct image attachments ──────────────────────────────────
      const attachmentUrls = await page.evaluate(() => {
        const seen = new Set();
        const links = [];

        document.querySelectorAll('a[href*="view=att"], a[href*="disp=attd"]').forEach(a => {
          const href = a.href;
          if (href && !seen.has(href)) {
            seen.add(href);
            const card = a.closest('[data-legacy-attachment-id], [jscontroller]');
            const nameEl = card?.querySelector('[data-tooltip], [aria-label], span[title]');
            const name = nameEl?.textContent?.trim() || nameEl?.title || nameEl?.getAttribute('aria-label') || '';
            links.push({ href, name });
          }
        });

        if (links.length === 0) {
          document.querySelectorAll('[data-legacy-attachment-id]').forEach(card => {
            const dl = card.querySelector('a[download], a[href*="mail-attachment"]');
            if (dl && !seen.has(dl.href)) {
              seen.add(dl.href);
              const name = card.querySelector('[title]')?.title || 'attachment';
              links.push({ href: dl.href, name });
            }
          });
        }

        return links;
      });

      const imageAttachments = attachmentUrls.filter(({ href, name }) => {
        const lower = (name + ' ' + href).toLowerCase();
        return /\.(jpe?g|png|gif|webp|bmp|heic)/.test(lower) ||
               lower.includes('image') || lower.includes('photo');
      });

      if (imageAttachments.length > 0) {
        logger.info(`    ${imageAttachments.length} direct image attachment(s)`);
        for (let j = 0; j < imageAttachments.length; j++) {
          const { href, name } = imageAttachments[j];
          const safeName = sanitizeFilename(name || `attachment_${i}_${j}`, `${i}_${j}`);
          const filePath = path.join(downloadDir, safeName);
          try {
            const bytes = await page.evaluate(async (url) => {
              const res = await fetch(url, { credentials: 'include' });
              if (!res.ok) throw new Error(`HTTP ${res.status}`);
              return Array.from(new Uint8Array(await res.arrayBuffer()));
            }, href);
            fs.writeFileSync(filePath, Buffer.from(bytes));
            logger.info(`    Saved: ${safeName} (${Math.round(fs.statSync(filePath).size / 1024)}KB)`);
            downloadedFiles.push({ filename: safeName, path: filePath, mimeType: guessMimeType(safeName) });
          } catch (err) {
            logger.warn(`    Failed to download ${name}: ${err.message}`);
          }
        }
      }

      // ── 5b. Look for Google Drive links in the email body ─────────────────
      const driveLinks = await page.evaluate(() => {
        const links = [];
        document.querySelectorAll('a[href*="drive.google.com"], a[href*="docs.google.com"]').forEach(a => {
          if (a.href) links.push(a.href);
        });
        return links;
      });

      const driveFileIds = extractDriveFileIds(driveLinks);

      if (driveFileIds.length > 0) {
        logger.info(`    ${driveFileIds.length} Google Drive file link(s) found`);
        const driveFiles = await downloadDriveFiles(browser, driveFileIds, downloadDir, i);
        downloadedFiles.push(...driveFiles);
      }

      if (imageAttachments.length === 0 && driveFileIds.length === 0) {
        logger.info(`    No image attachments or Drive links — skipping`);
      }
    }

    return downloadedFiles;
  } finally {
    await browser.close();
  }
}

// ── Google Drive download ─────────────────────────────────────────────────────

function extractDriveFileIds(hrefs) {
  const ids = [];
  for (const href of hrefs) {
    // https://drive.google.com/file/d/FILE_ID/view?...
    let m = href.match(/drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (m) { ids.push(m[1]); continue; }
    // https://drive.google.com/open?id=FILE_ID or ?id=FILE_ID
    m = href.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) { ids.push(m[1]); continue; }
    // https://docs.google.com/uc?export=download&id=FILE_ID (already a download link)
    m = href.match(/docs\.google\.com\/uc.*[?&]id=([a-zA-Z0-9_-]+)/);
    if (m) { ids.push(m[1]); }
  }
  return [...new Set(ids)];
}

async function downloadDriveFiles(browser, fileIds, downloadDir, threadIndex) {
  const drivePage = await browser.newPage();
  const files = [];

  try {
    // Navigate to drive.google.com so fetch() has same-origin session cookies
    await drivePage.goto('https://drive.google.com', { waitUntil: 'domcontentloaded', timeout: 15000 });
    await sleep(1500);

    for (let i = 0; i < fileIds.length; i++) {
      const fileId = fileIds[i];
      // ?confirm=t bypasses the "too large to scan" warning for small files
      const downloadUrl = `https://drive.google.com/uc?export=download&id=${fileId}&confirm=t`;

      try {
        const result = await drivePage.evaluate(async (url) => {
          const res = await fetch(url, { credentials: 'include', redirect: 'follow' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const contentType = res.headers.get('content-type') || 'image/jpeg';
          const disposition = res.headers.get('content-disposition') || '';
          // Extract filename from Content-Disposition: attachment; filename="IMG_1234.jpg"
          const fnMatch = disposition.match(/filename[^;=\n]*=(?:(['"])([^'"]*)\1|([^;\n]*))/i);
          const filename = fnMatch ? (fnMatch[2] || fnMatch[3] || '').trim() : '';
          const buf = await res.arrayBuffer();
          return { bytes: Array.from(new Uint8Array(buf)), contentType, filename };
        }, downloadUrl);

        // Determine file extension from content-type or filename
        let ext = '.jpg';
        if (result.filename) {
          const m = result.filename.match(/\.[a-z0-9]+$/i);
          if (m) ext = m[0].toLowerCase();
        } else if (result.contentType.includes('png')) {
          ext = '.png';
        } else if (result.contentType.includes('webp')) {
          ext = '.webp';
        }

        const safeName = result.filename
          ? sanitizeFilename(result.filename, `drive_${threadIndex}_${i}`)
          : `drive_${threadIndex}_${i + 1}${ext}`;
        const filePath = path.join(downloadDir, safeName);

        fs.writeFileSync(filePath, Buffer.from(result.bytes));
        logger.info(`    Saved Drive file: ${safeName} (${Math.round(fs.statSync(filePath).size / 1024)}KB)`);
        files.push({ filename: safeName, path: filePath, mimeType: result.contentType || 'image/jpeg' });
      } catch (err) {
        logger.warn(`    Failed to download Drive file ${fileId}: ${err.message}`);
        // Fallback: open the Drive file page and let user download manually
        logger.info(`    Opening Drive file page for manual download...`);
        await drivePage.goto(`https://drive.google.com/file/d/${fileId}/view`, {
          waitUntil: 'domcontentloaded', timeout: 10000
        }).catch(() => {});
        await sleep(3000);
      }
    }
  } finally {
    await drivePage.close();
  }

  return files;
}

// ── Account helpers ───────────────────────────────────────────────────────────

async function findAccountIndex(page, targetEmail) {
  for (let i = 0; i < 6; i++) {
    try {
      await page.goto(`https://mail.google.com/mail/u/${i}/`, {
        waitUntil: 'domcontentloaded',
        timeout: 10000,
      });
      if (!page.url().includes('mail.google.com/mail/u/')) break;
      await sleep(2000);
      const email = await getCurrentEmail(page);
      if (email && email.toLowerCase() === targetEmail.toLowerCase()) {
        return i;
      }
    } catch {
      break;
    }
  }
  return -1;
}

async function getCurrentEmail(page) {
  return page.evaluate(() => {
    const candidates = [
      () => document.querySelector('[data-email]')?.dataset?.email,
      () => {
        for (const el of document.querySelectorAll('[aria-label]')) {
          const m = el.getAttribute('aria-label').match(/[\w.+-]+@[\w.-]+\.\w+/);
          if (m) return m[0];
        }
      },
      () => {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const m = node.textContent.trim().match(/^[\w.+-]+@[\w.-]+\.\w+$/);
          if (m) return m[0];
        }
      },
    ];
    for (const fn of candidates) {
      try { const r = fn(); if (r) return r; } catch {}
    }
    return null;
  });
}

// ── Filename / mime helpers ───────────────────────────────────────────────────

function sanitizeFilename(name, fallbackId) {
  const clean = name.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  if (!/\.(jpe?g|png|gif|webp|bmp|heic)$/i.test(clean)) {
    return `img_${fallbackId}_${clean}.jpg`;
  }
  return clean || `img_${fallbackId}.jpg`;
}

function guessMimeType(filename) {
  const ext = path.extname(filename).toLowerCase();
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
                '.gif': 'image/gif', '.webp': 'image/webp', '.heic': 'image/heic' };
  return map[ext] || 'image/jpeg';
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

module.exports = { fetchGmailAttachments };
