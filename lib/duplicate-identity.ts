// Deterministic duplicate classification for Vessel programs.
//
// Pure functions only. The Owner-approved rule is preserved:
//   Same Mother Vessel + Same Lighter Vessel + Start date within ±1 day
//   => duplicate candidate (never an automatic merge or deletion).
//
// Supporting evidence — Master Mobile, Escort Mobile, Shift, Release Point,
// destination — refines confidence but never establishes identity on its own.
// Only an EXACT same-day, same-shift replay of the same assignment is eligible
// for automatic suppression; everything else must be reviewed by a person.

export const DUPLICATE_RULE = {
  dateToleranceDays: 1,
  autoSuppressible: ['EXACT'],
} as const;

export type DuplicateState = 'EXACT' | 'PROBABLE' | 'AMBIGUOUS' | 'DISTINCT';

export type ProgramIdentity = {
  motherVessel: string;
  lighterVessel: string;
  startDate: string; // YYYY-MM-DD
  shift?: string | null;
  masterMobile?: string | null;
  escortMobile?: string | null;
  releasePoint?: string | null;
  destination?: string | null;
};

export type DuplicateResult = {
  state: DuplicateState;
  dayDelta: number | null;
  reasons: string[];
  evidence: {
    vesselPair: 'SAME' | 'ALIAS' | 'DIFFERENT';
    date: 'SAME' | 'WITHIN_ONE_DAY' | 'OUTSIDE' | 'UNKNOWN';
    shift: 'AGREE' | 'CONFLICT' | 'UNVERIFIED';
    masterMobile: 'AGREE' | 'CONFLICT' | 'UNVERIFIED';
    escortMobile: 'AGREE' | 'CONFLICT' | 'UNVERIFIED';
  };
};

const BENGALI_DIGITS: Record<string, string> = {
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

export function foldDigits(value: string): string {
  return String(value ?? '').replace(/[০-৯]/g, (d) => BENGALI_DIGITS[d] ?? d);
}

/**
 * Normalized vessel key: prefix-free, punctuation-free, Bengali-digit folded.
 * "M.V. Light-One (2)" and "MV Light One" produce the same key.
 */
export function normalizeVesselName(value: string): string {
  return foldDigits(value)
    .normalize('NFC')
    .toLowerCase()
    .replace(/^[(\[]?\d+[)\].:\-]\s*/, '') // leading serial numbers
    .replace(/^(?:এম\s*ভি|m\.?\s*v\.?)\s*[.:\-]?\s*/, '')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Alias-aware identity: an approved alias canonicalizes to the same vessel. */
export function canonicalVessel(value: string, approvedAliases: string[] = []): string {
  const key = normalizeVesselName(value);
  for (const alias of approvedAliases) {
    const aliasKey = normalizeVesselName(alias);
    if (aliasKey && aliasKey === key) return aliasKey;
  }
  return key;
}

export function sameVesselWithAliases(a: string, b: string, aliases: string[] = []): 'SAME' | 'ALIAS' | 'DIFFERENT' {
  const left = normalizeVesselName(a);
  const right = normalizeVesselName(b);
  if (!left || !right) return 'DIFFERENT';
  if (left === right) return 'SAME';
  const aliasKeys = aliases.map(normalizeVesselName).filter(Boolean);
  if (aliasKeys.some((alias) => alias === left || alias === right)) return 'ALIAS';
  return 'DIFFERENT';
}

/** Mobile comparison using the canonical, never-repaired normalizer. */
export function mobileEvidence(a?: string | null, b?: string | null): 'AGREE' | 'CONFLICT' | 'UNVERIFIED' {
  const norm = (v?: string | null) => {
    const digits = foldDigits(String(v ?? '')).replace(/\D/g, '').replace(/^880/, '0');
    return /^01[3-9]\d{8}$/.test(digits) ? digits : '';
  };
  const left = norm(a);
  const right = norm(b);
  if (!left || !right) return 'UNVERIFIED';
  return left === right ? 'AGREE' : 'CONFLICT';
}

export function normalizeShift(value?: string | null): 'D' | 'N' | '' {
  const s = String(value ?? '').trim().toUpperCase();
  if (!s) return '';
  if (['D', 'DAY', 'DAY SHIFT', 'দিন'].includes(s)) return 'D';
  if (['N', 'NIGHT', 'NIGHT SHIFT', 'রাত'].includes(s)) return 'N';
  return '';
}

/** Release points compare case/space/punctuation-insensitively. */
export function normalizeReleasePoint(value?: string | null): string {
  return foldDigits(String(value ?? ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function calendarDayDelta(a: string, b: string): number | null {
  const left = Date.parse(`${String(a).slice(0, 10)}T00:00:00Z`);
  const right = Date.parse(`${String(b).slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null;
  return Math.round(Math.abs(left - right) / 86_400_000);
}

export function classifyProgramDuplicate(
  incoming: ProgramIdentity,
  existing: ProgramIdentity,
  options: { approvalAliases?: string[] } = {},
): DuplicateResult {
  const aliases = options.approvalAliases ?? [];
  const mother = sameVesselWithAliases(incoming.motherVessel, existing.motherVessel, aliases);
  const lighter = sameVesselWithAliases(incoming.lighterVessel, existing.lighterVessel, aliases);
  const vesselPair: DuplicateResult['evidence']['vesselPair'] = mother === 'DIFFERENT' || lighter === 'DIFFERENT'
    ? 'DIFFERENT'
    : mother === 'ALIAS' || lighter === 'ALIAS' ? 'ALIAS' : 'SAME';
  const dayDelta = calendarDayDelta(incoming.startDate, existing.startDate);
  const date: DuplicateResult['evidence']['date'] =
    dayDelta === null ? 'UNKNOWN' : dayDelta === 0 ? 'SAME' : dayDelta <= DUPLICATE_RULE.dateToleranceDays ? 'WITHIN_ONE_DAY' : 'OUTSIDE';
  const shift = (() => {
    const a = normalizeShift(incoming.shift);
    const b = normalizeShift(existing.shift);
    if (!a || !b) return 'UNVERIFIED' as const;
    return a === b ? 'AGREE' as const : 'CONFLICT' as const;
  })();
  const master = mobileEvidence(incoming.masterMobile, existing.masterMobile);
  const escort = mobileEvidence(incoming.escortMobile, existing.escortMobile);
  const evidence: DuplicateResult['evidence'] = {vesselPair, date, shift, masterMobile: master, escortMobile: escort};
  const reasons: string[] = [];

  if (vesselPair === 'DIFFERENT' || date === 'OUTSIDE') {
    // Distinct programs may share an escort, a date, or a mobile: identity is
    // the vessel pair plus the start window, nothing less.
    if (vesselPair === 'DIFFERENT') reasons.push('VESSEL_PAIR_DIFFERS');
    if (date === 'OUTSIDE') reasons.push('START_DATE_OUTSIDE_ONE_DAY');
    return {state: 'DISTINCT', dayDelta, reasons, evidence};
  }
  if (date === 'UNKNOWN') {
    reasons.push('START_DATE_UNVERIFIED');
    return {state: 'AMBIGUOUS', dayDelta, reasons, evidence};
  }

  const strongEvidence = (master === 'AGREE' || escort === 'AGREE');
  if (date === 'SAME' && shift === 'AGREE' && strongEvidence) {
    reasons.push('SAME_VESSEL_PAIR_SAME_DAY_SAME_SHIFT');
    return {state: 'EXACT', dayDelta, reasons, evidence};
  }
  if (strongEvidence) {
    if (date === 'SAME' && shift !== 'CONFLICT') reasons.push('SAME_DAY_MATCHING_PERSONNEL');
    if (date === 'WITHIN_ONE_DAY') reasons.push('WITHIN_ONE_DAY_MATCHING_PERSONNEL');
    if (shift === 'CONFLICT') reasons.push('SHIFT_CONFLICT_REQUIRES_REVIEW');
    return {state: 'PROBABLE', dayDelta, reasons, evidence};
  }
  reasons.push(date === 'WITHIN_ONE_DAY' ? 'WITHIN_ONE_DAY_INSUFFICIENT_SECONDARY_EVIDENCE' : 'SAME_DAY_INSUFFICIENT_SECONDARY_EVIDENCE');
  return {state: 'AMBIGUOUS', dayDelta, reasons, evidence};
}

/** Only a proven, idempotent replay may be suppressed without a person. */
export function autoSuppressible(result: DuplicateResult): boolean {
  return result.state === 'EXACT';
}

/** Aggregate classification when several existing programs are candidates. */
export function classifyCandidateSet(results: DuplicateResult[]): DuplicateState {
  const relevant = results.filter((r) => r.state !== 'DISTINCT');
  if (!relevant.length) return 'DISTINCT';
  if (relevant.some((r) => r.state === 'EXACT') && relevant.length === 1) return 'EXACT';
  if (relevant.length > 1) return 'AMBIGUOUS';
  return relevant[0].state;
}

/** Explainable confidence label for UI/reporting (never a write decision). */
export function duplicateSummary(state: DuplicateState): string {
  switch (state) {
    case 'EXACT': return 'Same vessel pair, same day and shift, matching personnel — idempotent replay candidate';
    case 'PROBABLE': return 'Same vessel window with matching personnel — manual review required';
    case 'AMBIGUOUS': return 'Same vessel window without decisive evidence — manual review required';
    default: return 'Distinct program — no duplicate candidate';
  }
}
