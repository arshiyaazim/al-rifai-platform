// Order draft projection for the Admin workspace.
//
// The message router stores an authorized WA-01 order as a DRAFT vessel
// program. The Owner draft layout already exists in order-draft-template.ts,
// but until now nothing read a program/review record to render it. This module
// is the missing, read-only projection:
//
//   DRAFT program / PROGRAM review item → exact Owner draft text + gaps
//
// It never sends, writes, assigns or confirms. Delivery is a separate step and
// is currently MANUAL_COPY_ONLY (no outbound WhatsApp sender is enabled).

import {orderDraftDateAndShift} from './shift-boundary.ts';
import {renderOwnerDraftFields} from './order-draft-template.ts';

/** The draft is prepared in the Admin UI; nothing is transmitted automatically. */
export const OWNER_DRAFT_DELIVERY = 'MANUAL_COPY_ONLY';

export type OrderDraftRecord = {
  motherVessel?: string | null;
  lighterVessel?: string | null;
  masterMobile?: string | null;
  destination?: string | null;
  /** ISO `YYYY-MM-DD`; `DD-MM-YYYY` / `DD/MM/YY` are also accepted. */
  date?: string | null;
  shift?: string | null;
  sourceMessageId?: string | null;
  /** Verified WhatsApp timestamp, used only when date/shift are absent. */
  sourceTimestamp?: string | null;
};

export type OrderDraftResult = {
  /** Exact Owner layout, or null when a required field is missing. */
  text: string | null;
  /** Machine-readable blocking gaps, e.g. MISSING_MASTER_MOBILE. */
  gaps: string[];
  /** Human-readable notes for the Admin workspace. */
  warnings: string[];
  sourceMessageId: string | null;
  delivery: typeof OWNER_DRAFT_DELIVERY;
};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Accept the date shapes that actually occur in WA-01 orders. */
export function normalizeDraftDate(value: unknown): string {
  const raw = clean(value);
  if (!raw) return '';
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (iso) return validYmd(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? raw : '';
  const local = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})$/.exec(raw);
  if (!local) return '';
  const day = Number(local[1]);
  const month = Number(local[2]);
  const year = local[3].length === 2 ? 2000 + Number(local[3]) : Number(local[3]);
  return validYmd(year, month, day) ? `${year}-${pad(month)}-${pad(day)}` : '';
}

function validYmd(year: number, month: number, day: number): boolean {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return false;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Accept `D`, `N`, `Day`, `Night` (case-insensitive). Nothing else. */
export function normalizeDraftShift(value: unknown): 'D' | 'N' | '' {
  const raw = clean(value).toUpperCase();
  if (raw === 'D' || raw === 'DAY') return 'D';
  if (raw === 'N' || raw === 'NIGHT') return 'N';
  return '';
}

/**
 * Project one order record into the Owner draft. A missing Mother Vessel,
 * Lighter Vessel, Master Mobile, date or shift blocks the draft rather than
 * rendering an invented or blank required field.
 */
export function ownerDraftFromRecord(record: OrderDraftRecord): OrderDraftResult {
  let date = normalizeDraftDate(record.date);
  let shift = normalizeDraftShift(record.shift);
  if ((!date || !shift) && record.sourceTimestamp) {
    const derived = orderDraftDateAndShift(record.sourceTimestamp);
    if (derived) {
      date = date || derived.date;
      shift = shift || derived.shift;
    }
  }

  const gaps: string[] = [];
  if (!clean(record.motherVessel)) gaps.push('MISSING_MOTHER_VESSEL');
  if (!clean(record.lighterVessel)) gaps.push('MISSING_LIGHTER_VESSEL');
  if (!clean(record.masterMobile)) gaps.push('MISSING_MASTER_MOBILE');
  if (!date) gaps.push('MISSING_DUTY_DATE');
  if (!shift) gaps.push('MISSING_SHIFT');

  const sourceMessageId = clean(record.sourceMessageId) || null;
  const warnings: string[] = [];
  if (sourceMessageId) warnings.push(`Source message ${sourceMessageId} is linked as evidence.`);
  else warnings.push('No source message reference is linked; preserve the original chat before sending.');

  let text: string | null = null;
  if (!gaps.length) {
    try {
      text = renderOwnerDraftFields({
        motherVessel: String(record.motherVessel ?? ''),
        lighterVessel: String(record.lighterVessel ?? ''),
        masterMobile: String(record.masterMobile ?? ''),
        destination: record.destination,
        date,
        shift: shift as 'D' | 'N',
      });
    } catch {
      gaps.push('DRAFT_RENDER_FAILED');
    }
  }
  if (gaps.length) {
    warnings.push(`Draft blocked: ${gaps.join(', ')}. No value is invented.`);
  } else {
    warnings.push('Escort Name and Escort Mobile stay blank: the Admin supplies them in the confirmation reply.');
    warnings.push('Delivery is manual copy only. No WhatsApp message is sent by this platform.');
  }

  return {text, gaps, warnings, sourceMessageId, delivery: OWNER_DRAFT_DELIVERY};
}

type ProgramLike = {
  mother_vessel?: unknown;
  lighter_vessel?: unknown;
  master_mobile?: unknown;
  destination?: unknown;
  start_date?: unknown;
  start_shift?: unknown;
  source_message_id?: unknown;
};

/** DRAFT/CONFIRMED program row → Owner draft. */
export function ownerDraftFromProgram(program: ProgramLike): OrderDraftResult {
  return ownerDraftFromRecord({
    motherVessel: program.mother_vessel as string | null,
    lighterVessel: program.lighter_vessel as string | null,
    masterMobile: program.master_mobile as string | null,
    destination: program.destination as string | null,
    date: program.start_date as string | null,
    shift: program.start_shift as string | null,
    sourceMessageId: program.source_message_id as string | null,
  });
}

/**
 * PROGRAM review item payload → Owner draft. Reads the payload shapes the
 * router actually writes (`fields`, `extractedFields`, flat payload).
 */
export function ownerDraftFromReviewPayload(payload: unknown): OrderDraftResult {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const nested = (key: string) => root[key] && typeof root[key] === 'object'
    ? root[key] as Record<string, unknown>
    : {};
  const merged = {...nested('fields'), ...nested('extractedFields'), ...root};
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = clean(merged[key]);
      if (value) return value;
    }
    return '';
  };
  return ownerDraftFromRecord({
    motherVessel: pick('motherVessel', 'mother_vessel'),
    lighterVessel: pick('lighterVessel', 'lighter_vessel'),
    masterMobile: pick('masterMobile', 'master_mobile'),
    destination: pick('destination'),
    date: pick('assignmentDate', 'startDate', 'start_date', 'date', 'dutyDate'),
    shift: pick('shift', 'startShift', 'start_shift'),
    sourceMessageId: pick('sourceMessageId', 'source_message_id'),
    sourceTimestamp: pick('sourceTimestamp', 'source_timestamp'),
  });
}
