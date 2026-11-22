#!/usr/bin/env node
// Put the unresolved backfill conflicts on the Review screen. Idempotent.
// The Owner can then approve/reject each one with the normal review workflow.

import {loadEnv} from '../lib/env.mjs';
import {rows} from '../lib/standalone/db.ts';
import {parseEscortOrder} from '../lib/escort-intake-candidate.mjs';
import {businessDay} from '../lib/vessel-match.ts';

loadEnv();

const ITEMS = [
  {messageId: 'AC535EFF4FD6B2076BB2B8D857622A59', reason: 'CLOSED_ROW_ESCORT_CONFLICT',
    note: 'Closed row says Korban Ali 01868087651; office message says 01865087651 (one digit). History kept.'},
  {messageId: 'ACD6A48F23C3CCFB0EA1BF6C9E6FF3AC', reason: 'CLOSED_ROW_ESCORT_CONFLICT',
    note: 'Closed row says Nazim Uddin; office message says Shahadat Hossain. History kept.'},
  {messageId: 'ACAB7A05F3C46B38FFC4A5FEA8C50681', reason: 'OUTSIDE_DUTY_WINDOW',
    note: '10/10 assignment predates the TOURAN/KHURSHIDA 2 rows that start 15/10 with this master.'},
  {messageId: 'AC0EF290DEF7CABBCDD2D90B231FB973', reason: 'OUTSIDE_DUTY_WINDOW',
    note: '14/10 assignment predates the TOURAN/KHURSHIDA 2 rows that start 15/10 with this master.'},
  {messageId: 'AC137A028F6B740CB5179099669FBC6D', reason: 'CLOSED_ROW_ESCORT_CONFLICT',
    note: 'Closed 15/10 row says Hanif; office message says Nazmul Hasan. History kept.'},
  {messageId: 'ACD3725DCA9C9792C82CF8376A3AA687', reason: 'AMBIGUOUS_DUTY_ROWS',
    note: 'Two Baitullah rows overlap 24-26/10 (different escorts); source contradiction.'},
  {messageId: 'AC14DC82169C3A5DC6F201ED9ADB1D07', reason: 'NO_PROGRAM_MATCH',
    note: 'Mother vessel is garbled (---x) and no client order exists for this lighter.'},
];

const accountId = 'wa-01';
const messageIds = ITEMS.map((item) => item.messageId);
const messages = await rows<{
  message_id: string; chat_jid: string; sender_jid: string | null;
  source_timestamp: string; text_content: string | null;
}>(
  `SELECT message_id, chat_jid, sender_jid, source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = $1 AND message_id = ANY($2::text[])`,
  [accountId, messageIds],
);
const byId = new Map(messages.map((message) => [message.message_id, message]));

let inserted = 0;
let skipped = 0;
for (const item of ITEMS) {
  const message = byId.get(item.messageId);
  if (!message) continue;
  const messageDate = businessDay(message.source_timestamp) || message.source_timestamp.slice(0, 10);
  let fields: Record<string, unknown> = {};
  try {
    const block = (parseEscortOrder(String(message.text_content ?? ''), {messageDate}) as Array<{
      fields?: Record<string, unknown>;
      assignmentDate?: string | null;
      shift?: string | null;
    }>)[0];
    fields = {
      motherVessel: block?.fields?.motherVessel ?? null,
      lighterVessel: block?.fields?.lighterVessel ?? null,
      masterMobile: block?.fields?.masterMobile ?? null,
      escortName: block?.fields?.escortName ?? null,
      escortMobile: block?.fields?.escortMobile ?? null,
      assignmentDate: block?.assignmentDate ?? null,
      shift: block?.shift ?? null,
    };
  } catch {
    fields = {};
  }
  const payload = {
    category: 'UNMATCHED_VESSEL_ASSIGNMENT',
    sourceMessageId: message.message_id,
    sourceChatJid: message.chat_jid,
    sourceAccountId: accountId,
    sourceTimestamp: message.source_timestamp,
    senderJid: message.sender_jid,
    rawText: message.text_content,
    backfillReason: item.reason,
    note: item.note,
    fields,
  };
  const id = `rvw_bf_${message.message_id}`;
  const result = await rows(
    `INSERT INTO review_items (id, domain, action, target_ref, payload, submitted_by, state, category)
     VALUES ($1,'PROGRAM','UPDATE',$2,$3::jsonb,'system:escort-backfill','PENDING','UNMATCHED_VESSEL_ASSIGNMENT')
     ON CONFLICT (id) DO NOTHING
     RETURNING id`,
    [id, message.message_id, JSON.stringify(payload)],
  );
  if (result.length) inserted += 1;
  else skipped += 1;
}
console.log(JSON.stringify({inserted, skipped, total: ITEMS.length}));
