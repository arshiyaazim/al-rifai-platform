// Owner order draft — exact Phase 2 layout.
//
//   Mother Vessel: MV {mother}
//   Lighter Vessel: MV {lighter}
//   Master Mobile: 01XXXXXXXXX
//   Destination: {destination}
//   Escort Name: {escort or blank}
//   Escort Mobile: {escort mobile or blank}
//   DD.MM.YYYY (D|N)
//   Al-Rifa'i Integrated Services
//
// The DB stores clean names (migration 019). "MV " is a display prefix added
// here, never stored. This module never sends anything.

import {orderIntakeDateAndShift} from './order-intake-shift.ts';

export type OwnerDraftInput = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile: string;
  destination?: string | null;
  escortName?: string | null;
  escortMobile?: string | null;
  /** Verified WhatsApp arrival timestamp of the authorized Order. */
  timestamp: string;
};

export const OWNER_DRAFT_FOOTER = "Al-Rifa'i Integrated Services";
export const DEFAULT_MV_PREFIX = 'MV ';

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Strip any M.V./MV variant and source suffix, then add the display prefix once. */
export function ensureMVPrefix(value: string, prefix = DEFAULT_MV_PREFIX): string {
  let name = clean(value)
    .replace(/^m\.?\s*v\.?\s*[:.,-]?\s*/i, '')
    .replace(/^এম\s*\.?\s*ভি\s*\.?\s*/i, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/\s*\([^)]*\)\s*$/g, '')
    .replace(/^[*_~`"'\s,;-]+|[*_~`"'\s]+$/g, '')
    .replace(/[.,;*]+$/g, '')
    .trim();
  name = name.replace(/\s+/g, ' ');
  return name ? `${prefix}${name}` : '';
}

/** Kept for compatibility with older callers. */
export function vesselDisplayName(value: string, prefix = DEFAULT_MV_PREFIX): string {
  return ensureMVPrefix(value, prefix);
}

/** `+8801911428354` / `01911-428354` → `01911428354`. */
export function masterMobileDisplay(value: string): string {
  const digits = String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');
  return /^01[3-9]\d{8}$/.test(digits) ? digits : '';
}

/** `2026-11-03` → `03.11.2026`. */
export function draftDateDisplay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return '';
  return `${match[3]}.${match[2]}.${match[1]}`;
}

const missing = (fields: string[]) => new Error(`DRAFT_FIELDS_REQUIRED:${fields.join('+')}`);

/** Duty date/shift already resolved by the caller (program row or review item). */
export type OwnerDraftFields = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile: string;
  destination?: string | null;
  escortName?: string | null;
  escortMobile?: string | null;
  /** ISO `YYYY-MM-DD` duty date. */
  date: string;
  shift: 'D' | 'N';
  /** Optional flag value from system_feature_flags('vessel.mv_prefix'). */
  prefix?: string;
};

function renderLighterLines(input: OwnerDraftFields, prefix: string, includeMother: boolean): string[] {
  const lighter = ensureMVPrefix(input.lighterVessel, prefix);
  const master = masterMobileDisplay(input.masterMobile);
  const date = draftDateDisplay(input.date);
  const shift = input.shift === 'D' || input.shift === 'N' ? input.shift : '';
  const absent = [
    lighter ? null : 'lighterVessel',
    master ? null : 'masterMobile',
    date ? null : 'date',
    shift ? null : 'shift',
  ].filter((field): field is string => field !== null);
  if (absent.length) throw missing(absent);

  const lines: string[] = [];
  if (includeMother) lines.push(`Mother Vessel: ${ensureMVPrefix(input.motherVessel, prefix)}`);
  lines.push(
    `Lighter Vessel: ${lighter}`,
    `Master Mobile: ${master}`,
    `Destination:${clean(input.destination) ? ` ${clean(input.destination)}` : ''}`,
    `Escort Name:${clean(input.escortName) ? ` ${clean(input.escortName)}` : ''}`,
    `Escort Mobile:${clean(input.escortMobile) ? ` ${clean(input.escortMobile)}` : ''}`,
    `${date} (${shift})`,
  );
  return lines;
}

/** Render the exact Owner draft for ONE Lighter. */
export function renderOwnerDraftFields(input: OwnerDraftFields): string {
  const prefix = input.prefix || DEFAULT_MV_PREFIX;
  const lines = [
    ...renderLighterLines(input, prefix, true),
    '',
    OWNER_DRAFT_FOOTER,
  ];
  return lines.join('\n');
}

/** Render one message containing multiple lighters under a single Mother. */
export function renderOwnerDraftMulti(inputs: OwnerDraftFields[], prefix = DEFAULT_MV_PREFIX): string {
  if (!inputs.length) throw missing(['lighterVessel']);
  const mother = ensureMVPrefix(inputs[0].motherVessel, prefix);
  if (!mother) throw missing(['motherVessel']);
  const lines: string[] = [`Mother Vessel: ${mother}`];
  inputs.forEach((input, index) => {
    lines.push(...renderLighterLines(input, prefix, false));
    if (index < inputs.length - 1) lines.push('');
  });
  lines.push('', OWNER_DRAFT_FOOTER);
  return lines.join('\n');
}

/** Render the exact Owner draft for ONE Lighter from a verified timestamp. */
export function renderOwnerDraft(input: OwnerDraftInput): string {
  const when = orderIntakeDateAndShift(input.timestamp, '');
  if (!when) throw missing(['timestamp']);
  return renderOwnerDraftFields({
    motherVessel: input.motherVessel,
    lighterVessel: input.lighterVessel,
    masterMobile: input.masterMobile,
    destination: input.destination,
    escortName: input.escortName,
    escortMobile: input.escortMobile,
    date: when.date,
    shift: when.shift,
  });
}

/** True when a stored source text already has the Phase 2 Owner layout. */
export function isOwnerDraft(text: string): boolean {
  return typeof text === 'string'
    && /^Mother Vessel: MV /m.test(text)
    && /^Lighter Vessel: MV /m.test(text)
    && /^Escort Name:/m.test(text)
    && text.trimEnd().endsWith(OWNER_DRAFT_FOOTER);
}
