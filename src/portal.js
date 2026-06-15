require('dotenv').config();
const puppeteer = require('puppeteer');
const path = require('path');
const readline = require('readline');
const logger = require('./logger');

const PORTAL_URL = 'https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA';
const HEADLESS = process.env.HEADLESS !== 'false';

// ─── Main entry ──────────────────────────────────────────────────────────────

async function submitReimbursementClaims(bills) {
  if (bills.length === 0) {
    return { success: false, error: 'No valid bills to submit', count: 0 };
  }

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    defaultViewport: { width: 1440, height: 900 },
  });

  try {
    const page = await browser.newPage();

    page.on('dialog', async (dialog) => {
      logger.warn(`Browser dialog: "${dialog.message()}"`);
      await dialog.accept().catch(() => dialog.dismiss().catch(() => {}));
    });

    // ── Login ──────────────────────────────────────────────────────────────
    logger.info('Navigating to portal...');
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    const username = process.env.PORTAL_USERNAME;
    const password = process.env.PORTAL_PASSWORD;

    if (username) {
      await page.waitForSelector('#ucLogin_txtUserID', { timeout: 15000 });
      await page.$eval('#ucLogin_txtUserID', (el, v) => { el.value = v; }, username);
    } else {
      logger.info('PORTAL_USERNAME not set — please fill in the browser (30s timeout)');
    }

    if (password) {
      await page.$eval('#txtUserPWD', (el, v) => { el.value = v; }, password);
    } else {
      logger.info('PORTAL_PASSWORD not set — please fill in the browser (30s timeout)');
    }

    if (!username || !password) {
      // Give user time to fill credentials manually
      await sleep(30000);
    }

    await page.click('#ucLogin_btnLogin');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    logger.info('Logged in');

    // ── Navigate to Reimbursement Claim ───────────────────────────────────
    logger.info('Finding Reimbursement Claim link...');
    const clicked = await page.evaluate(() => {
      // Try Quick Links first (most prominent), then sidebar
      const allLinks = Array.from(document.querySelectorAll('a, button'));
      for (const el of allLinks) {
        const text = (el.textContent || '').trim();
        const href = el.href || '';
        if (
          (text === 'Reimbursement Claim' || href.includes('RimRequestFV')) &&
          el.offsetParent !== null
        ) {
          el.click();
          return true;
        }
      }
      return false;
    });

    if (!clicked) throw new Error('Could not find "Reimbursement Claim" link');

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => {});
    await sleep(2000);

    // Wait for the Car Running Maintainance Allowance add button
    await page.waitForSelector('#MiddleContent_gvRim_ibAdd_0', { timeout: 20000 });
    logger.info('On reimbursement page');

    // ── Submit each bill ───────────────────────────────────────────────────
    let successCount = 0;

    for (let i = 0; i < bills.length; i++) {
      const bill = bills[i];
      logger.info(`\nSubmitting bill ${i + 1}/${bills.length}: No.${bill.bill_no} | ${bill.bill_date} | ₹${bill.bill_amount}`);

      await submitSingleBill(page, bill);
      successCount++;
      logger.info(`  ✓ Bill ${i + 1} added`);
      await sleep(1500);
    }

    // ── Confirmation checkbox + final submit ───────────────────────────────
    logger.info('\nChecking confirmation checkbox...');
    await page.waitForSelector('#MiddleContent_chkIAgree', { timeout: 10000 });
    const isChecked = await page.$eval('#MiddleContent_chkIAgree', el => el.checked);
    if (!isChecked) {
      await page.click('#MiddleContent_chkIAgree');
      await sleep(500);
    }

    logger.info('Clicking Submit...');
    await page.click('#MiddleContent_btnSubmit');

    // Wait for the UpdatePanel to complete the final submission
    await page.waitForFunction(
      () => {
        // Check for success indicators: page changed, or specific text appeared
        const body = document.body.innerText;
        return body.includes('successfully') || body.includes('Success') ||
               body.includes('submitted') || body.includes('Submitted') ||
               !document.getElementById('MiddleContent_btnSubmit') ||
               !document.getElementById('MiddleContent_chkIAgree');
      },
      { timeout: 30000 }
    ).catch(() => {
      logger.warn('Could not detect submission confirmation — continuing');
    });

    await sleep(3000);
    logger.info(`Reimbursement claim submitted — ${successCount} bill(s) processed`);
    return { success: true, count: successCount };

  } catch (err) {
    logger.error(`Portal automation failed: ${err.message}`);
    return { success: false, error: err.message, count: 0 };
  } finally {
    await browser.close();
  }
}

// ─── Single bill popup flow ───────────────────────────────────────────────────

async function submitSingleBill(page, bill) {
  // Click the "+" (Add) button for Car Running Maintainance Allowance
  await page.click('#MiddleContent_gvRim_ibAdd_0');

  // Wait for popup to appear (Save button becomes visible)
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('MiddleContent_btnSave');
      return btn && btn.offsetParent !== null;
    },
    { timeout: 20000 }
  );
  await sleep(500);

  // Fill Bill No (max 15 chars per the input maxlength)
  const billNo = String(bill.bill_no || 'N/A').slice(0, 15);
  await setInputValue(page, '#MiddleContent_gvRimFields_txtField_Value_0', billNo);

  // Fill Bill Date — portal expects DD/MM/YYYY
  const billDate = normaliseDateFormat(bill.bill_date);
  await setInputValue(page, '#MiddleContent_gvRimFields_calField_Value_1_txtCalendar_1', billDate);

  // Fill Bill Details
  await setInputValue(page, '#MiddleContent_gvRimFields_txtField_Value_2', 'Petrol Bill');

  // Fill Bill Amount (numeric field — fire numeric events)
  await setNumericValue(page, '#MiddleContent_gvRimFields_numField_Value_3', String(bill.bill_amount));

  // Upload supporting image
  const fileInput = await page.$('#MiddleContent_gvRimFields_fuField_Value_4');
  if (fileInput && bill.imagePath) {
    await fileInput.uploadFile(bill.imagePath);
    logger.info(`  Uploaded: ${bill.filename}`);
    await sleep(3000); // Allow upload to complete
  } else {
    logger.warn('  No file input found or no imagePath — skipping upload');
  }

  // Click Save
  await page.click('#MiddleContent_btnSave');

  // Wait for popup to close
  await page.waitForFunction(
    () => {
      const btn = document.getElementById('MiddleContent_btnSave');
      return !btn || btn.offsetParent === null;
    },
    { timeout: 20000 }
  );
  await sleep(1000);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

// Sets value and fires input/change events (works for React/ASP.NET UpdatePanel)
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

// For the numeric field — also fires the custom onchange handler
async function setNumericValue(page, selector, value) {
  await page.waitForSelector(selector, { visible: true, timeout: 10000 });
  await page.click(selector, { clickCount: 3 });
  await page.type(selector, value);
  await page.$eval(selector, el => {
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  });
}

// Normalises a date to DD/MM/YYYY (the format the portal expects)
function normaliseDateFormat(dateStr) {
  if (!dateStr) return '';
  // Already DD/MM/YYYY
  if (/^\d{2}\/\d{2}\/\d{4}$/.test(dateStr)) return dateStr;
  // DD/MM/YY → DD/MM/20YY
  const m = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{2})$/);
  if (m) return `${m[1]}/${m[2]}/20${m[3]}`;
  return dateStr;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { submitReimbursementClaims };
