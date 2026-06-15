require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const logger = require('./logger');
const { resolveConfig } = require('./config');

const PORTAL_URL = 'https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function submitReimbursementClaims(bills, {
  broadcast = () => {},
  signal = null,
  waitIfPaused = null,
  waitForConfirm = null,
  onRetryCtx = null,
  config = {},
} = {}) {
  const cfg = resolveConfig(config);
  if (bills.length === 0) {
    return { success: false, error: 'No valid bills to submit', count: 0 };
  }

  // Use a stable ID per step so the frontend replaces the active entry when done arrives.
  // Per-bill steps include the bill index so each bill gets its own row.
  function progress(step, label, status = 'active', extra = {}) {
    const id = extra.billIndex ? `${step}_${extra.billIndex}` : step;
    broadcast('submit_progress', { id, step, label, status, ...extra });
  }

  async function shot(page, stepKey) {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 42 });
      broadcast('submit_screenshot', { step: stepKey, dataUrl: `data:image/jpeg;base64,${buf.toString('base64')}` });
    } catch (e) {
      logger.warn(`Screenshot skipped: ${e.message}`);
    }
  }

  // Checks kill signal AND waits if paused. Called frequently to honour both promptly.
  async function checkAborted() {
    if (signal?.aborted) throw new Error('Submission cancelled by user');
    if (waitIfPaused) {
      await waitIfPaused();           // resolves immediately if not paused, else blocks
      if (signal?.aborted) throw new Error('Submission cancelled by user');
    }
  }

  // Sleep broken into 150 ms ticks so pause/kill is checked throughout long waits.
  async function abortableSleep(ms) {
    const tick = 150;
    let left = ms;
    while (left > 0) {
      await sleep(Math.min(tick, left));
      left -= tick;
      await checkAborted();
    }
  }

  // ── Launch browser ─────────────────────────────────────────────────────────
  progress('launch', 'Launching browser');
  const browser = await puppeteer.launch({
    headless: cfg.HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1280, height: 800 },
  });
  progress('launch', 'Browser launched', 'done');
  await checkAborted();

  try {
    const page = await browser.newPage();
    page.on('dialog', async (dialog) => {
      logger.warn(`Browser dialog: "${dialog.message()}"`);
      await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
    });

    // ── Load login page ────────────────────────────────────────────────────
    progress('login_nav', 'Loading Mynd Solutions portal');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 45000 });
    await shot(page, 'login_page');
    progress('login_nav', 'Login page loaded', 'done');
    await checkAborted();

    // ── Fill credentials ───────────────────────────────────────────────────
    const username = cfg.PORTAL_USERNAME;
    const password = cfg.PORTAL_PASSWORD;
    progress('login_fill', username ? 'Entering credentials' : 'Waiting for manual credential entry (30s)');

    if (username) {
      await page.waitForSelector('#ucLogin_txtUserID', { timeout: 15000 });
      await page.$eval('#ucLogin_txtUserID', (el, v) => { el.value = v; }, username);
    } else {
      await abortableSleep(30000);
    }
    if (password) {
      await page.$eval('#txtUserPWD', (el, v) => { el.value = v; }, password);
    } else if (username) {
      await abortableSleep(30000);
    }
    progress('login_fill', 'Credentials entered', 'done');
    await checkAborted();

    // ── Submit login ───────────────────────────────────────────────────────
    progress('login_submit', 'Initiating login');
    await page.click('#ucLogin_btnLogin');
    // ASP.NET login may redirect via JS/meta-refresh rather than a standard navigation event;
    // catch the timeout so we don't bail out early, then confirm success by waiting for
    // post-login content to appear.
    await page.waitForNavigation({ waitUntil: 'load', timeout: 30000 }).catch(() => {});
    await page.waitForFunction(() => document.querySelectorAll('a, button').length > 5, { timeout: 30000 });
    await shot(page, 'after_login');
    progress('login_submit', 'Login successful — homepage loaded', 'done');
    await checkAborted();

    // ── Navigate to Reimbursement Claim ────────────────────────────────────
    progress('nav_reimbursement', 'Navigating to Reimbursement Claims');
    const clicked = await page.evaluate(() => {
      const allLinks = Array.from(document.querySelectorAll('a, button'));
      for (const el of allLinks) {
        const text = (el.textContent || '').trim();
        const href = el.href || '';
        if ((text === 'Reimbursement Claim' || href.includes('RimRequestFV')) && el.offsetParent !== null) {
          el.click();
          return true;
        }
      }
      return false;
    });
    if (!clicked) throw new Error('Could not find "Reimbursement Claim" link');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await abortableSleep(2000);
    await page.waitForSelector('#MiddleContent_gvRim_ibAdd_0', { timeout: 20000 });
    await shot(page, 'reimbursement_page');
    progress('nav_reimbursement', 'Reimbursement Claims page loaded', 'done');
    await checkAborted();

    // ── Delete any existing entries from previous runs ─────────────────────
    progress('delete_existing', 'Checking for existing entries to clear');
    let deleted = 0;
    while (true) {
      const deleteBtn = await page.$('[title="Click here to Delete"]');
      if (!deleteBtn) break;
      const countBefore = await page.$$eval('[title="Click here to Delete"]', els => els.length);
      await deleteBtn.click();
      // Wait for UpdatePanel postback to remove the row
      await page.waitForFunction(
        (n) => document.querySelectorAll('[title="Click here to Delete"]').length < n,
        { timeout: 15000 },
        countBefore
      ).catch(() => {});
      await abortableSleep(500);
      deleted++;
      await checkAborted();
    }
    progress(
      'delete_existing',
      deleted > 0 ? `Cleared ${deleted} existing entr${deleted !== 1 ? 'ies' : 'y'}` : 'No existing entries',
      'done'
    );
    await checkAborted();

    // ── Submit each bill ───────────────────────────────────────────────────
    // Inner helper — captured by closure so retry can reuse the same page/helpers.
    async function doOneBill(bill, displayIndex, displayTotal) {
      const billMeta = {
        billIndex: displayIndex, billTotal: displayTotal,
        billFilename: bill.filename,
        billNo: bill.bill_no, billDate: bill.bill_date, billAmount: bill.bill_amount,
      };
      logger.info(`\nSubmitting bill ${displayIndex}/${displayTotal}: No.${bill.bill_no} | ${bill.bill_date} | ₹${bill.bill_amount}`);

      // Open entry popup
      progress('bill_open', `Opening entry form — bill ${displayIndex} of ${displayTotal}`, 'active', billMeta);
      await page.click('#MiddleContent_gvRim_ibAdd_0');
      await page.waitForFunction(
        () => { const btn = document.getElementById('MiddleContent_btnSave'); return btn && btn.offsetParent !== null; },
        { timeout: 20000 }
      );
      await abortableSleep(800);
      progress('bill_open', 'Entry form opened', 'done', billMeta);
      await checkAborted();

      // Fill bill number (text field)
      progress('bill_fill_no', 'Filling bill number', 'active', billMeta);
      const billNo = String(bill.bill_no || 'N/A').slice(0, 15);
      await setInputValue(page, '#MiddleContent_gvRimFields_txtField_Value_0', billNo);
      await abortableSleep(200);
      progress('bill_fill_no', `Bill No: ${billNo}`, 'done', billMeta);
      await checkAborted();

      // Fill date via keyboard (calendar widget)
      progress('bill_fill_date', 'Filling bill date', 'active', billMeta);
      const billDate = normaliseDateFormat(bill.bill_date);
      await fillFieldViaKeyboard(page, '#MiddleContent_gvRimFields_calField_Value_1_txtCalendar_1', billDate);
      await abortableSleep(600);  // wait for any UpdatePanel partial refresh from calendar
      progress('bill_fill_date', `Date: ${billDate}`, 'done', billMeta);
      await checkAborted();

      // Fill description
      await setInputValue(page, '#MiddleContent_gvRimFields_txtField_Value_2', 'Petrol Bill');
      await abortableSleep(200);
      await checkAborted();

      // Fill amount via keyboard (numeric control)
      progress('bill_fill_amt', 'Filling amount', 'active', billMeta);
      await fillFieldViaKeyboard(page, '#MiddleContent_gvRimFields_numField_Value_3', String(bill.bill_amount));
      await abortableSleep(400);
      progress('bill_fill_amt', `Amount: ₹${bill.bill_amount}`, 'done', billMeta);
      await checkAborted();

      // Verify all fields before saving
      const [vBillNo, vBillDate, vAmount] = await Promise.all([
        page.$eval('#MiddleContent_gvRimFields_txtField_Value_0', el => el.value.trim()).catch(() => ''),
        page.$eval('#MiddleContent_gvRimFields_calField_Value_1_txtCalendar_1', el => el.value.trim()).catch(() => ''),
        page.$eval('#MiddleContent_gvRimFields_numField_Value_3', el => el.value.trim()).catch(() => ''),
      ]);
      logger.info(`  Verify — No:"${vBillNo}" Date:"${vBillDate}" Amt:"${vAmount}"`);
      if (!vBillNo || !vBillDate || !vAmount) {
        throw new Error(`Fields not set — No:"${vBillNo}" Date:"${vBillDate}" Amt:"${vAmount}"`);
      }
      await checkAborted();

      // Upload image — ensure filename ≤ 49 chars (portal hard limit)
      progress('bill_upload', `Attaching receipt image`, 'active', billMeta);
      await shot(page, `bill_form_${displayIndex}`);
      const fileInput = await page.$('#MiddleContent_gvRimFields_fuField_Value_4');
      if (fileInput && bill.imagePath) {
        let uploadPath = bill.imagePath;
        const basename = path.basename(uploadPath);
        if (basename.length > 49) {
          // Safety fallback: copy to a short temp name so the portal accepts it.
          // Primary fix is server-side rename at ingest (img_N.ext). This handles legacy runs.
          const ext = path.extname(basename);
          const safePath = path.join(os.tmpdir(), `bill_${displayIndex}${ext}`);
          fs.copyFileSync(uploadPath, safePath);
          uploadPath = safePath;
          logger.warn(`  Filename too long (${basename.length}), using ${path.basename(safePath)}`);
        }
        try {
          await fileInput.uploadFile(uploadPath);
        } finally {
          if (uploadPath !== bill.imagePath) fs.unlink(uploadPath, () => {});
        }
        logger.info(`  Uploaded: ${bill.filename}`);
        await abortableSleep(3000);
        progress('bill_upload', `Image attached: ${bill.filename}`, 'done', billMeta);
      } else {
        logger.warn('  No file input or no imagePath — skipping upload');
        progress('bill_upload', 'Image attachment skipped', 'done', billMeta);
      }
      await checkAborted();

      // Save
      progress('bill_save', 'Saving entry', 'active', billMeta);
      await page.click('#MiddleContent_btnSave');
      await page.waitForFunction(
        () => { const btn = document.getElementById('MiddleContent_btnSave'); return !btn || btn.offsetParent === null; },
        { timeout: 20000 }
      );
      await abortableSleep(1000);
      await shot(page, `bill_saved_${displayIndex}`);
      progress('bill_save', `Bill ${displayIndex} of ${displayTotal} saved`, 'done', billMeta);
      logger.info(`  ✓ Bill ${displayIndex} saved`);
      await abortableSleep(1500);
    }

    const failedBills = [];
    let successCount = 0;

    for (let i = 0; i < bills.length; i++) {
      await checkAborted();
      const bill = bills[i];
      try {
        await doOneBill(bill, i + 1, bills.length);
        successCount++;
      } catch (billErr) {
        if (billErr.message.includes('cancelled')) throw billErr;  // propagate kill
        logger.error(`  ✗ Bill ${i + 1} failed: ${billErr.message}`);
        const billMeta = {
          billIndex: i + 1, billTotal: bills.length,
          billFilename: bill.filename, billNo: bill.bill_no, billDate: bill.bill_date, billAmount: bill.bill_amount,
        };
        progress('bill_error', `Bill ${i + 1} failed: ${billErr.message}`, 'error', billMeta);
        failedBills.push({ ...bill, _origIndex: i + 1 });
        // Close popup if still open, continue with next bill
        try {
          const saveBtn = await page.$('#MiddleContent_btnSave');
          const visible = saveBtn && await page.evaluate(el => el.offsetParent !== null, saveBtn);
          if (visible) {
            const cancelBtn = await page.$('#MiddleContent_btnCancel');
            if (cancelBtn) await cancelBtn.click();
            else await page.keyboard.press('Escape');
            await abortableSleep(1000);
          }
        } catch {}
      }
    }

    // ── User confirmation gate ─────────────────────────────────────────────
    await checkAborted();
    // Build per-run retry context and hand it to the caller (server stores it keyed by runId).
    const retryCtx = { page, doOneBill, progress, broadcast, checkAborted, successCount, failedBills, totalBills: bills.length };
    if (onRetryCtx) onRetryCtx(retryCtx);
    progress('user_confirm', `${successCount} of ${bills.length} bills uploaded — waiting for your review`);
    broadcast('submit_awaiting_confirm', { successCount, failCount: failedBills.length, total: bills.length, failedBills });
    if (waitForConfirm) await waitForConfirm();
    progress('user_confirm', 'Confirmed — proceeding with final submit', 'done');
    await checkAborted();

    // ── I Agree + final submit ─────────────────────────────────────────────
    progress('final_confirm', 'Checking "I Agree" confirmation checkbox');
    await page.waitForSelector('#MiddleContent_chkIAgree', { timeout: 10000 });
    const isChecked = await page.$eval('#MiddleContent_chkIAgree', el => el.checked);
    if (!isChecked) { await page.click('#MiddleContent_chkIAgree'); await abortableSleep(500); }
    progress('final_confirm', 'Confirmation checked', 'done');
    await checkAborted();

    progress('final_submit', `Submitting claim for ${successCount} bill${successCount !== 1 ? 's' : ''}`);
    await shot(page, 'pre_submit');
    await page.click('#MiddleContent_btnSubmit');

    // Wait for the ASP.NET UpdatePanel network round-trip to complete before inspecting the page.
    // DOM-absence checks (!btnSubmit, !chkIAgree) fire during the postback itself — before the
    // server processes the submission — causing premature browser close. Use network idle instead.
    await page.waitForNetworkIdle({ timeout: 35000, idleTime: 1500 })
      .catch(() => logger.warn('Network idle timeout after submit click — portal may be slow'));

    // Extra buffer for page render after network response
    await abortableSleep(4000);
    await shot(page, 'submitted');

    const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
    if (!/successfully|success/i.test(bodyText)) {
      logger.warn('Submit: could not detect success text after network idle — check portal manually');
    }
    const finalFailCount = retryCtx.failedBills.length;
    const finalSuccessCount = retryCtx.successCount;
    const finalMsg = finalFailCount > 0
      ? `${finalSuccessCount} submitted, ${finalFailCount} failed`
      : `${finalSuccessCount} bill${finalSuccessCount !== 1 ? 's' : ''} submitted successfully!`;
    progress('final_submit', finalMsg, finalFailCount > 0 ? 'error' : 'done');
    logger.info(`Reimbursement claim done — ${finalSuccessCount} ok, ${finalFailCount} failed`);
    return { success: finalFailCount === 0, count: finalSuccessCount, failed: finalFailCount };

  } catch (err) {
    logger.error(`Portal automation failed: ${err.message}`);
    progress('error', err.message, 'error');
    return { success: false, error: err.message, count: 0 };
  } finally {
    await browser.close();
  }
}

// ─── Retry failed bills ───────────────────────────────────────────────────────

async function retryFailedBills(billsToRetry, retryCtx) {
  if (!retryCtx) throw new Error('No active submission to retry — confirm gate has passed or submission not running');
  const { page, doOneBill, progress, broadcast, checkAborted, totalBills } = retryCtx;
  const stillFailed = [];

  for (let i = 0; i < billsToRetry.length; i++) {
    const bill = billsToRetry[i];
    const displayIndex = bill._origIndex || (i + 1);
    const billMeta = {
      billIndex: displayIndex, billTotal: totalBills,
      billFilename: bill.filename,
      billNo: bill.bill_no, billDate: bill.bill_date, billAmount: bill.bill_amount,
    };
    // Replace the error entry with a retrying indicator
    progress('bill_error', `Retrying bill ${displayIndex}…`, 'active', billMeta);
    await checkAborted().catch(() => {});
    try {
      await doOneBill(bill, displayIndex, totalBills);
      retryCtx.successCount++;
      progress('bill_error', `Bill ${displayIndex} retry succeeded`, 'done', billMeta);
    } catch (err) {
      if (err.message?.includes('cancelled')) throw err;
      logger.error(`  ✗ Bill ${displayIndex} retry failed: ${err.message}`);
      stillFailed.push({ ...bill, _error: err.message });
      progress('bill_error', `Retry failed: ${err.message}`, 'error', billMeta);
      // Close popup if still open
      try {
        const saveBtn = await page.$('#MiddleContent_btnSave');
        const visible = saveBtn && await page.evaluate(el => el.offsetParent !== null, saveBtn);
        if (visible) {
          const cancelBtn = await page.$('#MiddleContent_btnCancel');
          if (cancelBtn) await cancelBtn.click();
          else await page.keyboard.press('Escape');
          await new Promise(r => setTimeout(r, 1000));
        }
      } catch {}
    }
  }

  retryCtx.failedBills = stillFailed;
  progress('user_confirm', `${retryCtx.successCount} of ${totalBills} bills uploaded — waiting for your review`);
  broadcast('submit_awaiting_confirm', {
    successCount: retryCtx.successCount,
    failCount: stillFailed.length,
    total: totalBills,
    failedBills: stillFailed,
  });
}

// ─── Field helpers ────────────────────────────────────────────────────────────

async function setInputValue(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.$eval(selector, (el, v) => {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value');
    if (nativeSetter) nativeSetter.set.call(el, v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// For calendar text inputs and numeric fields — uses real keyboard events so the
// ASP.NET control actually registers the value. Clears existing content first.
async function fillFieldViaKeyboard(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector);
  await sleep(100);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  await sleep(100);
  // Belt-and-suspenders JS clear in case Ctrl+A didn't select
  const residue = await page.$eval(selector, el => el.value).catch(() => '');
  if (residue) {
    await page.$eval(selector, el => { el.value = ''; });
    await sleep(50);
  }
  await page.type(selector, value, { delay: 30 });
  await sleep(100);
  await page.$eval(selector, el => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

function normaliseDateFormat(dateStr) {
  if (!dateStr) return '';
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}/20${m[3]}`;
  return dateStr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { submitReimbursementClaims, retryFailedBills };
