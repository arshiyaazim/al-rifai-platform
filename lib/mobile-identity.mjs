// Mobile identity analysis shared by the Vessel parser and matcher.
//
// A Master Mobile and an Escort Mobile are digits, never a name. Formatting is
// discarded; the digit length is preserved so a missing or extra digit can be
// reported instead of silently repaired. Nothing here pads, truncates or
// overwrites a source value.

const DIGITS = /[0-9]/;

export function analyzeMobile(raw) {
  const text = String(raw ?? '').replace(/[০-৯]/g, (c) => String('০১২৩৪৫৬৭৮৯'.indexOf(c)));
  let digits = text.replace(/[^0-9]/g, '');
  if (digits.startsWith('00880')) digits = '0' + digits.slice(5);
  else if (digits.startsWith('880')) digits = '0' + digits.slice(3);
  const valid = /^01[3-9][0-9]{8}$/.test(digits);
  const kind = valid ? 'VALID'
    : digits.length === 0 ? 'EMPTY'
    : digits.length === 10 ? 'SHORT'
    : digits.length === 12 ? 'LONG'
    : 'INVALID';
  return { raw: text, digits, length: digits.length, valid, kind };
}

/** Canonical +8801… form for a valid 11-digit local number, else null. */
export function normalizedMobile(raw) {
  const analysis = analyzeMobile(raw);
  return analysis.valid ? `+88${analysis.digits}` : null;
}

/**
 * True when two numbers differ by exactly one digit (insertion, deletion or
 * substitution). Used only as an evidence signal, never as automatic repair.
 */
export function oneDigitApart(left, right) {
  const a = analyzeMobile(left).digits;
  const b = analyzeMobile(right).digits;
  // Only a missing or extra digit counts. A same-length substitution is a
  // different number, never a typo we repair.
  if (!a || !b || Math.abs(a.length - b.length) !== 1) return false;
  const shorter = a.length < b.length ? a : b;
  const longer = a.length < b.length ? b : a;
  let i = 0, j = 0, skipped = 0;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) { i += 1; j += 1; continue; }
    skipped += 1;
    if (skipped > 1) return false;
    j += 1;
  }
  return skipped + (longer.length - j) === 1 && i === shorter.length;
}

export function looksLikeMobile(raw) {
  return analyzeMobile(raw).kind !== 'EMPTY' && DIGITS.test(String(raw ?? ''));
}
