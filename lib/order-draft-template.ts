// Owner draft message — exact layout (decision F, 2026-11-04).
//
// The Owner's required ten-line structure, reproduced literally:
//
//   Mother Vessel: M.V. Union-Odyssey
//   Importer
//   Lighter Vessel:M.V. Fardin-7
//   Master mobile:-01911-428354
//   Destination:
//   Escort Name:
//   Escort mobile:
//   03/11/26 ((D))
//
//   Al-Rifa'i Integrated Services
//
// Rules encoded here:
//   * one draft per Lighter (the caller renders one block at a time);
//   * only parsed fields are used — nothing is invented;
//   * Escort Name / Escort Mobile always stay blank: the Admin fills them in the
//     reply, and that reply is the confirmation;
//   * date and shift come from the verified WA-01 arrival timestamp using the
//     Owner-approved boundary (06:00–17:59 Day, 18:00–05:59 Night) in
//     lib/shift-boundary.ts;
//   * the `Importer` line is part of the display template only. Importer is not a
//     required business field, so no importer text is extracted or rendered;
//   * a missing Mother Vessel, Lighter Vessel or Master Mobile is a hard error —
//     a draft is never rendered with an invented or blank required field.
//
// This module never sends anything. Delivery is a separate, not-yet-approved step.

import {orderDraftDateAndShift} from './shift-boundary.ts';
import {analyzeMobile} from './mobile-identity.mjs';

export type OwnerDraftInput = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile: string;
  destination?: string | null;
  /** Verified WhatsApp arrival timestamp of the authorized Order. */
  timestamp: string;
};

export const OWNER_DRAFT_FOOTER = "Al-Rifa'i Integrated Services";

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Render a vessel name with the client convention's `M.V. ` prefix, once. */
export function vesselDisplayName(value: string): string {
  const name = clean(value).replace(/^m\.?\s*v\.?\s*[:.,-]?\s*/i, '').replace(/^এমভি\s*[:.]?\s*/, '');
  return name ? `M.V. ${name}` : '';
}

/** `+8801911428354` / `01911428354` / `01911-428354` → `01911-428354`. */
export function masterMobileDisplay(value: string): string {
  const digits = analyzeMobile(clean(value)).digits;
  if (!/^01[3-9]\d{8}$/.test(digits)) return '';
  return `${digits.slice(0, 5)}-${digits.slice(5)}`;
}

/** `2026-11-03` → `03/11/26`. */
export function draftDateDisplay(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!match) return '';
  return `${match[3]}/${match[2]}/${match[1].slice(2)}`;
}

const missing = (fields: string[]) => new Error(`DRAFT_FIELDS_REQUIRED:${fields.join('+')}`);

/**
 * Render the exact Owner draft for ONE Lighter.
 * @throws when a required field is missing or the timestamp cannot be verified.
 */
export function renderOwnerDraft(input: OwnerDraftInput): string {
  const mother = vesselDisplayName(input.motherVessel);
  const lighter = vesselDisplayName(input.lighterVessel);
  const master = masterMobileDisplay(input.masterMobile);
  const when = orderDraftDateAndShift(input.timestamp);

  const absent = [
    mother ? null : 'motherVessel',
    lighter ? null : 'lighterVessel',
    master ? null : 'masterMobile',
    when ? null : 'timestamp',
  ].filter((field): field is string => field !== null);
  if (absent.length) throw missing(absent);

  const destination = clean(input.destination);
  const lines = [
    `Mother Vessel: ${mother}`,
    'Importer',
    `Lighter Vessel:${lighter}`,
    `Master mobile:-${master}`,
    destination ? `Destination: ${destination}` : 'Destination:',
    'Escort Name:',
    'Escort mobile:',
    `${draftDateDisplay(when!.date)} ((${when!.shift}))`,
    '',
    OWNER_DRAFT_FOOTER,
  ];
  return lines.join('\n');
}

/** True when a stored source text already has the Owner layout (idempotency aid). */
export function isOwnerDraft(text: string): boolean {
  return typeof text === 'string'
    && /^Mother Vessel: M\.V\. /m.test(text)
    && /^Escort Name:$/m.test(text)
    && text.trimEnd().endsWith(OWNER_DRAFT_FOOTER);
}
