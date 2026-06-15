require('dotenv').config();
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const SENDER_EMAIL = process.env.SENDER_EMAIL || 'monika.aggarwal1992@gmail.com';
const SUBJECT_FILTER = (process.env.SUBJECT_FILTER || 'Petrol Bills').toLowerCase();
const LABEL_FOLDER = process.env.IMAP_LABEL_FOLDER || 'Petrol Bill';

function makeClient() {
  return new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD
    },
    logger: false
  });
}

// ─── Watcher ──────────────────────────────────────────────────────────────────
//
// Keeps an IMAP IDLE connection open. Gmail pushes an EXISTS notification the
// moment a new email arrives in the label folder — no polling delay.
// When idle() returns (EXISTS or ~29-min IDLE timeout), we search for unread
// matching messages and fire onNewMessage(uid) for each new one, then
// immediately re-enter IDLE.

async function startIdleWatcher(onNewMessage) {
  const firedUids = new Set();

  while (true) {
    const client = makeClient();
    try {
      await client.connect();
      await client.mailboxOpen(LABEL_FOLDER);
      logger.info(`IMAP IDLE active — watching "${LABEL_FOLDER}" for emails from ${SENDER_EMAIL}`);

      // Check once immediately (emails that arrived before we connected)
      await fireMatching(client, firedUids, onNewMessage);

      while (client.usable) {
        // Blocks here until Gmail pushes EXISTS or NOOP (~29 min timeout)
        await client.idle();
        // Re-check after any server notification
        await fireMatching(client, firedUids, onNewMessage);
      }
    } catch (err) {
      logger.error(`IMAP error: ${err.message} — reconnecting in 30 s`);
    } finally {
      await client.logout().catch(() => {});
    }
    await sleep(30_000);
  }
}

async function fireMatching(client, firedUids, onNewMessage) {
  let uids;
  try {
    uids = await client.search({ unseen: true, from: SENDER_EMAIL }, { uid: true });
  } catch {
    return;
  }

  for (const uid of uids) {
    if (firedUids.has(uid)) continue;

    // Fetch envelope to check subject without downloading the whole message
    const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true }).catch(() => null);
    if (!msg?.envelope) continue;

    const subject = (msg.envelope.subject || '').toLowerCase();
    if (!subject.includes(SUBJECT_FILTER)) continue;

    firedUids.add(uid);
    logger.info(`Trigger: UID=${uid} subject="${msg.envelope.subject}"`);
    onNewMessage(uid); // fire-and-forget — index.js processes asynchronously
  }
}

// ─── Message operations (each uses its own short-lived connection) ────────────

// Downloads a message and saves image attachments to downloadDir.
// Returns { messageId, subject, from, attachments: [{filename, path, mimeType}] }
async function fetchMessage(uid, downloadDir) {
  const client = makeClient();
  try {
    await client.connect();
    await client.mailboxOpen(LABEL_FOLDER);

    fs.mkdirSync(downloadDir, { recursive: true });

    const dl = await client.download(String(uid), undefined, { uid: true });
    const parsed = await simpleParser(dl.content);

    const attachments = [];
    for (const att of parsed.attachments || []) {
      if (!att.filename || !att.contentType?.startsWith('image/')) continue;
      const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const filePath = path.join(downloadDir, safeName);
      fs.writeFileSync(filePath, att.content);
      attachments.push({ filename: att.filename, path: filePath, mimeType: att.contentType });
      logger.info(`  Downloaded: ${att.filename} (${att.content.length} bytes)`);
    }

    return {
      messageId: parsed.messageId || '',
      references: Array.isArray(parsed.references)
        ? parsed.references.join(' ')
        : (parsed.references || ''),
      subject: parsed.subject || '',
      from: parsed.from?.text || SENDER_EMAIL,
      attachments
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

async function markAsSeen(uid) {
  const client = makeClient();
  try {
    await client.connect();
    await client.mailboxOpen(LABEL_FOLDER);
    await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
  } finally {
    await client.logout().catch(() => {});
  }
}

// Lists all IMAP folders — useful for verifying the label folder name
async function listFolders() {
  const client = makeClient();
  try {
    await client.connect();
    const list = await client.list();
    return list.map(f => f.path);
  } finally {
    await client.logout().catch(() => {});
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startIdleWatcher, fetchMessage, markAsSeen, listFolders };
