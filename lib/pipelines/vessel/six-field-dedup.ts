// Owner-approved six-field duplicate / escort-change decision (2026-11-10).
//
// The six identity fields are:
//   Mother Vessel  90% fuzzy (compareVesselNames)
//   Lighter Vessel 90% fuzzy
//   Master Mobile  exact (digits, +88 normalised)
//   Escort Mobile  exact (digits, +88 normalised)
//   Start Date     exact
//   Start Shift    exact
//
// This module is pure: no database, no writes, no clock. Callers load the
// candidate window and apply the returned decision inside their transaction.

import {compareVesselNames} from '../../vessel-match.ts';

export type SixFieldInput = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile?: string | null;
  escortMobile?: string | null;
  startDate: string;
  startShift?: string | null;
};

export type SixFieldCandidate = SixFieldInput & {
  id: string;
  state?: string | null;
};

export type SixFieldDecision = {
  action: 'DUPLICATE' | 'ESCORT_CHANGE' | 'UPDATE' | 'NEW';
  matchCount: number;
  candidateId: string | null;
  matchedFields: string[];
  reasons: string[];
};

export const digits = (value: unknown) =>
  String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');

const normaliseShift = (value: unknown) => {
  const text = String(value ?? '').trim().toUpperCase();
  return text === 'D' || text === 'N' ? text : '';
};

const sameMobile = (left: unknown, right: unknown) => {
  const a = digits(left);
  const b = digits(right);
  return a === b; // both empty means "no escort on either side" and matches.
};

const day = (value: unknown) => String(value ?? '').slice(0, 10);

/** Score one candidate against the incoming order. A fuzzy vessel match is 1 point. */
export function scoreSixFields(input: SixFieldInput, candidate: SixFieldCandidate) {
  const matchedFields: string[] = [];
  if (input.motherVessel && candidate.motherVessel
    && compareVesselNames(input.motherVessel, candidate.motherVessel) !== 'DIFFERENT') matchedFields.push('motherVessel');
  if (input.lighterVessel && candidate.lighterVessel
    && compareVesselNames(input.lighterVessel, candidate.lighterVessel) !== 'DIFFERENT') matchedFields.push('lighterVessel');
  if (sameMobile(input.masterMobile, candidate.masterMobile)) matchedFields.push('masterMobile');
  if (sameMobile(input.escortMobile, candidate.escortMobile)) matchedFields.push('escortMobile');
  if (day(input.startDate) && day(input.startDate) === day(candidate.startDate)) matchedFields.push('startDate');
  if (normaliseShift(input.startShift) && normaliseShift(input.startShift) === normaliseShift(candidate.startShift)) {
    matchedFields.push('startShift');
  }
  return {matchCount: matchedFields.length, matchedFields};
}

/**
 * Decide what an incoming order / confirmation means for the register.
 *
 * Matrix (Owner rules N, O, P):
 *   6/6 + same escort                  -> DUPLICATE (skip)
 *   5/6 with escort mobile different   -> ESCORT_CHANGE (new row + link)
 *   4/6 with escort same, date/shift   -> UPDATE (latest date/shift wins)
 *   otherwise                          -> NEW
 */
export function evaluateSixFieldDedup(
  input: SixFieldInput,
  candidates: readonly SixFieldCandidate[],
): SixFieldDecision {
  if (!candidates.length) {
    return {action: 'NEW', matchCount: 0, candidateId: null, matchedFields: [], reasons: ['NO_CANDIDATE']};
  }
  const scored = candidates.map((candidate) => ({
    candidate,
    ...scoreSixFields(input, candidate),
  })).sort((left, right) => right.matchCount - left.matchCount);

  const best = scored[0];
  const tied = scored.filter((item) => item.matchCount === best.matchCount
    && item.candidate.id !== best.candidate.id);
  if (tied.length > 0) {
    return {
      action: 'NEW', matchCount: best.matchCount, candidateId: null,
      matchedFields: best.matchedFields, reasons: ['AMBIGUOUS_CANDIDATES'],
    };
  }

  const escortSame = best.matchedFields.includes('escortMobile');
  const escortDifferent = !escortSame;
  const dateOrShiftDifferent = !best.matchedFields.includes('startDate')
    || !best.matchedFields.includes('startShift');

  if (best.matchCount === 6) {
    return {
      action: 'DUPLICATE', matchCount: 6, candidateId: best.candidate.id,
      matchedFields: best.matchedFields, reasons: ['SIX_OF_SIX_MATCH'],
    };
  }
  if (best.matchCount === 5 && escortDifferent
    && digits(input.escortMobile) && digits(best.candidate.escortMobile)
    && best.matchedFields.includes('motherVessel')
    && best.matchedFields.includes('lighterVessel')
    && best.matchedFields.includes('masterMobile')) {
    return {
      action: 'ESCORT_CHANGE', matchCount: 5, candidateId: best.candidate.id,
      matchedFields: best.matchedFields, reasons: ['ESCORT_MOBILE_DIFFERENT'],
    };
  }
  if (best.matchCount >= 4 && escortSame && dateOrShiftDifferent) {
    return {
      action: 'UPDATE', matchCount: best.matchCount, candidateId: best.candidate.id,
      matchedFields: best.matchedFields, reasons: ['ASSIGNMENT_WINDOW_LATEST_WINS'],
    };
  }
  return {
    action: 'NEW', matchCount: best.matchCount, candidateId: null,
    matchedFields: best.matchedFields, reasons: ['BELOW_DECISION_THRESHOLD'],
  };
}
