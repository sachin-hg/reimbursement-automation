// One-shot script: assign a single new token to all existing runs that have no userToken.
// Run once, paste the printed token into Settings → Session → Restore saved token.
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const DOWNLOADS_DIR = path.join(__dirname, '..', 'downloads');

if (!fs.existsSync(DOWNLOADS_DIR)) {
  console.log('No downloads directory — nothing to seed.');
  process.exit(0);
}

const token = crypto.randomUUID();
const dirs  = fs.readdirSync(DOWNLOADS_DIR).filter(n => /^run_\d+/.test(n));

let seeded = 0, skipped = 0;
for (const name of dirs) {
  const metaPath = path.join(DOWNLOADS_DIR, name, 'meta.json');
  if (!fs.existsSync(metaPath)) { skipped++; continue; }
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    if (meta.userToken) { skipped++; continue; }
    meta.userToken = token;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    seeded++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}: ${err.message}`);
    skipped++;
  }
}

console.log(`\nSeeded ${seeded} run(s), skipped ${skipped}.\n`);
console.log('Your token:\n');
console.log(`  ${token}\n`);
console.log('Paste this into: Settings ⚙ → Session → Restore saved token → Restore\n');
