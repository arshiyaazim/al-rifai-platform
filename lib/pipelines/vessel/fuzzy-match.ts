// Weighted Admin confirmation score (Step 14 / D7).
// Mother 25, Lighter 25, Master 20, Escort mobile present 15, Escort name
// present 10, Date/Shift 5. This module never changes state.

import {parseEscortOrder} from '../../escort-intake-candidate.mjs';
import {compareVesselNames} from '../../vessel-match.ts';

export type ProgramForScore = {
  mother_vessel?: string | null;
  lighter_vessel?: string | null;
  master_mobile?: string | null;
  start_date?: string | Date | null;
  start_shift?: string | null;
  escort_name?: string | null;
  escort_mobile?: string | null;
};

export type ConfirmationBlock = {
  mother: string;
  lighter: string;
  master: string;
  escortName: string;
  escortMobile: string;
  startDate: string | null;
  shift: 'D' | 'N' | null;
  raw: string;
};

const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');
const validMobile = (value: unknown) => /^01[3-9]\d{8}$/.test(digits(value));
const iso = (value: unknown) => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

export function extractConfirmationBlock(outgoingText: string, messageDate?: string): ConfirmationBlock | null {
  const blocks = parseEscortOrder(outgoingText, {messageDate}) as Array<Record<string, unknown>>;
  for (const block of blocks) {
    const fields = (block.fields ?? block) as Record<string, string | null | undefined>;
    const escortName = String(fields.escortName ?? '').trim();
    const escortMobile = digits(block.employeeMobile ?? fields.escortMobile ?? '');
    if (!escortName || !validMobile(escortMobile)) continue;
    if (!fields.motherVessel || !fields.lighterVessel) continue;
    return {
      mother: String(fields.motherVessel),
      lighter: String(fields.lighterVessel),
      master: digits(block.masterMobile ?? fields.masterMobile ?? ''),
      escortName,
      escortMobile,
      startDate: block.assignmentDate ? String(block.assignmentDate).slice(0, 10) : null,
      shift: block.shift === 'D' || block.shift === 'N' ? block.shift : null,
      raw: outgoingText,
    };
  }
  return null;
}

export function computeConfirmationScore(outgoingText: string, order: ProgramForScore, messageDate?: string): number {
  const block = extractConfirmationBlock(outgoingText, messageDate);
  if (!block) return 0;
  let score = 0;
  if (order.mother_vessel && compareVesselNames(block.mother, String(order.mother_vessel)) !== 'DIFFERENT') score += 25;
  if (order.lighter_vessel && compareVesselNames(block.lighter, String(order.lighter_vessel)) !== 'DIFFERENT') score += 25;
  if (order.master_mobile && block.master && digits(order.master_mobile) === block.master) score += 20;
  if (validMobile(block.escortMobile)) score += 15;
  if (block.escortName) score += 10;
  if (block.startDate && iso(order.start_date) === block.startDate && block.shift && String(order.start_shift ?? '').toUpperCase().startsWith(block.shift)) score += 5;
  return Math.max(0, Math.min(100, score));
}
