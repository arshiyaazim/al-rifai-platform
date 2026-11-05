// Food Bill → backward Program search (Owner finishing task, 2026-11-04).
//
// The existing release parser already performs the backward calculation for any
// message that carries an escort mobile: calc_start = message date − amount/150,
// then a ±2-day match against the roster (Steps A–D in release-parser.ts). That
// path is untouched and keeps its priority.
//
// This module covers the remaining case: a Food Bill message with an amount and
// an identity signal but NO ASCII mobile, which the parser cannot turn into a
// payment. It extracts the hint, searches the register backwards around the
// estimated start date, and returns a candidate that is only ever review-grade
// (confidence 'medium'), so nothing here can auto-apply a release.
//
// Rules:
//   * the estimated duration is a matching hint, never a requirement;
//   * one or two reliable independent signals are enough when they identify a
//     unique open Program and nothing contradicts it;
//   * equal candidates stay ambiguous → manual review;
//   * no amount, or no identity signal at all → no match (nothing invented).
//
// Pure functions: no database, no clock.

import {FOOD_RATE_BDT, normalisePhone, parseMessage, statedDateOnLine, type RosterProgram} from './release-parser.ts';
import {dhakaLocalTime, isValidDutyDate, shiftForHour} from './shift-boundary.ts';

/** Bengali digits → ASCII. A character-class mapping, not a business rule. */
const asciiDigits = (value: string) =>
  String(value ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));

const nameKey = (value: string) =>
  String(value ?? '').normalize('NFC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const vesselKey = (value: string) =>
  nameKey(value).replace(/^m\.?v\.?/, '').replace(/^এমভি/, '');

const DATE_LIKE = /\b\d{1,2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{2,4}\b/g;
const DAY_WORD = /\b\d{1,2}\s*[- ]?\s*(?:day|days|dsy|din)\b/gi;
const PHONE_LIKE = /(?:\+?88)?0?1[3-9]\d(?:[\s-]?\d){7}/g;

/** Largest plausible money value on the message, in Taka. */
export function foodBillAmountBdt(text: string): number | null {
  let working = asciiDigits(text);
  working = working.replace(PHONE_LIKE, ' ').replace(DATE_LIKE, ' ').replace(DAY_WORD, ' ');
  working = working.replace(/\([A-Za-z]\)/g, ' '); // (B)/(N) payment markers
  const amounts: number[] = [];
  for (const match of working.matchAll(/\b(\d{2,5})(?:\s*\/-)?\b/g)) {
    const value = Number(match[1]);
    if (Number.isFinite(value) && value >= 100 && value <= 50_000) amounts.push(value);
  }
  return amounts.length ? Math.max(...amounts) : null;
}

const label = (text: string, names: string[]): string | null => {
  const pattern = new RegExp(
    `^\\s*(?:${names.join('|')})\\s*[:=.-]+\\s*(.+?)\\s*$`,
    'imu',
  );
  const match = pattern.exec(text);
  return match ? match[1].replace(/\s+/g, ' ').trim() || null : null;
};

export type FoodBillHint = {
  messageId: string;
  messageDate: string;
  amountBdt: number;
  estimatedDays: number;
  estimatedStart: string;
  /** Shift the message clock implies, used as the release shift (approved rule). */
  shift: 'D' | 'N';
  escortMobile: string | null;
  escortName: string | null;
  lighterVessel: string | null;
  motherVessel: string | null;
  masterMobile: string | null;
  explicitReleaseDate: string | null;
};

const addDays = (isoDate: string, days: number) => {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
};

/**
 * Build a hint for a message the release parser could not turn into a payment.
 * Returns null when a mobile is present (the existing path already handles it)
 * or when no amount can be read.
 */
export function extractFoodBillHint(
  text: string,
  timestampIso: string,
  messageId: string,
): FoodBillHint | null {
  const body = String(text ?? '');
  if (!body || !messageId) return null;
  const local = dhakaLocalTime(timestampIso);
  if (!local) return null;
  // The existing parser owns every message that carries a mobile.
  if (parseMessage(body, timestampIso).length > 0) return null;

  const amountBdt = foodBillAmountBdt(body);
  if (!amountBdt) return null;
  const estimatedDays = Math.floor(amountBdt / FOOD_RATE_BDT);
  if (estimatedDays < 1) return null;

  const stated = statedDateOnLine(body, local.date);
  const masterRaw = label(body, ['master\\s*mobile', 'master\\s*(?:no|number)', 'মাস্টার']);
  return {
    messageId,
    messageDate: local.date,
    amountBdt,
    estimatedDays,
    estimatedStart: addDays(local.date, -estimatedDays),
    shift: shiftForHour(local.hour),
    escortMobile: normalisePhone(label(body, ['escort\\s*mobile', 'employee\\s*id']) ?? ''),
    escortName: label(body, ['escort\\s*name']),
    lighterVessel: label(body, ['lighter\\s*vessel', 'lighter']),
    motherVessel: label(body, ['mother\\s*vessel', 'mother\\s*ship']),
    masterMobile: masterRaw ? normalisePhone(masterRaw) : null,
    explicitReleaseDate: stated?.date ?? null,
  };
}

export type BackwardMatchStatus = 'MATCHED' | 'PENDING_REVIEW' | 'NO_MATCH';

export type BackwardMatch = {
  status: BackwardMatchStatus;
  programId: string | null;
  /** Never 'high': this path can never auto-apply. */
  confidence: 'medium' | null;
  signals: string[];
  candidateIds: string[];
  startDeltaDays: number | null;
  reasons: string[];
};

export type BackwardOptions = {toleranceDays?: number};

const windowOf = (hint: FoodBillHint, toleranceDays: number) => ({
  from: addDays(hint.estimatedStart, -toleranceDays),
  to: addDays(hint.estimatedStart, toleranceDays),
});

/**
 * Score every open Program whose start date is inside the backward window.
 * A Program is only eligible when at least one independent identity signal
 * matches; the date window alone is never enough.
 */
export function backwardSearch(
  hint: FoodBillHint,
  roster: readonly RosterProgram[],
  options: BackwardOptions = {},
): BackwardMatch {
  const tolerance = Math.max(0, Math.min(14, options.toleranceDays ?? 2));
  const {from, to} = windowOf(hint, tolerance);
  if (!isValidDutyDate(from) || !isValidDutyDate(to)) {
    return {status: 'NO_MATCH', programId: null, confidence: null, signals: [], candidateIds: [], startDeltaDays: null, reasons: ['DATE_WINDOW_INVALID']};
  }

  const hintPhone = normalisePhone(hint.escortMobile ?? '') ?? null;
  const hintName = nameKey(hint.escortName ?? '');
  const hintLighter = vesselKey(hint.lighterVessel ?? '');
  const hintMother = vesselKey(hint.motherVessel ?? '');
  const hintMaster = normalisePhone(hint.masterMobile ?? '') ?? null;

  const scored: Array<{id: string; score: number; signals: string[]; delta: number}> = [];
  for (const program of roster) {
    const start = String(program.startDate ?? '').slice(0, 10);
    if (!isValidDutyDate(start) || start < from || start > to) continue;
    // A Program that already has an end date is already released.
    if (program.endDate) continue;

    const signals: string[] = [];
    if (hintPhone && normalisePhone(program.escortPhone ?? '') === hintPhone) signals.push('ESCORT_MOBILE');
    if (hintName && nameKey(program.escortName ?? '') === hintName) signals.push('ESCORT_NAME');
    if (hintLighter && vesselKey(program.lighterVessel ?? '') === hintLighter) signals.push('LIGHTER_VESSEL');
    if (hintMother && vesselKey(program.motherVessel ?? '') === hintMother) signals.push('MOTHER_VESSEL');
    if (hintMaster && normalisePhone(program.masterMobile ?? '') === hintMaster) signals.push('MASTER_MOBILE');
    if (!signals.length) continue;

    // One signal is only enough when it is an exact mobile; a name or vessel
    // needs corroboration, so two independent signals are required otherwise.
    const strong = signals.includes('ESCORT_MOBILE') || signals.includes('MASTER_MOBILE');
    const corroborated = signals.length >= 2;
    if (!strong && !corroborated) continue;

    scored.push({
      id: program.id,
      score: signals.length,
      signals,
      delta: Math.round((Date.parse(`${start}T00:00:00Z`) - Date.parse(`${hint.estimatedStart}T00:00:00Z`)) / 86_400_000),
    });
  }

  if (!scored.length) {
    return {status: 'NO_MATCH', programId: null, confidence: null, signals: [], candidateIds: [], startDeltaDays: null, reasons: ['NO_SIGNAL_IN_WINDOW']};
  }

  const best = Math.max(...scored.map((item) => item.score));
  const top = scored.filter((item) => item.score === best);
  if (top.length > 1) {
    return {
      status: 'PENDING_REVIEW',
      programId: null,
      confidence: null,
      signals: [...new Set(top.flatMap((item) => item.signals))],
      candidateIds: top.map((item) => item.id),
      startDeltaDays: null,
      reasons: ['MULTIPLE_EQUAL_CANDIDATES'],
    };
  }

  const winner = top[0];
  // A lower-scoring candidate with a different identity is a contradiction.
  const contradicted = scored.some((item) => item.id !== winner.id
    && item.signals.some((signal) => !winner.signals.includes(signal)));
  if (contradicted) {
    return {
      status: 'PENDING_REVIEW',
      programId: null,
      confidence: null,
      signals: winner.signals,
      candidateIds: scored.map((item) => item.id),
      startDeltaDays: winner.delta,
      reasons: ['CONFLICTING_IDENTITY_SIGNALS'],
    };
  }

  return {
    status: 'MATCHED',
    programId: winner.id,
    confidence: 'medium',
    signals: winner.signals,
    candidateIds: [winner.id],
    startDeltaDays: winner.delta,
    reasons: [],
  };
}
