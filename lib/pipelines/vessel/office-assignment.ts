// Office-group escort assignment / escort-change intake.
//
// The office group is a control channel, never an order source: an assignment
// only updates a program that already exists from a client order. Unmatched
// messages go to Review and never create a program.
//
// Two shapes are accepted:
//   1. a full template (mother, lighter, master, escort, date/shift);
//   2. an "Escort Change" header that quotes the original assignment followed
//      by a detail line with escort name/mobile/start/shift and no vessel.
//
// Rules (Owner, 2026-11-22):
//   - bare difference in escort => one row, second escort/date wins;
//   - explicit "Escort Change" marker => close the old row at the previous
//     shift and insert the new escort's row;
//   - matching ignores case, spaces, punctuation and up to three letter typos,
//     but a lighter's trailing serial must match;
//   - the office date/shift is the duty start.

import {rows, tx, type Actor} from '../../standalone/db.ts';
import {assignEscort} from '../../standalone/programs.ts';
import {parseEscortOrder} from '../../escort-intake-candidate.mjs';
import {businessDay} from '../../vessel-match.ts';
import {orderIntakeShift} from '../../order-intake-shift.ts';

export const DEFAULT_OFFICE_GROUP_JID = '120363426895117693@g.us';

export const officeGroupJid = () => process.env.ALRIFAI_OFFICE_GROUP_JID || DEFAULT_OFFICE_GROUP_JID;

export type OfficeAssignmentMessage = {
  message_id: string;
  chat_jid: string;
  account_id: string;
  sender_jid: string | null;
  source_timestamp: string;
};

type Block = {
  fields?: Record<string, string | null | undefined>;
  assignmentDate?: string | null;
  shift?: string | null;
  reasons?: string[];
};

type Program = {
  id: string;
  mother_vessel: string;
  lighter_vessel: string;
  master_mobile: string | null;
  escort_name: string | null;
  escort_mobile: string | null;
  state: string;
  start_date: string;
  end_date: string | null;
};

export type OfficeAssignmentResult = {
  applied: boolean;
  idempotent: boolean;
  change: boolean;
  review: {reason: string; fields: Record<string, unknown>} | null;
  reasons: string[];
};

const digits = (value: unknown) => String(value ?? '')
  .replace(/[^0-9]/g, '')
  .replace(/^880(1[3-9][0-9]{8})$/, '0$1');
const normalise = (value: unknown) => String(value ?? '')
  .replace(/^m\.?\s*v\.?\s*/i, '')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .toLowerCase();
const serialOf = (key: string) => key.match(/(\d+)$/)?.[1] ?? '';
const baseOf = (key: string) => key.replace(/\d+$/, '');
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
const vesselLike = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = serialOf(a);
  const sb = serialOf(b);
  if (sa && sb && sa !== sb) return false;
  return distance(baseOf(a), baseOf(b)) <= 3;
};
const mobileLike = (a: string, b: string) => {
  if (!a || !b || a === b) return true;
  if (a.length !== 11 || b.length !== 11) return false;
  let diff = 0;
  for (let i = 0; i < 11; i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
};
const mobileOk = (value: string) => /^01[3-9][0-9]{8}$/.test(value);
const isoDay = (value: unknown) => {
  const parsed = new Date(String(value ?? ''));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);
};
const textOf = (value: string | null | undefined) => String(value ?? '');
const isMarker = (value: string) => /escort\s*[=\-—]*\s*change/i.test(value);
const isDetail = (value: string) =>
  /escort\s*name/i.test(value) && /escort\s*(?:mobile|mob)/i.test(value)
  && /start/i.test(value) && !/mother\s*vessel/i.test(value);
const detailDate = (value: string) => {
  const match = value.match(/start\s*[:\-]*\s*(\d{1,2})[-\/.](\d{1,2})[-\/.](\d{2,4})/i);
  if (!match) return null;
  const year = match[3].length === 2 ? `20${match[3]}` : match[3];
  return `${year}-${match[2].padStart(2, '0')}-${match[1].padStart(2, '0')}`;
};
const detailShift = (value: string) => {
  const match = value.match(/shift\s*[:\-]*\s*\(?\s*(D|N|Day|Night)/i);
  return match ? match[1][0].toUpperCase() : null;
};
const detailName = (value: string) => {
  const match = value.match(/escort\s*name\s*[:\-]*\s*([^\n]+)/i);
  return match ? match[1].trim().replace(/[.,;]+$/, '') : '';
};
const detailMobile = (value: string) => {
  const match = value.match(/escort\s*(?:mobile|mob)\s*[:\-]*\s*([^\n]+)/i);
  return match ? digits(match[1]).slice(0, 11) : '';
};

type Identity = {
  mother: string;
  lighter: string;
  master: string;
  masterTrusted: boolean;
  escortName: string;
  escortMobile: string;
  dutyDate: string;
  dutyShift: string;
  marked: boolean;
};

async function identityFor(message: OfficeAssignmentMessage, text: string): Promise<Identity | null> {
  const messageDate = businessDay(message.source_timestamp) || isoDay(message.source_timestamp);

  if (isDetail(text)) {
    // Find the header that quotes the original assignment.
    const header = await rows<{message_id: string; quoted_message_id: string | null}>(`
      SELECT message_id, quoted_message_id
        FROM whatsapp_messages
       WHERE account_id = $1 AND chat_jid = $2 AND direction = 'INCOMING'
         AND source_timestamp <= $3::timestamptz
         AND source_timestamp >= $3::timestamptz - interval '24 hours'
         AND quoted_message_id IS NOT NULL
         AND text_content ~* 'escort\\s*[=\\-]*\\s*change'
       ORDER BY source_timestamp DESC
       LIMIT 1`,
      [message.account_id, message.chat_jid, message.source_timestamp],
    );
    const quote = header[0]?.quoted_message_id
      ? await rows<{text_content: string | null; source_timestamp: string}>(`
          SELECT text_content, source_timestamp::text AS source_timestamp
            FROM whatsapp_messages
           WHERE account_id = $1 AND message_id = $2
           LIMIT 1`,
        [message.account_id, header[0].quoted_message_id])
      : [];
    const quoted = quote[0];
    if (!quoted) return null;
    const block = (parseEscortOrder(textOf(quoted.text_content), {
      messageDate: isoDay(quoted.source_timestamp),
    }) as Block[])[0];
    const fields = block?.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    const escortMobile = detailMobile(text);
    const dutyDate = detailDate(text);
    if (!mother || !lighter || !mobileOk(escortMobile) || !dutyDate) return null;
    return {
      mother, lighter, master: digits(fields.masterMobile),
      masterTrusted: !(block?.reasons ?? []).includes('MULTIPLE_MOBILES_FIRST_USED'),
      escortName: detailName(text), escortMobile,
      dutyDate, dutyShift: (detailShift(text) ?? orderIntakeShift(message.source_timestamp, text)) as string,
      marked: true,
    };
  }

  let blocks: Block[] = [];
  try {
    blocks = parseEscortOrder(text, {messageDate}) as Block[];
  } catch {
    blocks = [];
  }
  const block = blocks.find((candidate) => candidate.fields?.motherVessel && candidate.fields?.lighterVessel);
  if (!block) return null;
  const fields = block.fields ?? {};
  const escortMobile = digits(fields.escortMobile ?? fields.employeeMobile);
  const escortName = String(fields.escortName ?? '').trim();
  if (!mobileOk(escortMobile)) return null;
  return {
    mother: normalise(fields.motherVessel),
    lighter: normalise(fields.lighterVessel),
    master: digits(fields.masterMobile),
    masterTrusted: !(block.reasons ?? []).includes('MULTIPLE_MOBILES_FIRST_USED'),
    escortName, escortMobile,
    dutyDate: block.assignmentDate && /^\d{4}-\d{2}-\d{2}$/.test(block.assignmentDate)
      ? block.assignmentDate : messageDate,
    dutyShift: block.shift === 'D' || block.shift === 'N'
      ? block.shift : orderIntakeShift(message.source_timestamp, text),
    marked: isMarker(text),
  };
}

export async function handleOfficeAssignment(
  actor: Actor,
  message: OfficeAssignmentMessage,
  text: string,
): Promise<OfficeAssignmentResult> {
  const identity = await identityFor(message, text);
  if (!identity) {
    return {applied: false, idempotent: false, change: false, review: null, reasons: ['NOT_AN_ASSIGNMENT']};
  }
  const {mother, lighter, master, masterTrusted, escortMobile, dutyDate, dutyShift, marked} = identity;

  const pool = await rows<Program>(`
    SELECT id, mother_vessel, lighter_vessel, master_mobile, escort_name, escort_mobile, state,
           start_date::text AS start_date, end_date::text AS end_date
      FROM programs
     WHERE state IN ('DRAFT','ASSIGNED','CONFIRMED')
       AND start_date BETWEEN $1::date - 90 AND $1::date + 90
     ORDER BY start_date DESC
     LIMIT 500`,
    [dutyDate],
  );
  const vessel = pool.filter((program) =>
    vesselLike(normalise(program.mother_vessel), mother)
    && vesselLike(normalise(program.lighter_vessel), lighter)
    && (!masterTrusted || mobileLike(digits(program.master_mobile), master)));
  const covering = vessel.filter((program) =>
    String(program.start_date) <= dutyDate && (!program.end_date || dutyDate <= String(program.end_date)));

  if (!vessel.length) {
    return {applied: false, idempotent: false, change: false,
      review: {reason: 'OFFICE_ASSIGNMENT_NO_PROGRAM', fields: {mother, lighter, master, escortMobile, dutyDate, dutyShift}}, reasons: ['NO_PROGRAM_MATCH']};
  }
  if (covering.length !== 1) {
    return {applied: false, idempotent: false, change: false,
      review: {reason: covering.length ? 'OFFICE_ASSIGNMENT_AMBIGUOUS' : 'OFFICE_ASSIGNMENT_OUTSIDE_DUTY',
        fields: {mother, lighter, master, escortMobile, dutyDate, dutyShift, covering: covering.length}},
      reasons: [covering.length ? 'AMBIGUOUS_DUTY_ROWS' : 'OUTSIDE_DUTY_WINDOW']};
  }
  const program = covering[0];
  const currentEscort = digits(program.escort_mobile);
  if (currentEscort === escortMobile && String(program.start_date).slice(0, 10) === dutyDate
    && String(program.start_date) <= dutyDate) {
    return {applied: false, idempotent: true, change: false, review: null, reasons: ['UNCHANGED']};
  }
  const gap = Math.abs(
    new Date(`${dutyDate}T00:00:00Z`).getTime()
    - new Date(`${String(program.start_date).slice(0, 10)}T00:00:00Z`).getTime(),
  ) / 86_400_000;
  if (gap > 5 && !marked) {
    return {applied: false, idempotent: false, change: false,
      review: {reason: 'OFFICE_ASSIGNMENT_OUTSIDE_FIVE_DAYS', fields: {mother, lighter, master, escortMobile, dutyDate, dutyShift}},
      reasons: ['OUTSIDE_FIVE_DAY_WINDOW']};
  }

  const change = marked && !!currentEscort && currentEscort !== escortMobile;
  await tx((client) => assignEscort(actor, program.id, {
    employeeMobile: escortMobile,
    employeeName: identity.escortName || undefined,
    startDate: dutyDate,
    startShift: dutyShift,
    replaceOnly: !change,
  }, client));
  return {applied: true, idempotent: false, change, review: null,
    reasons: [change ? 'ESCORT_CHANGE_APPLIED' : 'ASSIGNMENT_REPLACED']};
}
