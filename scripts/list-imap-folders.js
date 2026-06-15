/**
 * Lists all IMAP folders/labels in your Gmail account.
 * Run this to find the exact IMAP name for your "Petrol Bill" label.
 * Usage: npm run list-folders
 */
require('dotenv').config();
const { listFolders } = require('../src/imap-watcher');

listFolders()
  .then(folders => {
    console.log('\nAvailable IMAP folders/labels:\n');
    folders.forEach(f => console.log(' ', f));
    console.log(`\nSet IMAP_LABEL_FOLDER=<exact name> in your .env\n`);
  })
  .catch(err => {
    console.error('Error:', err.message);
    console.error('Make sure GMAIL_ADDRESS and GMAIL_APP_PASSWORD are set in .env');
    process.exit(1);
  });
