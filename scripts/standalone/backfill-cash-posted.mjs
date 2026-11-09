#!/usr/bin/env node
// AL-RIFA'I — one-time Cash POSTED backfill from the WhatsApp source of truth.
//
// Dry-run by default. With --apply it creates POSTED instructions, postings and
// ledger entries for every clean Admin (WA-01) OUTGOING payment block in the
// Accountant direct chat. Incomplete blocks become cash_submissions for review.
//
// Event time: whatsapp_messages.source_timestamp (never created_at/mirrored_at).
// Revoked messages are excluded (deleted_at IS NOT NULL).
// Dedup: cash_instructions_source_identity (source_message_id, source_block_key).
import {loadEnv} from '../../lib/env.mjs';
import {rows, tx} from '../../lib/standalone/db.ts';
import {recordAudit, stableId} from '../../lib/standalone/audit.ts';
import {postCashInstructionOn} from '../../lib/standalone/finance.ts';
import {parsePaymentBlocks} from '../../lib/history-extraction.mjs';

loadEnv();

const APPLY = process.argv.includes('--apply');
const ACTOR = {id: 'system:cash-backfill', role: 'ADMIN'};
const CHAT_PN = '8801844836824@s.whatsapp.net';
const CHAT_LID = '19460614262828@lid';

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

async function loadMessages() {
  return rows(
    `SELECT message_id, chat_jid, direction, sender_jid,
            source_timestamp::text AS source_timestamp,
            source_rowid::text AS source_rowid,
            text_content, deleted_at
       FROM whatsapp_messages
      WHERE account_id = 'wa-01'
        AND chat_jid IN ($1,$2)
        AND direction = 'OUTGOING'
        AND deleted_at IS NULL
        AND text_content IS NOT NULL
      ORDER BY source_timestamp ASC, source_rowid ASC`,
    [CHAT_PN, CHAT_LID],
  );
}

async function existingInstructions() {
  const list = await rows(
    `SELECT source_message_id, source_block_key
       FROM cash_instructions
      WHERE source_message_id IS NOT NULL`,
  );
  return new Set(list.map((item) => `${item.source_message_id}\u0000${item.source_block_key}`));
}

async function insertSubmission(client, message, block, reasons) {
  const payload = {
    sourceMessageId: message.message_id,
    sourceChatJid: message.chat_jid,
    sourceAccountId: 'wa-01',
    sourceTimestamp: message.source_timestamp,
    rawText: message.text_content,
    fields: block.fields,
    blockKey: block.blockKey,
    reasons,
    parser: 'parsePaymentBlocks',
    parserVersion: 'history-extraction-v3',
    needsReviewerCorrection: true,
    backfill: 'cash-posted-v1',
  };
  const canonical = JSON.stringify(payload);
  const id = stableId('sub', ['cash-posted-backfill', message.message_id, block.blockKey]);
  const created = await client.query(
    `INSERT INTO cash_submissions
       (id, payload, payload_hash, submitted_by, state,
        source_message_id, source_chat_jid, source_account_id, category)
     VALUES ($1,$2::jsonb,$3,$4,'PENDING_REVIEW',$5,$6,'wa-01','INCOMPLETE_CASH_INSTRUCTION')
     ON CONFLICT (payload_hash) DO NOTHING
     RETURNING id`,
    [id, canonical, stableId('h', [canonical]), ACTOR.id, message.message_id, message.chat_jid],
  );
  return created.rowCount ? id : null;
}

async function main() {
  const messages = await loadMessages();
  const existing = APPLY ? await existingInstructions() : new Set();

  const report = {
    step: 'cash-posted-backfill',
    mode: APPLY ? 'apply' : 'dry-run',
    messages: messages.length,
    messagesWithBlocks: 0,
    cleanBlocks: 0,
    incompleteBlocks: 0,
    createdInstructions: 0,
    createdPostings: 0,
    createdLedgerEntries: 0,
    createdSubmissions: 0,
    skippedExisting: 0,
    amountMinor: 0,
    amountBdt: '0.00',
    uniqueEmployees: 0,
    minEventAt: null,
    maxEventAt: null,
    errors: [],
  };
  const employees = new Set();
  let minEvent = null;
  let maxEvent = null;

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    const blocks = parsePaymentBlocks(message.text_content ?? '');
    if (!blocks.length) continue;
    report.messagesWithBlocks += 1;
    const clean = blocks.filter((block) => block.reasons.length === 0);
    const incomplete = blocks.filter((block) => block.reasons.length > 0);

    if (APPLY) {
      await tx(async (client) => {
        const instructionIds = [];
        let messageAmount = 0;
        for (const block of clean) {
          const key = `${message.message_id}\u0000${block.blockKey}`;
          if (existing.has(key)) {
            report.skippedExisting += 1;
            continue;
          }
          const amountMinor = Number(block.fields.amountMinor);
          if (!block.fields.employeeMobile || !block.fields.employeeName
            || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
            report.errors.push({messageId: message.message_id, blockKey: block.blockKey, error: 'IDENTITY_OR_AMOUNT_UNRESOLVED'});
            continue;
          }
          const result = await postCashInstructionOn(client, ACTOR, {
            employeeMobile: block.fields.employeeMobile,
            employeeName: block.fields.employeeName,
            payoutMobile: block.fields.payoutMobile ?? block.fields.employeeMobile,
            method: block.fields.method,
            amountMinor,
            purpose: block.fields.purpose ?? 'Owner direct payment instruction',
            accountId: 'acc-cash',
            sourceChannel: 'WHATSAPP',
            sourceMessageId: message.message_id,
            sourceBlockKey: block.blockKey,
            sourceHash: stableId('h', ['cash-posted-backfill', message.message_id, block.blockKey]),
          }, {
            eventAt: message.source_timestamp,
            sourceMessageId: message.message_id,
            sourceBlockKey: block.blockKey,
            sourceHash: stableId('h', ['cash-posted-backfill', message.message_id, block.blockKey]),
            auditAction: null,
            auditSource: 'SYSTEM',
            whatsAppVerified: false,
          });
          if (!result) {
            report.skippedExisting += 1;
            continue;
          }
          report.cleanBlocks += 1;
          report.createdInstructions += 1;
          report.createdPostings += 1;
          report.createdLedgerEntries += 1;
          report.amountMinor += amountMinor;
          messageAmount += amountMinor;
          employees.add(block.fields.employeeMobile);
          if (!minEvent || message.source_timestamp < minEvent) minEvent = message.source_timestamp;
          if (!maxEvent || message.source_timestamp > maxEvent) maxEvent = message.source_timestamp;
          instructionIds.push(result.instructionId);
        }

        for (const block of incomplete) {
          const id = await insertSubmission(client, message, block, block.reasons);
          if (id) {
            report.incompleteBlocks += 1;
            report.createdSubmissions += 1;
            await recordAudit({
              actor: ACTOR,
              action: 'CASH:BACKFILL_REVIEW',
              entity: 'cash_submission',
              entityId: id,
              detail: {messageId: message.message_id, blockKey: block.blockKey, reasons: block.reasons, eventAt: message.source_timestamp},
              source: 'SYSTEM',
              sourceRef: message.message_id,
            }, client);
          }
        }

        if (instructionIds.length || report.createdSubmissions) {
          await recordAudit({
            actor: ACTOR,
            action: 'CASH:BACKFILL_CREATED',
            entity: 'cash_backfill_message',
            entityId: message.message_id,
            detail: {
              messageId: message.message_id,
              eventAt: message.source_timestamp,
              blocksCount: instructionIds.length,
              amountMinor: messageAmount,
              instructionIds,
            },
            source: 'SYSTEM',
            sourceRef: message.message_id,
          }, client);
        }
      });
    } else {
      for (const block of clean) {
        const amountMinor = Number(block.fields.amountMinor);
        if (!block.fields.employeeMobile || !block.fields.employeeName
          || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
          report.errors.push({messageId: message.message_id, blockKey: block.blockKey, error: 'IDENTITY_OR_AMOUNT_UNRESOLVED'});
          continue;
        }
        report.cleanBlocks += 1;
        report.createdInstructions += 1;
        report.createdPostings += 1;
        report.createdLedgerEntries += 1;
        report.amountMinor += amountMinor;
        employees.add(block.fields.employeeMobile);
        if (!minEvent || message.source_timestamp < minEvent) minEvent = message.source_timestamp;
        if (!maxEvent || message.source_timestamp > maxEvent) maxEvent = message.source_timestamp;
      }
      report.incompleteBlocks += incomplete.length;
      report.createdSubmissions += incomplete.length;
    }

    if ((index + 1) % 100 === 0) log(`processed ${index + 1}/${messages.length}`);
  }

  report.uniqueEmployees = employees.size;
  report.amountBdt = (report.amountMinor / 100).toFixed(2);
  report.minEventAt = minEvent;
  report.maxEventAt = maxEvent;

  if (APPLY) {
    await recordAudit({
      actor: ACTOR,
      action: 'CASH:BACKFILL',
      entity: 'cash_backfill',
      entityId: 'whatsapp-posted-v1',
      detail: report,
      source: 'SYSTEM',
      sourceRef: 'whatsapp-posted-v1',
    });
  }

  console.log(JSON.stringify(report, null, 2));
  if (!APPLY) console.log('Dry run complete; no Cash rows were written.');
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'BACKFILL_FAILED'}));
  process.exitCode = 1;
});
