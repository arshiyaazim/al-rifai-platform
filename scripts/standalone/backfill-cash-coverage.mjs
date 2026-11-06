#!/usr/bin/env node
// AL-RIFA'I — Cash coverage backfill for the authorized Admin→Accountant chat.
//
// Dry-run by default. It reads the Phase 3 WhatsApp mirror, parses payment
// blocks with the established parser, and creates REVIEW instructions only.
// It never posts, never approves, and never creates income.
//
// Duplicate policy:
//   * exact normalized text already linked to an instruction  -> review candidate
//   * same employee + amount within 7 days                    -> review candidate
//   * all other clean blocks                                  -> REVIEW instruction
//   * identity/format failures                                -> review candidate
//
// Idempotency: the instruction unique index (source_message_id, source_block_key)
// and the cash_submissions payload hash prevent duplicates on a repeat run.
import {writeFileSync} from 'node:fs';
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';

loadEnv();
import {row, rows} from '../../lib/standalone/db.ts';
import {createInstruction} from '../../lib/standalone/finance.ts';
import {recordAudit, stableId} from '../../lib/standalone/audit.ts';
import {parsePaymentBlocks} from '../../lib/history-extraction.mjs';

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const APPLY = flag('apply');
const SOURCE_DB = arg('source-db') ?? process.env.SOURCE_PGDATABASE ?? 'alrifai';
const CHAT = arg('chat') ?? '8801844836824@s.whatsapp.net';
const LID = arg('lid') ?? '19460614262828@lid';
const ACTOR = {id: 'system:cash-backfill', role: 'ADMIN'};
const phone = /(\+?88)?01[3-9]\d{8}/g;

function normalized(text) {
  return text.replace(phone, '<p>').replace(/\bID\s*:\s*/gi, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

function submissionPayload(message, release, details) {
  return {
    sourceMessageId: message.message_id,
    sourceChatJid: CHAT,
    sourceAccountId: 'wa-01',
    sourceTimestamp: message.source_timestamp,
    rawText: message.text_content,
    releaseCategory: release,
    ...details,
  };
}

async function submitCandidate(message, category, details) {
  const payload = submissionPayload(message, category, details);
  const canonical = JSON.stringify(payload);
  const id = `backfill-${stableId('sub', [CHAT, message.message_id, category]).slice(0, 40)}`;
  try {
    await row(
      `INSERT INTO cash_submissions
         (id, payload, payload_hash, submitted_by, state, source_message_id, source_chat_jid, source_account_id, category)
       VALUES ($1,$2::jsonb,$3,$4,'PENDING_REVIEW',$5,$6,'wa-01',$7)`,
      [id, canonical, stableId('h', [canonical]), ACTOR.id, message.message_id, CHAT, category],
    );
    return true;
  } catch {
    return false;
  }
}

function sourceClient() {
  const host = (process.env.SOURCE_PGHOST || process.env.PGHOST || '').trim();
  const port = Number((process.env.SOURCE_PGPORT || process.env.PGPORT || '5432').trim());
  const user = (process.env.SOURCE_PGUSER || process.env.PGUSER || '').trim();
  const password = (process.env.SOURCE_PGPASSWORD || '').trim() || secret('PGPASSWORD');
  if (!host || !user || !password) return null;
  return new pg.Client({host, port, database: SOURCE_DB, user, password, application_name: 'cash-backfill-read'});
}

async function main() {
  const messages = await rows(
    `SELECT message_id, source_timestamp::text AS source_timestamp, text_content, source_rowid::text AS source_rowid
       FROM whatsapp_messages
      WHERE account_id = 'wa-01'
        AND chat_jid IN ($1,$2)
        AND direction = 'OUTGOING'
        AND text_content IS NOT NULL
      ORDER BY source_timestamp`,
    [CHAT, LID],
  );
  const existing = await rows(
    `SELECT coalesce(employee_mobile,'') AS employee_mobile, amount_minor::text,
            created_at::date::text AS day
       FROM cash_instructions`,
  );
  const existingByKey = new Map();
  for (const entry of existing) {
    const key = `${entry.employee_mobile}|${entry.amount_minor}`;
    const list = existingByKey.get(key) ?? [];
    list.push(entry.day);
    existingByKey.set(key, list);
  }
  const alreadyLinked = new Set(
    (await rows(
      `SELECT source_message_id FROM cash_instructions WHERE source_message_id IS NOT NULL`,
    )).map((entry) => entry.source_message_id),
  );
  // Legacy instructions use `legacy-ci:*` source IDs. Their real WhatsApp
  // message IDs live in the legacy source_refs table, so link them read-only.
  const source = sourceClient();
  if (source) {
    await source.connect();
    await source.query('SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY');
    const legacyLinks = await source.query(
      `SELECT DISTINCT s.message_id AS message_id FROM source_refs s WHERE s.message_id IS NOT NULL`,
    );
    for (const entry of legacyLinks.rows) alreadyLinked.add(entry.message_id);
    const legacyKeys = await source.query(
      `SELECT coalesce(i.employee_mobile,'') AS employee_mobile, i.amount_minor::text AS amount_minor,
              i.source_time::date::text AS day
         FROM cash_instructions i WHERE i.employee_mobile IS NOT NULL`,
    );
    for (const entry of legacyKeys.rows) {
      const key = `${entry.employee_mobile}|${entry.amount_minor}`;
      const list = existingByKey.get(key) ?? [];
      list.push(entry.day);
      existingByKey.set(key, list);
    }
    await source.end();
  }

  const seenText = new Set();
  for (const message of messages) {
    if (alreadyLinked.has(message.message_id)) seenText.add(normalized(message.text_content ?? ''));
  }

  const report = {
    step: 'cash-coverage-backfill',
    mode: APPLY ? 'apply' : 'dry-run',
    chat: CHAT,
    scanned: messages.length,
    already_linked: 0,
    non_payment: 0,
    clean_blocks: 0,
    created_instructions: 0,
    duplicate_candidates: 0,
    ambiguous_candidates: 0,
    amount_minor: 0,
    skipped_existing: 0,
  };
  for (const message of messages) {
    if (alreadyLinked.has(message.message_id)) {
      report.already_linked += 1;
      continue;
    }
    const text = message.text_content ?? '';
    const blocks = parsePaymentBlocks(text);
    if (!blocks.length) continue;
    const clean = blocks.filter((block) => block.reasons.length === 0);
    if (!clean.length) {
      report.ambiguous_candidates += 1;
      if (APPLY) await submitCandidate(message, 'INCOMPLETE_CASH_INSTRUCTION', {
        reasons: [...new Set(blocks.flatMap((block) => block.reasons))],
        parser: 'history-extraction-v2',
      });
      continue;
    }
    const signature = normalized(text);
    const exactDuplicate = seenText.has(signature);
    seenText.add(signature);
    for (const block of clean) {
      report.clean_blocks += 1;
      const fields = block.fields;
      const employeeMobile = fields.employeeMobile ?? null;
      const amountMinor = Number(fields.amountMinor);
      if (!employeeMobile || !Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
        report.ambiguous_candidates += 1;
        if (APPLY) await submitCandidate(message, 'INCOMPLETE_CASH_INSTRUCTION', {
          fields, reasons: ['IDENTITY_OR_AMOUNT_UNRESOLVED'], parser: 'history-extraction-v2',
        });
        continue;
      }
      const day = message.source_timestamp.slice(0, 10);
      const same = existingByKey.get(`${employeeMobile}|${amountMinor}`) ?? [];
      const near = same.some((date) => Math.abs(Date.parse(date) - Date.parse(day)) <= 7 * 86400000);
      if (exactDuplicate || near) {
        report.duplicate_candidates += 1;
        if (APPLY) await submitCandidate(message, 'CASH_DUPLICATE_CANDIDATE', {
          fields, reason: exactDuplicate ? 'EXACT_TEXT_DUPLICATE' : 'SAME_EMPLOYEE_AMOUNT_WITHIN_7_DAYS',
          existingDays: same, parser: 'history-extraction-v2',
        });
        continue;
      }
      if (!APPLY) {
        report.created_instructions += 1;
        report.amount_minor += amountMinor;
        continue;
      }
      const created = await createInstruction(ACTOR, {
        employeeMobile,
        employeeName: fields.employeeName ?? 'Unknown',
        payoutMobile: fields.payoutMobile ?? null,
        method: fields.method ?? 'cash',
        amountMinor,
        purpose: fields.purpose ?? 'Backfilled authorized Cash message',
        accountId: null,
        sourceChannel: 'WHATSAPP',
        sourceMessageId: message.message_id,
        sourceBlockKey: block.blockKey,
        sourceHash: stableId('h', ['backfill', message.message_id, block.blockKey]),
      });
      if (created) {
        report.created_instructions += 1;
        report.amount_minor += amountMinor;
      } else {
        report.skipped_existing += 1;
      }
    }
  }

  if (APPLY) {
    await recordAudit({
      actor: ACTOR,
      action: 'CASH_COVERAGE_BACKFILL',
      entity: 'cash_backfill',
      entityId: 'coverage-v1',
      detail: report,
      source: 'SYSTEM',
    });
  }
  const output = arg('report');
  if (output) writeFileSync(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (!APPLY) console.log('Dry run complete; no instruction or review row was written.');
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'BACKFILL_FAILED'}));
  process.exitCode = 1;
});
