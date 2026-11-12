#!/usr/bin/env node
// AL-RIFA'I — one-off backfill: Bridge-1 outbound Cash messages → cash_instructions.
//
// Scope: WA-01 OUTGOING messages in the accountant direct chat since a cut-off
// date that satisfy the operator's element-based Cash rule (mobile + name +
// taka amount) and are not already recorded.
//
// Safety:
//   * DRY RUN by default. Nothing is written unless `--apply` is passed.
//   * Reuses the exact Flow A posting path (`postCashInstructionOn`) so the
//     instruction, ledger entry, posting, paid event and audit row stay
//     identical to live routing.
//   * Idempotent per (source_message_id, source_block_key).
//   * A missing employee is created, never dropped.
//
// Usage (inside a Node 22 container with the repo + DB env):
//   node --experimental-strip-types scripts/backfill-bridge1-cash.ts --dry-run
//   node --experimental-strip-types scripts/backfill-bridge1-cash.ts --apply
//
// Environment:
//   ACCOUNTANT_CHAT_JID  target chat (default: the known accountant chat)
//   BACKFILL_SINCE       inclusive cut-off (default 2026-10-01)

import {rows, row, tx} from '../lib/standalone/db.ts';
import {postCashInstructionOn} from '../lib/standalone/finance.ts';
import {findOrCreateEmployeeByMobile} from '../lib/standalone/cash-employee.ts';
import {parseCashElements} from '../lib/cash-elements.mjs';
import {stableId} from '../lib/standalone/audit.ts';
import type {Actor} from '../lib/standalone/db.ts';

const APPLY = process.argv.includes('--apply');
const ACCOUNTANT_CHAT_JID = (process.env.ACCOUNTANT_CHAT_JID ?? '').trim() || '19460614262828@lid';
const SINCE = (process.env.BACKFILL_SINCE ?? '2026-10-01').trim();
const BLOCK_KEY = 'cash-element-0';

const actor: Actor = {id: 'system:bridge1-cash-backfill', role: 'ADMIN'};

type MessageRow = {
  id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  sender_jid: string | null;
  source_timestamp: string;
  text_content: string | null;
};

const messages = await rows<MessageRow>(
  `SELECT id::text, account_id, chat_jid, message_id, sender_jid,
          source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = 'wa-01'
      AND direction = 'OUTGOING'
      AND chat_jid = $1
      AND source_timestamp >= $2::timestamptz
      AND deleted_at IS NULL
    ORDER BY source_timestamp, id`,
  [ACCOUNTANT_CHAT_JID, SINCE],
);

const tally = {
  scanned: messages.length,
  candidates: 0,
  inserted: 0,
  alreadyExisted: 0,
  rejectedByParser: 0,
  ambiguous: 0,
  cancelled: 0,
  failed: 0,
};
const rejectedSamples: Array<{messageId: string; text: string; reason: string}> = [];
const failures: Array<{messageId: string; error: string}> = [];

for (const message of messages) {
  const text = message.text_content ?? '';
  const element = parseCashElements(text);
  if (!element) {
    tally.rejectedByParser += 1;
    if (rejectedSamples.length < 20) rejectedSamples.push({messageId: message.message_id, text: text.slice(0, 160), reason: 'NO_ELEMENTS'});
    continue;
  }
  if (element.ambiguous) {
    tally.ambiguous += 1;
    if (rejectedSamples.length < 20) rejectedSamples.push({messageId: message.message_id, text: text.slice(0, 160), reason: 'AMBIGUOUS_MOBILE_NUMBERS'});
    continue;
  }
  if (element.cancelled) {
    tally.cancelled += 1;
    if (rejectedSamples.length < 20) rejectedSamples.push({messageId: message.message_id, text: text.slice(0, 160), reason: 'CANCELLATION_OR_RETURN'});
    continue;
  }

  tally.candidates += 1;

  const existing = await row(
    'SELECT 1 AS present FROM cash_instructions WHERE source_message_id = $1 AND source_block_key = $2',
    [message.message_id, BLOCK_KEY],
  );
  if (existing) {
    tally.alreadyExisted += 1;
    continue;
  }

  if (!APPLY) continue;

  try {
    await tx(async (client) => {
      const employee = await findOrCreateEmployeeByMobile(element.mobiles[0], element.nameHint, actor.id);
      const payoutMobile = `+88${element.mobiles[1] ?? element.mobiles[0]}`;
      const method = element.method ?? 'cash';
      const purpose = element.methodInferred
        ? 'Owner direct payment instruction (payment method not stated; recorded as cash)'
        : 'Owner direct payment instruction';
      await postCashInstructionOn(client, actor, {
        employeeMobile: employee.employee_mobile,
        employeeName: employee.preferred_name || element.nameHint || 'UNKNOWN',
        payoutMobile,
        method,
        amountMinor: element.amountMinor,
        purpose,
        accountId: 'acc-cash',
        sourceChannel: 'WHATSAPP',
        sourceMessageId: message.message_id,
        sourceBlockKey: BLOCK_KEY,
        sourceHash: stableId('h', [message.account_id, message.message_id, BLOCK_KEY]),
      }, {
        eventAt: message.source_timestamp,
        sourceMessageId: message.message_id,
        sourceBlockKey: BLOCK_KEY,
        sourceHash: stableId('h', [message.account_id, message.message_id, BLOCK_KEY]),
        auditAction: 'CASH:AUTO_POSTED_ELEMENT_BACKFILL',
        auditSource: 'WHATSAPP',
        whatsAppVerified: true,
      });
    });
    tally.inserted += 1;
  } catch (error) {
    tally.failed += 1;
    failures.push({messageId: message.message_id, error: (error as Error).message.slice(0, 200)});
  }
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY_RUN',
  account: 'wa-01',
  accountantChatJid: ACCOUNTANT_CHAT_JID,
  since: SINCE,
  ...tally,
  rejectedSamples,
  failures,
}, null, 2));
