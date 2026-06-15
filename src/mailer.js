require('dotenv').config();
const nodemailer = require('nodemailer');
const logger = require('./logger');

function createTransport() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_ADDRESS,
      pass: process.env.GMAIL_APP_PASSWORD
    }
  });
}

// Sends a reply email that threads into the original conversation.
async function sendReply({ to, subject, inReplyTo, references, body }) {
  const transporter = createTransport();
  const refsChain = `${references || ''} ${inReplyTo || ''}`.trim();

  await transporter.sendMail({
    from: process.env.GMAIL_ADDRESS,
    to,
    subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`,
    text: body,
    headers: {
      'In-Reply-To': inReplyTo,
      References: refsChain
    }
  });

  logger.info(`Reply sent → ${to}`);
}

module.exports = { sendReply };
