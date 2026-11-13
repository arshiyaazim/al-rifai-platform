#!/usr/bin/env node
// AL-RIFA'I — Escort Release slip backfill / audit (DRY RUN).
//
// The release review page derives slips from the messages themselves, so there
// is no separate slip table to backfill. This script reports what the parser
// sees across the whole release group, what is already applied, and how the
// cash cross-check behaves — the evidence an operator needs before any bulk
// decision.
//
// Usage:
//   node --experimental-strip-types scripts/backfill-release-slips.ts
//   node --experimental-strip-types scripts/backfill-release-slips.ts --apply
//
// `--apply` is intentionally a no-op: it prints why and exits without writing.

import {loadEnv} from '../lib/env.mjs';
import {rows} from '../lib/standalone/db.ts';
import {parseReleaseSlips} from '../lib/release-slip.ts';
import {parseMessage} from '../lib/release-parser.ts';
import {listReleaseSlips, RELEASE_CHAT_JID} from '../lib/standalone/release-slips.ts';

loadEnv();

const APPLY = process.argv.includes('--apply');

const messages = await rows<{
  message_id: string; source_timestamp: string; text_content: string | null; media_type: string | null;
}>(
  `SELECT message_id, source_timestamp::text AS source_timestamp, text_content, media_type
     FROM whatsapp_messages
    WHERE chat_jid = $1 AND deleted_at IS NULL
    ORDER BY source_timestamp`,
  [RELEASE_CHAT_JID],
);

let empty = 0;
let structured = 0;
let paymentLine = 0;
let unparsed = 0;
const unparsedSamples: Array<{id: string; text: string}> = [];

for (const message of messages) {
  const text = String(message.text_content ?? '');
  if (!text.trim()) { empty += 1; continue; }
  if (parseReleaseSlips(text).length) { structured += 1; continue; }
  if (parseMessage(text, message.source_timestamp).length) { paymentLine += 1; continue; }
  unparsed += 1;
  if (unparsedSamples.length < 5) unparsedSamples.push({id: message.message_id, text: text.slice(0, 160)});
}

const slips = await listReleaseSlips();
const pending = slips.filter((slip) => slip.status === 'PENDING');
const approved = slips.filter((slip) => slip.status === 'APPROVED');
const declined = slips.filter((slip) => slip.status === 'DECLINED');
const verified = slips.filter((slip) => slip.cashVerified);
const missing = slips.filter((slip) => slip.escortMobile && slip.endDate && !slip.cashVerified);

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY-REQUESTED' : 'DRY-RUN',
  chat: RELEASE_CHAT_JID,
  messagesScanned: messages.length,
  emptyOrMediaOnly: empty,
  structuredSlips: structured,
  paymentLineSlips: paymentLine,
  unparsed,
  unparsedSamples,
  derivedSlips: slips.length,
  alreadyApplied: approved.length,
  declined: declined.length,
  pending: pending.length,
  cash: {verified: verified.length, missing: missing.length},
  foodBillTotalMinor: slips.reduce((sum, slip) => sum + Number(slip.foodBillMinor ?? 0), 0),
}, null, 2));

if (APPLY) {
  console.log('\nNothing to write: release slips are derived from the messages, not stored.');
  console.log('Bulk approval is deliberately not automated; use the /release page per slip.');
} else {
  console.log('\nDry run only. Nothing was written.');
}
