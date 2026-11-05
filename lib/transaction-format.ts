// Display abbreviations for Cash instruction rows.
//
// Kept in one module so /transactions and the per-employee history page render
// identical markers. Both tables are read-only presentations of the same
// CashRow data; a divergence between them would be a defect.

// Single-character payment method. Unknown methods fall back to their initial so a
// new method surfaces as a letter rather than disappearing.
const METHOD_ABBREVIATIONS: Record<string, string> = { bkash: 'B', nagad: 'N', nagod: 'N', cash: 'C', hotel: 'H' };

export function methodAbbreviation(method: string): string {
  const key = (method ?? '').trim().toLowerCase();
  if (!key) return '—';
  return METHOD_ABBREVIATIONS[key] ?? key[0].toUpperCase();
}

// Two-to-three character provenance marker. The Current view currently produces a
// single hardcoded value ('WhatsApp live'), so the review/excel/username branches
// are forward-compatibility: they activate when the data path carries them.
const SOURCE_ABBREVIATIONS: Record<string, string> = {
  'whatsapp live': 'WA',
  'whatsapp archive': 'WA',
  chat: 'WA',
  review: 'RV',
  excel: 'XL',
  'excel cashbook': 'XL',
};

export function sourceAbbreviation(source: string): string {
  const raw = (source ?? '').trim();
  if (!raw) return '—';
  const known = SOURCE_ABBREVIATIONS[raw.toLowerCase()];
  if (known) return known;
  // A future frontend submission carries the submitting user, e.g. "submission:admin".
  const username = raw.includes(':') ? raw.slice(raw.indexOf(':') + 1).trim() : raw;
  if (username.length >= 3 && /^[A-Za-z0-9._@-]+$/.test(username)) return username.slice(-3);
  return raw.slice(0, 2).toUpperCase();
}

/**
 * Canonical comparison key for an employee phone.
 *
 * Cash rows store `employee_mobile` with a leading `+880` stripped to a local
 * `0XXXXXXXXXX` (lib/live-cash-read.ts), but a URL may be typed or copied in
 * either form. Comparing digits only, with the country code normalised to the
 * local prefix, keeps `/transactions/employee/+8801712345678` and
 * `/transactions/employee/01712345678` pointing at the same person.
 */
export function normalizeEmployeePhone(phone: string | null | undefined): string {
  const digits = (phone ?? '').replace(/[^0-9]/g, '');
  return digits.startsWith('880') ? `0${digits.slice(3)}` : digits;
}
