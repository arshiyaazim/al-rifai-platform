// AL-RIFA'I — shared, versioned business rules.
//
// Pure functions only. These rules govern normalization and evidence, never
// authorization. Authorization remains in the router and the effective-dated
// authorized-contact registry.

export const RULE_VERSION = 'alrifai-rules-2026-11-06.1';

export const DUPLICATE_WINDOWS = Object.freeze({
  cashEmployeeAmountDays: 7,
  vesselSameLighterDays: 5,
  vesselNearDuplicateDays: 1,
});

const BENGALI_DIGITS = '০১২৩৪৫৬৭৮৯';

export function toAsciiDigits(value) {
  return String(value ?? '').replace(/[০-৯]/g, (digit) => String(BENGALI_DIGITS.indexOf(digit)));
}

/** Canonical +8801XXXXXXXXX, or null. Never pads, truncates or repairs a number. */
export function normalizeMobile(value) {
  const digits = toAsciiDigits(value).replace(/[^0-9]/g, '');
  let national = digits;
  if (national.startsWith('00880')) national = national.slice(5);
  else if (national.startsWith('880')) national = national.slice(3);
  if (national.length === 10 && !national.startsWith('0')) national = `0${national}`;
  return /^01[3-9][0-9]{8}$/.test(national) ? `+88${national}` : null;
}

/** Identity forms for exact comparison: +880…, 880…, 0… and the bare digits. */
export function phoneForms(value) {
  const digits = toAsciiDigits(value).replace(/[^0-9]/g, '');
  if (!digits) return [];
  const canonical = normalizeMobile(digits);
  const forms = new Set([digits]);
  if (canonical) {
    const national = canonical.slice(3);
    forms.add(canonical);
    forms.add(national);
    forms.add(`88${national}`);
    forms.add(national.slice(-10));
  }
  return [...forms];
}

/** Exact numeric equality only. One-digit similarity is evidence, not a match. */
export function sameMobile(a, b) {
  const left = normalizeMobile(a);
  const right = normalizeMobile(b);
  if (left && right) return left === right;
  const aDigits = toAsciiDigits(a).replace(/[^0-9]/g, '');
  const bDigits = toAsciiDigits(b).replace(/[^0-9]/g, '');
  return Boolean(aDigits && bDigits && aDigits === bDigits);
}

export function normalizeVesselName(value) {
  return String(value ?? '')
    .replace(/\r/g, ' ')
    .replace(/^\s*(?:m\s*\.?\s*v\s*\.?|m\s*\/?\s*t\s*\.?|m\s*\/?\s*v\s*\.?|এম\s*\.?\s*ভি\s*\.?)\s*/i, '')
    .replace(/^\s*(?:mother|lighter)\s*vessel\s*/i, '')
    .replace(/[._]+/g, ' ')
    .replace(/[^\p{L}\p{M}\p{N}\s'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function vesselKey(value) {
  return normalizeVesselName(value).toLowerCase();
}

const TITLES = new Set(['md', 'mohammad', 'muhammad', 'mohammed', 'mr', 'mrs', 'ms', 'sk', 'sri', 'saint', 'sir']);

export function normalizePersonName(value) {
  return String(value ?? '')
    .replace(/\r/g, ' ')
    .replace(/[^\p{L}\p{M}\s.'-]/gu, ' ')
    .replace(/[.'-]/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token && !TITLES.has(token))
    .join(' ');
}

export function nameTokens(value) {
  return new Set(normalizePersonName(value).split(' ').filter(Boolean));
}

/** Token-overlap similarity in [0,1], used only as supporting evidence. */
export function nameSimilarity(left, right) {
  const a = nameTokens(left);
  const b = nameTokens(right);
  if (!a.size || !b.size) return 0;
  let overlap = 0;
  for (const token of a) if (b.has(token)) overlap += 1;
  return overlap / Math.max(a.size, b.size);
}

export function looksLikeRelease(value) {
  return /(?:escort\s*release|release\s*slip|রিলিজ|এসকর্ট\s*রিলিজ)/i.test(String(value ?? ''));
}
