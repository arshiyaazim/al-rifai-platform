#!/usr/bin/env node
// Escort order / office-assignment backfill audit. Dry-run by default.
//
// Source of truth: WA-01 mirrored Bridge-1 messages for the three Owner escort
// clients, plus the Office Group assignment messages. This script is READ ONLY
// unless --apply is passed; --apply is intentionally not wired until the Owner
// approves the dry-run. It never sends WhatsApp messages.

import {loadEnv} from '../lib/env.mjs';
import {rows} from '../lib/standalone/db.ts';
import {parseEscortOrder} from '../lib/escort-intake-candidate.mjs';
import {businessDay} from '../lib/vessel-match.ts';
import {orderIntakeShift} from '../lib/order-intake-shift.ts';

loadEnv();

const APPLY = process.argv.includes('--apply');
const FROM = process.env.BACKFILL_FROM ?? '2026-10-01';
const TO = process.env.BACKFILL_TO ?? new Date().toISOString().slice(0, 10);
const OFFICE_GROUP = '120363426895117693@g.us';
const CLIENT_CHATS = [
  '8801670535255@s.whatsapp.net', '166082241384593@lid',
  '8801836743754@s.whatsapp.net', '155508031901923@lid',
  '8801757622300@s.whatsapp.net', '243103839576097@lid',
];

const normalise = (value: unknown) => String(value ?? '')
  .replace(/^m\.?\s*v\.?\s*/i, '')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .toLowerCase();
const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');

type ParsedBlock = {
  fields?: Record<string, unknown>;
  shift?: string | null;
  assignmentDate?: string | null;
  reasons?: string[];
  masterMobile?: string | null;
};
type Message = {
  message_id: string;
  chat_jid: string;
  source_timestamp: string;
  text_content: string | null;
};
type Program = {
  id: string;
  mother_vessel: string;
  lighter_vessel: string;
  master_mobile: string | null;
  escort_name: string | null;
  escort_mobile: string | null;
  source_message_id: string | null;
  source_chat_jid: string | null;
  state: string;
};

const programs = await rows<Program>(
  `SELECT id, mother_vessel, lighter_vessel, master_mobile, escort_name, escort_mobile,
          source_message_id, source_chat_jid, state
     FROM programs WHERE state <> 'VOIDED'`,
);
const bySource = new Map(programs.filter((p) => p.source_message_id).map((p) => [p.source_message_id as string, p]));

const messages = await rows<Message>(
  `SELECT message_id, chat_jid, source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = 'wa-01'
      AND direction = 'INCOMING'
      AND chat_jid = ANY($1::text[])
      AND source_timestamp >= $2::date
      AND source_timestamp < ($3::date + interval '1 day')
    ORDER BY source_timestamp`,
  [CLIENT_CHATS, FROM, TO],
);

const summary = {
  mode: APPLY ? 'APPLY' : 'DRY_RUN',
  from: FROM,
  to: TO,
  client_messages: messages.length,
  parsed_blocks: 0,
  missing_programs: 0,
  existing_programs: 0,
  duplicate_blocks: 0,
  unparsed_messages: 0,
  missing_examples: [] as Array<Record<string, unknown>>,
  unparsed_examples: [] as Array<Record<string, unknown>>,
};
const seenKeys = new Set<string>();

for (const message of messages) {
  const date = businessDay(message.source_timestamp) || message.source_timestamp.slice(0, 10);
  let blocks: ParsedBlock[] = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate: date});
  } catch {
    blocks = [];
  }
  if (!blocks.length) {
    summary.unparsed_messages += 1;
    if (summary.unparsed_examples.length < 12) {
      summary.unparsed_examples.push({messageId: message.message_id, date, chars: String(message.text_content ?? '').length});
    }
    continue;
  }
  for (const block of blocks) {
    summary.parsed_blocks += 1;
    const fields = block.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    const master = digits(fields.masterMobile);
    const shift = block.shift ?? orderIntakeShift(message.source_timestamp, message.text_content);
    const dateValue = block.assignmentDate ?? date;
    if (mother && lighter) {
      const key = `${message.message_id}|${lighter}`;
      if (seenKeys.has(key)) summary.duplicate_blocks += 1;
      seenKeys.add(key);
    }
    const existing = bySource.get(message.message_id)
      ?? programs.find((program) =>
        normalise(program.mother_vessel) === mother
        && normalise(program.lighter_vessel) === lighter
        && digits(program.master_mobile) === master
        && String(program.source_chat_jid ?? '') === message.chat_jid);
    if (existing) {
      summary.existing_programs += 1;
    } else {
      summary.missing_programs += 1;
      if (summary.missing_examples.length < 20) {
        summary.missing_examples.push({
          messageId: message.message_id, mother: fields.motherVessel ?? null,
          lighter: fields.lighterVessel ?? null, master: fields.masterMobile ?? null,
          date: dateValue, shift, reasons: block.reasons ?? [],
        });
      }
    }
  }
}

const officeMessages = await rows<Message>(
  `SELECT message_id, chat_jid, source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = 'wa-01'
      AND chat_jid = $1
      AND direction = 'INCOMING'
      AND source_timestamp >= $2::date
      AND source_timestamp < ($3::date + interval '1 day')
      AND text_content ~* 'escort\\s*name'
      AND text_content ~* 'escort\\s*mobile'
    ORDER BY source_timestamp`,
  [OFFICE_GROUP, FROM, TO],
);

const office = {
  messages: officeMessages.length,
  parsed_blocks: 0,
  matched_programs: 0,
  unmatched_programs: 0,
  ambiguous_matches: 0,
  escort_updates_available: 0,
  examples: [] as Array<Record<string, unknown>>,
};
for (const message of officeMessages) {
  const date = businessDay(message.source_timestamp) || message.source_timestamp.slice(0, 10);
  let blocks: ParsedBlock[] = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate: date});
  } catch {
    blocks = [];
  }
  for (const block of blocks) {
    office.parsed_blocks += 1;
    const fields = block.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    const master = digits(fields.masterMobile);
    const candidates = programs.filter((program) =>
      normalise(program.mother_vessel) === mother
      && normalise(program.lighter_vessel) === lighter
      && (!master || digits(program.master_mobile) === master));
    if (candidates.length === 1) {
      office.matched_programs += 1;
      const candidate = candidates[0];
      if (!candidate.escort_name || !candidate.escort_mobile) office.escort_updates_available += 1;
    } else if (candidates.length === 0) {
      office.unmatched_programs += 1;
    } else {
      office.ambiguous_matches += 1;
    }
    if (office.examples.length < 12) {
      office.examples.push({
        messageId: message.message_id, mother: fields.motherVessel ?? null,
        lighter: fields.lighterVessel ?? null, master: fields.masterMobile ?? null,
        candidates: candidates.length, date,
      });
    }
  }
}

console.log(JSON.stringify({client: summary, office}, null, 2));
if (APPLY) {
  console.error('APPLY is not enabled: dry-run approval is required first. No writes were made.');
  process.exitCode = 2;
}
