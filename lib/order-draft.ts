// Admin draft composition for escort orders.
//
// Pure functions only: this module never sends, never writes and never touches
// the database. It renders the structured draft an authorized Admin can review
// and copy before sending the single confirmation reply themselves.

export type DraftSourceRow = {
  motherVessel?: string | null;
  lighterVessel?: string | null;
  masterMobile?: string | null;
  cargo?: string | null;
  capacity?: string | null;
  importer?: string | null;
  destination?: string | null;
  bookingDate?: string | null;
  escortName?: string | null;
  escortMobile?: string | null;
  dutyDate?: string | null;
  shift?: string | null;
  sourceMessageId?: string | number | null;
  clientName?: string | null;
  refreshPoint?: string | null;
  releasePoint?: string | null;
};

export type DraftGap = {
  field: string;
  required: boolean;
  label: string;
};

const text = (value: unknown) => String(value ?? '').trim();

/**
 * Compose the Admin draft. Assignment fields stay blank until the Admin fills
 * them in the reply — the draft is deliberately not a confirmation.
 */
export function composeAdminDraft(row: DraftSourceRow): string {
  const lines = [
    'Notun escort order:',
    `Mother Vessel: ${text(row.motherVessel)}`,
    `Lighter Vessel: ${text(row.lighterVessel)}`,
    `Master Mobile: ${text(row.masterMobile)}`,
    `Cargo: ${text(row.cargo)}`,
    `Capacity: ${text(row.capacity)}`,
    `Importer: ${text(row.importer)}`,
    `Destination: ${text(row.destination)}`,
    `Booking Date: ${text(row.bookingDate)}`,
    `Escort Name: ${text(row.escortName)}`,
    `Escort Mobile: ${text(row.escortMobile)}`,
    `Assignment Date: ${text(row.dutyDate)}`,
    `Shift: ${text(row.shift)}`,
  ];
  if (row.releasePoint) lines.push(`Release Point: ${text(row.releasePoint)}`);
  lines.push(
    `Source reference: ${text(row.sourceMessageId) || '—'}`,
    'Draft — pending authorized Admin assignment.',
  );
  return lines.join('\n');
}

/** Fields the original client order must supply before the draft is useful. */
export const REQUIRED_ORDER_FIELDS: Array<keyof DraftSourceRow> = [
  'motherVessel', 'lighterVessel', 'masterMobile',
];

/** Fields only the Admin may supply in the confirmation reply. */
export const REQUIRED_ASSIGNMENT_FIELDS: Array<keyof DraftSourceRow> = [
  'escortName', 'escortMobile', 'dutyDate', 'shift',
];

const LABELS: Record<string, string> = {
  motherVessel: 'Mother vessel',
  lighterVessel: 'Lighter vessel',
  masterMobile: 'Master mobile',
  escortName: 'Escort name',
  escortMobile: 'Escort mobile',
  dutyDate: 'Assignment date',
  shift: 'Shift',
};

export function draftGaps(row: DraftSourceRow): DraftGap[] {
  return [...REQUIRED_ORDER_FIELDS, ...REQUIRED_ASSIGNMENT_FIELDS]
    .filter((field) => !text(row[field]))
    .map((field) => ({
      field: String(field),
      required: REQUIRED_ORDER_FIELDS.includes(field),
      label: LABELS[String(field)] ?? String(field),
    }));
}

/** Human-readable reasons surfaced next to the draft in the review UI. */
export function draftWarnings(row: DraftSourceRow, parsedReasons: string[] = []): string[] {
  const gaps = draftGaps(row);
  const warnings = gaps.filter((gap) => gap.required).map((gap) => `${gap.label} missing from the client order`);
  if (gaps.some((gap) => !gap.required)) warnings.push('Assignment fields are intentionally blank — the Admin fills these in the reply.');
  if (!text(row.sourceMessageId)) warnings.push('Source message reference is unavailable — preserve the original chat before sending.');
  return [...warnings, ...parsedReasons];
}

/** Copy-safe provenance line for the review surface. */
export function draftProvenance(row: DraftSourceRow & {sourceTime?: string | null; clientPhone?: string | null}): string {
  const parts = [
    row.clientName ? `client ${text(row.clientName)}` : null,
    row.clientPhone ? `phone ${text(row.clientPhone)}` : null,
    row.sourceMessageId ? `message ${text(row.sourceMessageId)}` : 'message reference unavailable',
    row.sourceTime ? `at ${text(row.sourceTime).slice(0, 16).replace('T', ' ')}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}
