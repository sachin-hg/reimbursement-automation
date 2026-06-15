/**
 * Test smart crop on a local bill photo.
 * Usage: node scripts/test-preprocess.js path/to/bill.jpg
 */
require('dotenv').config();
const path = require('path');
const { execSync } = require('child_process');
const { smartCrop } = require('../src/image-processor');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/test-preprocess.js <path-to-bill-image>');
  process.exit(1);
}

async function run() {
  console.log(`\nInput: ${inputPath}`);
  console.log('Running smart crop...');
  const croppedPath = await smartCrop(inputPath);
  console.log(`Cropped: ${croppedPath}`);

  const openCmd = process.platform === 'linux' ? 'xdg-open' : 'open';
  try { execSync(`${openCmd} "${croppedPath}"`); } catch {}
  console.log('Done.\n');
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
