/**
 * Test portal login and navigation only (no bill submission).
 * Usage: node scripts/test-portal.js
 *
 * Set HEADLESS=false in .env to see the browser.
 */
require('dotenv').config();
const puppeteer = require('puppeteer');
const logger = require('../src/logger');

const PORTAL_URL = 'https://mypayroll2.myndsolution.com/Login.aspx?cid=REAINDIA';
const HEADLESS = process.env.HEADLESS !== 'false';

async function testLogin() {
  logger.info('Launching browser in test mode...');
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1440, height: 900 }
  });

  try {
    const page = await browser.newPage();
    await page.goto(PORTAL_URL, { waitUntil: 'networkidle2', timeout: 45000 });

    logger.info(`Page title: ${await page.title()}`);
    logger.info('Page URL: ' + page.url());

    // Log all input elements on the login page
    const inputs = await page.evaluate(() =>
      Array.from(document.querySelectorAll('input')).map(i => ({
        id: i.id, name: i.name, type: i.type, placeholder: i.placeholder
      }))
    );
    logger.info('Login page inputs: ' + JSON.stringify(inputs, null, 2));

    // Attempt login
    for (const sel of ['#txtUserName', 'input[name*="UserName"]', 'input[type="text"]']) {
      const el = await page.$(sel);
      if (el) {
        await el.type(process.env.PORTAL_USERNAME);
        logger.info(`Filled username using: ${sel}`);
        break;
      }
    }

    for (const sel of ['#txtPassword', 'input[name*="Password"]', 'input[type="password"]']) {
      const el = await page.$(sel);
      if (el) {
        await el.type(process.env.PORTAL_PASSWORD);
        logger.info(`Filled password using: ${sel}`);
        break;
      }
    }

    for (const sel of ['#btnLogin', 'input[type="submit"]', 'button[type="submit"]']) {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        logger.info(`Clicked login using: ${sel}`);
        break;
      }
    }

    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
    logger.info('Post-login URL: ' + page.url());
    logger.info('Post-login title: ' + await page.title());

    // Look for Reimbursement Claim link
    const links = await page.evaluate(() =>
      Array.from(document.querySelectorAll('a')).map(a => ({ text: a.textContent.trim(), href: a.href }))
    );
    const reimbLink = links.find(l => l.text.toLowerCase().includes('reimbursement'));
    logger.info('Reimbursement link found: ' + JSON.stringify(reimbLink || 'NOT FOUND'));

    logger.info('\nTest complete. Check logs above for selector info.');
    if (!HEADLESS) {
      logger.info('Browser left open — close it manually when done inspecting.');
      await new Promise(resolve => setTimeout(resolve, 60000));
    }

  } finally {
    await browser.close();
  }
}

testLogin().catch(err => {
  logger.error('Test failed: ' + err.message);
  process.exit(1);
});
