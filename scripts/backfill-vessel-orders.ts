#!/usr/bin/env node
// Escort order / office-assignment backfill audit. Dry-run by default.
//
// Source of truth: WA-01 mirrored Bridge-1 messages for the four Owner escort
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
  '8801923008877@s.whatsapp.net', '94107162673310@lid',
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
const distance = (a: string, b: string) => {
  if (a === b) return 0;
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
  return prev[b.length];
};
// Owner rule: a vessel name may carry up to three small typos and still be the
// same vessel. A trailing serial (CITY-14 / KASHFUL 2) must match exactly, so a
// typo can never turn one lighter into a different numbered lighter.
const serialOf = (key: string) => key.match(/(\d+)$/)?.[1] ?? '';
const baseOf = (key: string) => key.replace(/\d+$/, '');
const vesselLike = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = serialOf(a);
  const sb = serialOf(b);
  // A missing serial on one side is tolerated; two different serials are not.
  if (sa && sb && sa !== sb) return false;
  return distance(baseOf(a), baseOf(b)) <= 3;
};
// A master mobile typed one or two digits wrong is still the same order; the
// stored value is never rewritten from a fuzzy match.
const mobileLike = (a: string, b: string) => {
  if (!a || !b || a === b) return true;
  if (a.length !== 11 || b.length !== 11) return false;
  let diff = 0;
  for (let i = 0; i < 11; i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
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
const bySource = new Map<string, Program[]>();
for (const program of programs) {
  if (!program.source_message_id) continue;
  const list = bySource.get(program.source_message_id) ?? [];
  list.push(program);
  bySource.set(program.source_message_id, list);
}

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
    // Match the block, not just the message: one order message can contain
    // several lighters, and the first block must not hide the rest.
    const existing = (bySource.get(message.message_id) ?? []).find((program) =>
      vesselLike(normalise(program.lighter_vessel), lighter)
      && vesselLike(normalise(program.mother_vessel), mother))
      ?? programs.find((program) =>
        vesselLike(normalise(program.mother_vessel), mother)
        && vesselLike(normalise(program.lighter_vessel), lighter)
        && mobileLike(digits(program.master_mobile), master)
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

const vessels = await rows<{vessel_name: string; vessel_type: string}>(
  'SELECT vessel_name, vessel_type FROM vessels',
);
const canonicalVessel = (name: string, type: 'mother' | 'lighter') => {
  const key = normalise(name);
  const matches = vessels.filter((vessel) =>
    vessel.vessel_type === type && vesselLike(normalise(vessel.vessel_name), key));
  return matches.length === 1 ? matches[0].vessel_name : null;
};

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

type ChangeMessage = Message & {quoted_message_id: string | null};
const changeMessages = await rows<ChangeMessage>(
  `SELECT message_id, chat_jid, source_timestamp::text AS source_timestamp, text_content,
          quoted_message_id
     FROM whatsapp_messages
    WHERE account_id = 'wa-01'
      AND chat_jid = $1
      AND direction = 'INCOMING'
      AND source_timestamp >= $2::date
      AND source_timestamp < ($3::date + interval '1 day')
      AND text_content ~* 'escort'
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
  closed_matched: 0,
  closed_history_conflicts: 0,
  outside_duty_window: 0,
  invalid_escort_skipped: 0,
  escort_conflicts: 0,
  escort_updates: 0,
  duty_date_updates: 0,
  escort_unchanged: 0,
  change_notices: 0,
  escort_replacements: 0,
  superseded_messages: 0,
  duplicate_twin_skipped: 0,
  escort_changes: 0,
  five_day_reviews: 0,
  change_updates: 0,
  change_unchanged: 0,
  change_unresolved: 0,
  repaired_names: [] as Array<Record<string, unknown>>,
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
const previousShift = (day: string, shift: string) => {
  if (shift === 'D') {
    const value = new Date(`${day}T00:00:00Z`);
    value.setUTCDate(value.getUTCDate() - 1);
    return {date: value.toISOString().slice(0, 10), shift: 'N'};
  }
  return {date: day, shift: 'D'};
};

// ---------------------------------------------------------------------------
// Escort-change notices. The office sends a short header that quotes the
// original assignment, then a detail line with name/mobile/start/shift. The
// detail has no vessel identity of its own, so the quote is the join key.
// Applying it closes the previous row at the shift before the new start and
// inserts a new row for the same vessel, exactly like a live escort change.
// ---------------------------------------------------------------------------
const consumedByChange = new Set<string>();
const noticeVessels: Array<{mother: string; lighter: string; at: number}> = [];
const text = (message: {text_content: string | null}) => String(message.text_content ?? '');
const isChangeMarker = (value: string) => /escort\s*[=\-—]*\s*change/i.test(value);
const isChangeDetail = (value: string) =>
  /escort\s*name/i.test(value) && /escort\s*(?:mobile|mob)/i.test(value)
  && /start/i.test(value) && !/mother\s*vessel/i.test(value);
const changeDateOf = (value: string) => {
  const match = value.match(/start\s*[:\-]*\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/i);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};
const changeShiftOf = (value: string) => {
  const match = value.match(/shift\s*[:\-]*\s*\(?\s*(D|N|Day|Night)/i);
  return match ? match[1][0].toUpperCase() : null;
};
const nameOf = (value: string) => {
  const match = value.match(/escort\s*name\s*[:\-]*\s*([^\n]+)/i);
  return match ? match[1].trim().replace(/[.,;]+$/, '') : '';
};
const mobileOf = (value: string) => {
  const match = value.match(/escort\s*(?:mobile|mob)\s*[:\-]*\s*([^\n]+)/i);
  return match ? digits(match[1]).slice(0, 11) : '';
};

const quoteIds = [...new Set(changeMessages.map((message) => message.quoted_message_id).filter(Boolean))] as string[];
const quotedMessages = quoteIds.length
  ? await rows<Message>(
      `SELECT message_id, chat_jid, source_timestamp::text AS source_timestamp, text_content
         FROM whatsapp_messages
        WHERE account_id = 'wa-01' AND message_id = ANY($1::text[])`,
      [quoteIds],
    )
  : [];
const quotedById = new Map(quotedMessages.map((message) => [message.message_id, message]));
// A header-only change notice (no detail line) still marks the vessel as a
// change, so a following template is treated as a two-row escort change.
for (const message of changeMessages) {
  if (!message.quoted_message_id || isChangeDetail(text(message)) || !isChangeMarker(text(message))) continue;
  const quoted = quotedById.get(message.quoted_message_id);
  if (!quoted) continue;
  try {
    const block = parseEscortOrder(text(quoted), {
      messageDate: businessDay(quoted.source_timestamp) || isoDay(quoted.source_timestamp),
    })[0];
    const mother = normalise(block?.fields?.motherVessel);
    const lighter = normalise(block?.fields?.lighterVessel);
    if (mother && lighter) {
      noticeVessels.push({mother, lighter, at: new Date(message.source_timestamp).getTime()});
    }
  } catch {
    // A quote that cannot be parsed is not a vessel marker.
  }
}

for (let index = 0; index < changeMessages.length; index++) {
  const message = changeMessages[index];
  const value = text(message);
  if (!isChangeDetail(value)) continue;
  consumedByChange.add(message.message_id);
  office.change_notices += 1;
  const day = changeDateOf(value);
  if (!day) {
    office.change_unresolved += 1;
    reviewFor(message, {}, 'ESCORT_CHANGE_NO_START');
    continue;
  }
  const shift = changeShiftOf(value) ?? orderIntakeShift(message.source_timestamp, message.text_content);
  const escortName = nameOf(value);
  const escortMobile = mobileOf(value);
  if (!mobileOk(escortMobile)) {
    office.change_unresolved += 1;
    reviewFor(message, {}, 'ESCORT_CHANGE_MOBILE_INVALID');
    continue;
  }
  // Nearest earlier header from the same sender that quotes the assignment.
  let header: ChangeMessage | null = null;
  for (let back = index - 1; back >= 0 && back >= index - 20; back--) {
    const previous = changeMessages[back];
    const at = new Date(previous.source_timestamp).getTime();
    if (new Date(message.source_timestamp).getTime() - at > 24 * 3600 * 1000) break;
    if (previous.chat_jid !== message.chat_jid) continue;
    if (!previous.quoted_message_id) continue;
    if (isChangeMarker(text(previous)) && !isChangeDetail(text(previous))) {
      header = previous;
      break;
    }
  }
  const quoted = header?.quoted_message_id ? quotedById.get(header.quoted_message_id) : null;
  if (!quoted) {
    office.change_unresolved += 1;
    reviewFor(message, {}, 'ESCORT_CHANGE_NO_VESSEL');
    continue;
  }
  let quotedBlocks: ParsedBlock[] = [];
  try {
    quotedBlocks = parseEscortOrder(text(quoted), {
      messageDate: businessDay(quoted.source_timestamp) || isoDay(quoted.source_timestamp),
    });
  } catch {
    quotedBlocks = [];
  }
  const quotedFields = quotedBlocks[0]?.fields ?? {};
  const mother = normalise(quotedFields.motherVessel);
  const lighter = normalise(quotedFields.lighterVessel);
  const master = digits(quotedFields.masterMobile);
  if (!mother || !lighter) {
    office.change_unresolved += 1;
    reviewFor(message, {}, 'ESCORT_CHANGE_QUOTE_UNPARSED');
    continue;
  }
  noticeVessels.push({mother, lighter, at: new Date(message.source_timestamp).getTime()});
  // The quoted template can glue two master mobiles; only trust it when it is
  // a single value (the parser flags the glued form).
  const masterTrusted = master && !(quotedBlocks[0]?.reasons ?? []).includes('MULTIPLE_MOBILES_FIRST_USED');
  const exactVessel = officePool.filter((program) =>
    normalise(program.mother_vessel) === mother
    && normalise(program.lighter_vessel) === lighter
    && (!masterTrusted || mobileLike(digits(program.master_mobile), master)));
  const fuzzyRows = officePool.filter((program) =>
    vesselLike(normalise(program.mother_vessel), mother)
    && vesselLike(normalise(program.lighter_vessel), lighter)
    && (!masterTrusted || mobileLike(digits(program.master_mobile), master)));
  const coversDay = (program: Program) =>
    String(program.start_date) <= day && (!program.end_date || day <= String(program.end_date));
  // An exact row that is active and covers the change date wins outright; only
  // widen to spelling-tolerant rows when the exact set has no live candidate.
  const exactLive = exactVessel.filter((program) => ACTIVE_STATES.has(program.state) && coversDay(program));
  const sameVessel = exactLive.length === 1
    ? exactVessel
    : [...new Map([...exactVessel, ...fuzzyRows].map((program) => [program.id, program])).values()];
  const covering = sameVessel.filter(coversDay);
  const active = covering.filter((program) => ACTIVE_STATES.has(program.state));
  const candidate = active.length === 1 ? active[0] : covering.length === 1 ? covering[0] : null;
  if (!candidate || !ACTIVE_STATES.has(candidate.state)) {
    office.change_unresolved += 1;
    reviewFor(message, {
      fields: {motherVessel: quotedFields.motherVessel, lighterVessel: quotedFields.lighterVessel,
        masterMobile: quotedFields.masterMobile, escortName, escortMobile},
    }, candidate ? 'ESCORT_CHANGE_ON_CLOSED_ROW' : 'ESCORT_CHANGE_NO_ACTIVE_ROW');
    continue;
  }
  if (digits(candidate.escort_mobile) === escortMobile && String(candidate.start_date).slice(0, 10) === day) {
    office.change_unchanged += 1;
    continue;
  }
  office.change_updates += 1;
  // Repair only an obvious canonical-name typo on the row being continued, so
  // the new row does not inherit it. Anything ambiguous is left untouched.
  const motherName = canonicalVessel(candidate.mother_vessel, 'mother');
  const lighterName = canonicalVessel(candidate.lighter_vessel, 'lighter');
  if (APPLY && ((motherName && motherName !== candidate.mother_vessel)
    || (lighterName && lighterName !== candidate.lighter_vessel))) {
    await rows(
      `UPDATE programs SET mother_vessel = COALESCE($2, mother_vessel),
                           lighter_vessel = COALESCE($3, lighter_vessel), updated_at = now()
        WHERE id = $1`,
      [candidate.id, motherName, lighterName],
    );
    office.repaired_names.push({
      programId: candidate.id, from: `${candidate.mother_vessel} / ${candidate.lighter_vessel}`,
      to: `${motherName ?? candidate.mother_vessel} / ${lighterName ?? candidate.lighter_vessel}`,
    });
    if (motherName) candidate.mother_vessel = motherName;
    if (lighterName) candidate.lighter_vessel = lighterName;
  }
  let changeRowId = `planned-change:${message.message_id}`;
  if (APPLY) {
    const {assignEscort} = await import('../lib/standalone/programs.ts');
    const assigned = await tx((client) => assignEscort(admin, candidate.id, {
      employeeMobile: escortMobile,
      employeeName: escortName || undefined,
      startDate: day,
      startShift: shift,
    }, client));
    changeRowId = assigned.programId;
    if (!updatedPrograms.includes(assigned.programId)) updatedPrograms.push(assigned.programId);
  }
  // Model the new revision in memory for the remaining messages in this run.
  const closed = previousShift(day, shift);
  candidate.end_date = closed.date;
  candidate.state = 'WITHDRAWN';
  officePool.push({
    ...candidate,
    id: changeRowId,
    escort_name: escortName || null,
    escort_mobile: escortMobile,
    start_date: day,
    end_date: null,
    state: 'CONFIRMED',
  });
  if (office.examples.length < 12) {
    office.examples.push({
      kind: 'ESCORT_CHANGE', messageId: message.message_id,
      mother: quotedFields.motherVessel ?? null, lighter: quotedFields.lighterVessel ?? null,
      master: quotedFields.masterMobile ?? null, escort: escortName, escortMobile,
      date: day, shift, programId: candidate.id, previousEnd: closed,
    });
  }
}

// Two assignment messages for the same vessel/date/shift are one decision: the
// last message wins. Precompute that winner so an older message can never
// rewrite the row backwards on a later run.
const latestByDutyKey = new Map<string, number>();
for (const message of officeMessages) {
  const messageDate = businessDay(message.source_timestamp) || isoDay(message.source_timestamp);
  let blocks: ParsedBlock[] = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate});
  } catch {
    blocks = [];
  }
  for (const block of blocks) {
    const fields = block.fields ?? {};
    const dutyDate = block.assignmentDate && /^\d{4}-\d{2}-\d{2}$/.test(block.assignmentDate)
      ? block.assignmentDate : messageDate;
    const dutyShift = block.shift === 'D' || block.shift === 'N'
      ? block.shift : orderIntakeShift(message.source_timestamp, message.text_content);
    const key = `${normalise(fields.motherVessel)}|${normalise(fields.lighterVessel)}|${dutyDate}|${dutyShift}`;
    const at = new Date(message.source_timestamp).getTime();
    latestByDutyKey.set(key, Math.max(latestByDutyKey.get(key) ?? 0, at));
  }
}

for (const message of officeMessages) {
  if (consumedByChange.has(message.message_id)) continue;
  const messageDate = businessDay(message.source_timestamp) || isoDay(message.source_timestamp);
  let blocks: ParsedBlock[] = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate});
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
    const masterTrusted = !!master && !(block.reasons ?? []).includes('MULTIPLE_MOBILES_FIRST_USED');
    const escortMobile = digits(fields.escortMobile);
    const escortName = String(fields.escortName ?? '').trim();
    // The office template carries the real duty start ("28/10/26 ((D)") even
    // when the message is forwarded the night before. That date/shift wins.
    const dutyDate = block.assignmentDate && /^\d{4}-\d{2}-\d{2}$/.test(block.assignmentDate)
      ? block.assignmentDate
      : messageDate;
    const dutyShift = block.shift === 'D' || block.shift === 'N'
      ? block.shift
      : orderIntakeShift(message.source_timestamp, message.text_content);
    const dutyKey = `${mother}|${lighter}|${dutyDate}|${dutyShift}`;
    if ((latestByDutyKey.get(dutyKey) ?? 0) > new Date(message.source_timestamp).getTime()) {
      office.superseded_messages += 1;
      continue;
    }
    const exactVessel = officePool.filter((program) =>
      normalise(program.mother_vessel) === mother
      && normalise(program.lighter_vessel) === lighter
      && (!masterTrusted || mobileLike(digits(program.master_mobile), master)));
    const fuzzyRows = officePool.filter((program) =>
      vesselLike(normalise(program.mother_vessel), mother)
      && vesselLike(normalise(program.lighter_vessel), lighter)
      && (!masterTrusted || mobileLike(digits(program.master_mobile), master)));
    const coversDuty = (program: Program) =>
      String(program.start_date) <= dutyDate && (!program.end_date || dutyDate <= String(program.end_date));
    const exactLive = exactVessel.filter((program) => ACTIVE_STATES.has(program.state) && coversDuty(program));
    const sameVessel = exactLive.length === 1
      ? exactVessel
      : [...new Map([...exactVessel, ...fuzzyRows].map((program) => [program.id, program])).values()];
    const fuzzy = fuzzyRows.some((program) => !exactVessel.includes(program));
    if (fuzzy) office.fuzzy_matches += 1;

    if (!sameVessel.length) {
      office.unmatched_programs += 1;
      reviewFor(message, block, 'NO_PROGRAM_MATCH');
      continue;
    }
    const covering = sameVessel.filter(coversDuty);
    if (!covering.length) {
      office.outside_duty_window += 1;
      reviewFor(message, block, 'OUTSIDE_DUTY_WINDOW');
      continue;
    }
    const active = covering.filter((program) => ACTIVE_STATES.has(program.state));
    if (active.length > 1 || (active.length === 0 && covering.length > 1)) {
      office.ambiguous_matches += 1;
      reviewFor(message, block, 'AMBIGUOUS_DUTY_ROWS');
      continue;
    }
    const candidate = active[0] ?? covering[0];
    if (!ACTIVE_STATES.has(candidate.state)) {
      // The row is already in the database and its duty window covers this
      // message; a closed row is history, never a reason to revive or rewrite.
      office.closed_matched += 1;
      if (digits(candidate.escort_mobile) && digits(candidate.escort_mobile) !== escortMobile) {
        office.closed_history_conflicts += 1;
        reviewFor(message, block, 'CLOSED_ROW_ESCORT_CONFLICT');
      }
      continue;
    }
    if (!mobileOk(escortMobile)) {
      office.invalid_escort_skipped += 1;
      reviewFor(message, block, 'ESCORT_MOBILE_INVALID');
      continue;
    }
    // A closed twin with the same vessel, escort and duty date already records
    // this assignment. Never duplicate it onto a leftover active row.
    const twin = sameVessel.find((program) =>
      program.id !== candidate.id
      && digits(program.escort_mobile) === escortMobile
      && String(program.start_date).slice(0, 10) === dutyDate);
    if (twin && !digits(candidate.escort_mobile)) {
      office.duplicate_twin_skipped += 1;
      continue;
    }
    office.matched_programs += 1;
    const currentEscort = digits(candidate.escort_mobile);
    const sameDuty = String(candidate.start_date).slice(0, 10) === dutyDate;
    const messageTime = new Date(message.source_timestamp).getTime();
    const changeMarked = /escort\s*[=\-—]*\s*change/i.test(String(message.text_content ?? ''))
      || noticeVessels.some((notice) =>
        Math.abs(messageTime - notice.at) <= 24 * 3600 * 1000
        && vesselLike(notice.mother, mother) && vesselLike(notice.lighter, lighter));
    const dayGap = Math.abs(
      new Date(`${dutyDate}T00:00:00Z`).getTime()
      - new Date(`${String(candidate.start_date).slice(0, 10)}T00:00:00Z`).getTime(),
    ) / 86_400_000;
    if (!sameDuty && dayGap > 5 && !changeMarked) {
      office.five_day_reviews += 1;
      reviewFor(message, block, 'OUTSIDE_FIVE_DAY_WINDOW');
      continue;
    }
    if (currentEscort && currentEscort !== escortMobile) {
      if (changeMarked) {
        // The office explicitly announced a change: close the previous row at
        // the shift before the new start and insert the new escort's row.
        office.escort_changes += 1;
        let changeRowId = `planned-assign-change:${message.message_id}`;
        if (APPLY) {
          const {assignEscort} = await import('../lib/standalone/programs.ts');
          const assigned = await tx((client) => assignEscort(admin, candidate.id, {
            employeeMobile: escortMobile,
            employeeName: escortName || undefined,
            startDate: dutyDate,
            startShift: dutyShift,
          }, client));
          changeRowId = assigned.programId;
          if (!updatedPrograms.includes(assigned.programId)) updatedPrograms.push(assigned.programId);
        }
        const closed = previousShift(dutyDate, dutyShift);
        candidate.end_date = closed.date;
        candidate.state = 'WITHDRAWN';
        officePool.push({
          ...candidate,
          id: changeRowId,
          escort_name: escortName || null,
          escort_mobile: escortMobile,
          start_date: dutyDate,
          end_date: null,
          state: 'CONFIRMED',
        });
        if (office.examples.length < 12) {
          office.examples.push({
            kind: 'ESCORT_CHANGE', messageId: message.message_id,
            mother: fields.motherVessel ?? null, lighter: fields.lighterVessel ?? null,
            master: fields.masterMobile ?? null, escort: escortName, escortMobile,
            date: dutyDate, shift: dutyShift, programId: candidate.id, previousEnd: closed,
          });
        }
        continue;
      }
      // A bare assignment with a different escort is the Owner's "first escort
      // never boarded" case: one row, the second date/escort replaces it.
      office.escort_replacements += 1;
      if (APPLY) {
        await rows(
          `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
           VALUES ($1,$2,'escort','escort',$3) ON CONFLICT (employee_mobile) DO NOTHING`,
          [`+88${escortMobile}`, escortName || escortMobile, admin.id],
        );
        await rows(
          `UPDATE programs
              SET escort_mobile = $2, escort_name = $3,
                  start_date = $4::date, start_shift = $5,
                  state = CASE WHEN state = 'DRAFT' THEN 'ASSIGNED' ELSE state END,
                  revision = revision + 1, updated_at = now()
            WHERE id = $1`,
          [candidate.id, `+88${escortMobile}`, escortName || escortMobile, dutyDate, dutyShift],
        );
        await rows(
          `UPDATE program_assignments
              SET employee_mobile = $2, start_date = $3::date, start_shift = $4
            WHERE program_id = $1 AND end_date IS NULL`,
          [candidate.id, `+88${escortMobile}`, dutyDate, dutyShift],
        );
        await rows(
          `INSERT INTO program_events (program_id, action, actor, payload)
           VALUES ($1,'REPLACE_ASSIGNMENT',$2,$3::jsonb)`,
          [candidate.id, admin.id, JSON.stringify({
            employeeMobile: `+88${escortMobile}`, escortName,
            startDate: dutyDate, startShift: dutyShift, previousEscort: currentEscort,
            messageId: message.message_id,
          })],
        );
        if (!updatedPrograms.includes(candidate.id)) updatedPrograms.push(candidate.id);
      }
      candidate.escort_mobile = `+88${escortMobile}`;
      candidate.escort_name = escortName || escortMobile;
      candidate.start_date = dutyDate;
      if (candidate.state === 'DRAFT') candidate.state = 'ASSIGNED';
      continue;
    }
    if (currentEscort === escortMobile && sameDuty) {
      office.escort_unchanged += 1;
      continue;
    }
    if (currentEscort === escortMobile && dutyDate < String(candidate.start_date).slice(0, 10)) {
      office.escort_unchanged += 1;
      continue;
    }
    if (!currentEscort) {
      office.escort_updates += 1;
      if (APPLY) {
        const {assignEscort} = await import('../lib/standalone/programs.ts');
        const assigned = await tx((client) => assignEscort(admin, candidate.id, {
          employeeMobile: escortMobile,
          employeeName: escortName || undefined,
          startDate: dutyDate,
          startShift: dutyShift,
        }, client));
        if (!updatedPrograms.includes(assigned.programId)) updatedPrograms.push(assigned.programId);
      }
      candidate.escort_mobile = `+88${escortMobile}`;
      candidate.escort_name = escortName || null;
      candidate.start_date = dutyDate;
      candidate.state = 'ASSIGNED';
    } else {
      // Same escort, different office duty start: the office date/shift wins.
      office.duty_date_updates += 1;
      if (APPLY) {
        await rows(
          `UPDATE programs SET start_date = $2::date, start_shift = $3, updated_at = now()
            WHERE id = $1 AND state IN ('DRAFT','ASSIGNED','CONFIRMED')
              AND (end_date IS NULL OR $2::date <= end_date)`,
          [candidate.id, dutyDate, dutyShift],
        );
        await rows(
          `UPDATE program_assignments SET start_date = $2::date, start_shift = $3
            WHERE program_id = $1 AND end_date IS NULL
              AND start_date <> $2::date`,
          [candidate.id, dutyDate, dutyShift],
        );
        if (!updatedPrograms.includes(candidate.id)) updatedPrograms.push(candidate.id);
      }
      candidate.start_date = dutyDate;
    }
    if (office.examples.length < 12) {
      office.examples.push({
        kind: 'ASSIGNMENT', messageId: message.message_id, mother: fields.motherVessel ?? null,
        lighter: fields.lighterVessel ?? null, master: fields.masterMobile ?? null,
        escort: escortName || null, escortMobile, date: dutyDate, shift: dutyShift,
        programId: candidate.id, previousState: candidate.state, fuzzy,
      });
    }
  }
}

console.log(JSON.stringify({client: summary, office, applied: {createdPrograms, plannedCreates: plannedPrograms.length, duplicateIdentityBlocks, absorbedByExisting, updatedPrograms}}, null, 2));
