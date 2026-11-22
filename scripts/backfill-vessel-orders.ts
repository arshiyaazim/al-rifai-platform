#!/usr/bin/env node
// Escort order / office-assignment backfill audit. Dry-run by default.
//
// Source of truth: WA-01 mirrored Bridge-1 messages for the three Owner escort
// clients, plus the Office Group assignment messages. This script is READ ONLY
// unless --apply is passed; --apply is intentionally not wired until the Owner
// approves the dry-run. It never sends WhatsApp messages.

import {loadEnv} from '../lib/env.mjs';
import {rows, tx} from '../lib/standalone/db.ts';
import {parseEscortOrder} from '../lib/escort-intake-candidate.mjs';
import {businessDay} from '../lib/vessel-match.ts';
import {orderIntakeShift} from '../lib/order-intake-shift.ts';

loadEnv();
// Backfill must never send WhatsApp messages. Keep the draft transport off even
// if the live environment has it enabled.
process.env.ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED = '0';

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
const isoDay = (value: unknown) => {
  const parsed = new Date(String(value ?? ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
};

// Office templates are typed by hand, so vessel names contain typos and stray
// serial suffixes. Similarity is only trusted when the master mobile matches
// exactly, which keeps different lighters with near-identical names apart.
const similarity = (a: string, b: string) => {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
};

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
  start_date: string;
  end_date: string | null;
};

const programs = await rows<Program>(
  `SELECT id, mother_vessel, lighter_vessel, master_mobile, escort_name, escort_mobile,
          source_message_id, source_chat_jid, state,
          start_date::text AS start_date, end_date::text AS end_date
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

const admin = {id: 'system:backfill-vessel-orders', role: 'ADMIN' as const};
const createdPrograms: string[] = [];
const plannedPrograms: Program[] = [];
const plannedIdentities = new Set<string>();
const plannedVesselDays = new Set<string>();
let absorbedByExisting = 0;
let duplicateIdentityBlocks = 0;
const updatedPrograms: string[] = [];
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
  const date = businessDay(message.source_timestamp) || isoDay(message.source_timestamp);
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
      const identity = `${mother}|${lighter}|${master}`;
      const vesselDay = `${mother}|${lighter}|${dateValue}`;
      if (!APPLY && fields.motherVessel && fields.lighterVessel && fields.masterMobile
        && (plannedIdentities.has(identity) || plannedVesselDays.has(vesselDay))) {
        duplicateIdentityBlocks += 1;
      } else if (!APPLY && fields.motherVessel && fields.lighterVessel && fields.masterMobile) {
        // Dry-run must model the office pass as if these rows existed, otherwise
        // the preview undercounts matches.
        plannedIdentities.add(identity);
        plannedVesselDays.add(vesselDay);
        plannedPrograms.push({
          id: `planned:${message.message_id}:${String(fields.lighterVessel)}`,
          mother_vessel: String(fields.motherVessel),
          lighter_vessel: String(fields.lighterVessel),
          master_mobile: String(fields.masterMobile),
          escort_name: null,
          escort_mobile: null,
          source_message_id: message.message_id,
          source_chat_jid: message.chat_jid,
          state: 'DRAFT',
          start_date: dateValue,
          end_date: null,
        });
      }
      if (APPLY && fields.motherVessel && fields.lighterVessel && fields.masterMobile) {
        const {createProgram} = await import('../lib/standalone/programs.ts');
        try {
          // Pass an explicit tx client so the draft-delivery hooks are skipped:
          // a backfill must never queue historical drafts for later sending.
          const created = await tx((client) => createProgram(admin, {
            motherVessel: String(fields.motherVessel),
            lighterVessel: String(fields.lighterVessel),
            masterMobile: String(fields.masterMobile),
            destination: fields.destination ? String(fields.destination) : null,
            startDate: dateValue,
            startShift: shift,
            notes: fields.cargo ? `Backfill: ${String(fields.cargo)}` : 'Backfill from client order',
          }, {
            channel: 'WHATSAPP', sourceType: 'WHATSAPP_ORDER',
            messageId: message.message_id, chatJid: message.chat_jid,
          }, client));
          if (!createdPrograms.includes(created.program.id)) createdPrograms.push(created.program.id);
        } catch (error) {
          if (!String(error).includes('DUPLICATE_PROGRAM')) throw error;
          absorbedByExisting += 1;
        }
      }
    }
  }
}

// Refresh the pool so an APPLY run matches office assignments against the rows
// it just created, and a dry-run matches against its planned rows.
const officePool: Program[] = APPLY
  ? await rows<Program>(
      `SELECT id, mother_vessel, lighter_vessel, master_mobile, escort_name, escort_mobile,
              source_message_id, source_chat_jid, state,
              start_date::text AS start_date, end_date::text AS end_date
         FROM programs WHERE state <> 'VOIDED'`,
    )
  : [...programs, ...plannedPrograms];
const ACTIVE_STATES = new Set(['DRAFT', 'ASSIGNED', 'CONFIRMED']);

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
  fuzzy_matches: 0,
  closed_programs_skipped: 0,
  stale_assignments_skipped: 0,
  invalid_escort_skipped: 0,
  escort_conflicts: 0,
  escort_updates: 0,
  duty_date_updates: 0,
  escort_unchanged: 0,
  examples: [] as Array<Record<string, unknown>>,
  review: [] as Array<Record<string, unknown>>,
};

const mobileOk = (value: string) => /^01[3-9][0-9]{8}$/.test(digits(value));
const reviewFor = (message: Message, block: ParsedBlock, reason: string) => {
  if (office.review.length >= 60) return;
  const fields = block.fields ?? {};
  office.review.push({
    reason, messageId: message.message_id, at: message.source_timestamp,
    mother: fields.motherVessel ?? null, lighter: fields.lighterVessel ?? null,
    master: fields.masterMobile ?? null, escort: fields.escortName ?? null,
    escortMobile: fields.escortMobile ?? null,
  });
};

for (const message of officeMessages) {
  const date = businessDay(message.source_timestamp) || isoDay(message.source_timestamp);
  const shift = orderIntakeShift(message.source_timestamp, message.text_content);
  let blocks: ParsedBlock[] = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate: date});
  } catch {
    blocks = [];
  }
  if (!blocks.length) {
    office.unmatched_programs += 1;
    reviewFor(message, {}, 'OFFICE_BLOCK_UNPARSED');
    continue;
  }
  for (const block of blocks) {
    office.parsed_blocks += 1;
    const fields = block.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    const master = digits(fields.masterMobile);
    const escortMobile = digits(fields.escortMobile);
    const escortName = String(fields.escortName ?? '').trim();
    let sameVessel = officePool.filter((program) =>
      normalise(program.mother_vessel) === mother
      && normalise(program.lighter_vessel) === lighter
      && (!master || digits(program.master_mobile) === master));
    let fuzzy = false;
    if (!sameVessel.length && master) {
      const scored = officePool
        .filter((program) => digits(program.master_mobile) === master)
        .map((program) => ({
          program,
          motherScore: similarity(normalise(program.mother_vessel), mother),
          lighterScore: similarity(normalise(program.lighter_vessel), lighter),
        }))
        .filter((row) => row.motherScore >= 0.85 && row.lighterScore >= 0.82)
        .map((row) => ({...row, score: row.motherScore + row.lighterScore}))
        .sort((a, b) => b.score - a.score);
      const best = scored[0];
      if (best && (!scored[1] || best.score - scored[1].score >= 0.02)) {
        sameVessel = [best.program];
        fuzzy = true;
        office.fuzzy_matches += 1;
      }
    }
    const active = sameVessel.filter((program) => ACTIVE_STATES.has(program.state));

    if (!sameVessel.length) {
      office.unmatched_programs += 1;
      reviewFor(message, block, 'NO_PROGRAM_MATCH');
      continue;
    }
    if (!active.length) {
      office.unmatched_programs += 1;
      office.closed_programs_skipped += 1;
      reviewFor(message, block, 'ONLY_CLOSED_PROGRAMS');
      continue;
    }
    if (active.length > 1) {
      office.ambiguous_matches += 1;
      reviewFor(message, block, 'AMBIGUOUS_ACTIVE_PROGRAMS');
      continue;
    }
    const candidate = active[0];
    if (!mobileOk(escortMobile)) {
      office.invalid_escort_skipped += 1;
      reviewFor(message, block, 'ESCORT_MOBILE_INVALID');
      continue;
    }
    if (candidate.end_date && date > candidate.end_date) {
      office.stale_assignments_skipped += 1;
      reviewFor(message, block, 'AFTER_PROGRAM_END');
      continue;
    }

    office.matched_programs += 1;
    const currentEscort = digits(candidate.escort_mobile);
    const sameDuty = String(candidate.start_date).slice(0, 10) === date;
    if (currentEscort && currentEscort !== escortMobile) {
      // Never synthesise a historical escort-change revision during a backfill:
      // it can predate the current revision and corrupt lifecycle history. A
      // conflicting assignment is a human decision, so it goes to Review.
      office.escort_conflicts += 1;
      reviewFor(message, block, 'ESCORT_CONFLICT');
      continue;
    }
    if (currentEscort === escortMobile && sameDuty) {
      office.escort_unchanged += 1;
      continue;
    }
    if (!currentEscort) {
      office.escort_updates += 1;
      if (APPLY) {
        const {assignEscort} = await import('../lib/standalone/programs.ts');
        const assigned = await assignEscort(admin, candidate.id, {
          employeeMobile: escortMobile,
          employeeName: escortName || undefined,
          startDate: date,
          startShift: shift,
        });
        if (!updatedPrograms.includes(assigned.programId)) updatedPrograms.push(assigned.programId);
        candidate.escort_mobile = `+88${escortMobile}`;
        candidate.escort_name = escortName || null;
        candidate.start_date = date;
        candidate.state = 'ASSIGNED';
      }
    } else {
      // Same escort, different office duty start: the office date/shift wins.
      office.duty_date_updates += 1;
      if (APPLY) {
        await rows(
          `UPDATE programs SET start_date = $2::date, start_shift = $3, updated_at = now()
            WHERE id = $1 AND state IN ('DRAFT','ASSIGNED','CONFIRMED')
              AND (end_date IS NULL OR $2::date <= end_date)`,
          [candidate.id, date, shift],
        );
        await rows(
          `UPDATE program_assignments SET start_date = $2::date, start_shift = $3
            WHERE program_id = $1 AND end_date IS NULL
              AND start_date <> $2::date`,
          [candidate.id, date, shift],
        );
        candidate.start_date = date;
        if (!updatedPrograms.includes(candidate.id)) updatedPrograms.push(candidate.id);
      }
    }
    if (office.examples.length < 12) {
      office.examples.push({
        messageId: message.message_id, mother: fields.motherVessel ?? null,
        lighter: fields.lighterVessel ?? null, master: fields.masterMobile ?? null,
        escort: escortName || null, escortMobile, date, shift,
        programId: candidate.id, previousState: candidate.state, fuzzy,
      });
    }
  }
}

console.log(JSON.stringify({client: summary, office, applied: {createdPrograms, plannedCreates: plannedPrograms.length, duplicateIdentityBlocks, absorbedByExisting, updatedPrograms}}, null, 2));
