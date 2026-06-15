/**
 * Full image pipeline test: preprocess → OCR → show extracted bill data.
 * Usage: node scripts/test-extract.js path/to/bill.jpg
 */
require('dotenv').config();
const { prepareAllAttachments } = require('../src/image-processor');
const { extractAllBills } = require('../src/bill-extractor');
const path = require('path');

const inputPath = process.argv[2];
if (!inputPath) {
  console.error('Usage: node scripts/test-extract.js <path-to-bill-image>');
  process.exit(1);
}

const att = {
  filename: path.basename(inputPath),
  path: inputPath,
  mimeType: 'image/jpeg'
};

async function run() {
  console.log(`\nProcessing: ${inputPath}\n`);

  const prepared = await prepareAllAttachments([att]);
  const bills = await extractAllBills(prepared);

  console.log('\n─── Extraction result ───');
  console.log(JSON.stringify(bills, null, 2));
}

run().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
