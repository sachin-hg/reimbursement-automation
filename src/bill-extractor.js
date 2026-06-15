require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function extractBillData(imagePath) {
  const ext = path.extname(imagePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const base64 = fs.readFileSync(imagePath).toString('base64');

  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: [
      'You are an expert at reading Indian petrol/fuel bills, even when they are crumpled, faded, or partially obscured.',
      'Extract structured information accurately. If a field is partially visible, make a reasonable inference.',
      'Always return valid JSON only — no markdown, no prose.'
    ].join(' '),
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        {
          type: 'text',
          text: `Extract from this receipt and return ONLY a JSON object:

{
  "bill_no": "<invoice / receipt / bill / slip / transaction number — null if truly not found>",
  "bill_date": "<date as DD/MM/YYYY — null if not found>",
  "bill_amount": <total/base amount in INR as a number — null if not found>,
  "valid": <true if all three fields are non-null AND amount is 400–5000 AND this is NOT clearly from a restaurant/grocery/non-fuel context, else false>,
  "skip_reason": "<brief reason if valid=false, else null>"
}

Extraction tips:
- bill_no: Look for "Invoice No", "INV NO", "INV. NUM", "Bill No", "Receipt No", "Slip No", "TXN ID", "TXN NO", "APPR CODE", "Batch No"
- bill_date: Any date format → DD/MM/YYYY
- bill_amount: Final amount paid — "AMOUNT", "Total", "Rs.", "₹", "INR", "Sale", "Base Amt", "BASE AMT"
- If amount shows paise (decimal), keep up to 2 decimal places
- ACCEPT both petrol station fuel bills AND card payment machine receipts (Pine Labs, Ingenico, etc.) from petrol/fuel stations
- valid=false ONLY if: required fields cannot be extracted, amount outside 400–5000, OR clearly a restaurant/grocery/non-fuel receipt`
        }
      ]
    }]
  });

  const raw = response.content[0].text.trim().replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');

  let parsed;
  try {
    parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)[0]);
  } catch {
    logger.error(`  Failed to parse Claude response: ${raw.slice(0, 150)}`);
    return null;
  }

  if (!parsed.valid) {
    logger.warn(`  Skipping: ${parsed.skip_reason || 'marked invalid'}`);
    return null;
  }

  if (!parsed.bill_amount || parsed.bill_amount < 400 || parsed.bill_amount > 5000) {
    logger.warn(`  Skipping: amount ₹${parsed.bill_amount} outside 400–5000 range`);
    return null;
  }

  logger.info(`  ✓ No: ${parsed.bill_no} | Date: ${parsed.bill_date} | Amount: ₹${parsed.bill_amount}`);
  return parsed;
}

async function extractAllBills(preparedAttachments) {
  const bills = [];

  for (const att of preparedAttachments) {
    logger.info(`Extracting bill data: ${att.filename}`);
    try {
      const data = await extractBillData(att.croppedPath);
      if (data) {
        bills.push({
          ...data,
          imagePath: att.croppedPath,
          filename: att.filename,
        });
      }
    } catch (err) {
      logger.error(`  Error on ${att.filename}: ${err.message}`);
    }
  }

  logger.info(`Valid bills: ${bills.length} / ${preparedAttachments.length}`);
  return bills;
}

module.exports = { extractBillData, extractAllBills };
