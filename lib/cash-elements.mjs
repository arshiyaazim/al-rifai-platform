// AL-RIFA'I — element-based Cash payment parser.
//
// Operator rule (not format-based): a WhatsApp message is a Cash payment
// record when it contains ALL THREE elements:
//
//   1. at least one valid Bangladeshi mobile: 11 digits, starts with `0`
//      (separators such as spaces, dots, dashes and brackets are irrelevant);
//   2. an amount: any number representing taka (3000, 3000/-, 3000/- Salay…);
//   3. a person's name: any non-digit text segment (display hint only — the
//      canonical name always comes from the employees table).
//
// Normalisation is deliberate: case, dots, dashes, spaces, line breaks,
// trailing remarks and name spelling never decide whether a message is Cash.
// Only the digits of the mobile number matter for employee matching.
//
// This parser is pure: no database, no network, no configuration.

const BENGALI_DIGITS = /[০-৯]/g;
const toAsciiDigits = (value) =>
  String(value ?? '').normalize('NFC').replace(BENGALI_DIGITS, (c) => String(c.charCodeAt(0) - 0x09e6));

// Mobile numbers may be written with spaces, dots, dashes or brackets between
// any two digits. The lookarounds stop a match from starting or ending inside
// a longer digit run (e.g. an amount or an order reference).
const MOBILE_PATTERN = /(?<!\d)(?:00880|\+?880|0)[\s.\-()]*1[3-9](?:[\s.\-()]*\d){8}(?!\d)/g;

// `(B)`, `(N)`, `(C)`, `(R)`, `(bank)` and their Bangla equivalents.
const METHOD_MARKER = /[({]\s*(B|BKASH|BIKASH|N|NAGAD|C|CASH|R|ROCKET|BANK|বি(?:কাশ)?|এন|নগদ|সি|রকেট|ব্যাংক)\s*[)}]/iu;
const METHOD_WORD = /\b(BKASH|BIKASH|NAGAD|CASH|ROCKET|BANK)\b/iu;
const METHOD_MAP = {
  B: 'bkash', BKASH: 'bkash', BIKASH: 'bkash',
  N: 'nagad', NAGAD: 'nagad',
  C: 'cash', CASH: 'cash',
  R: 'rocket', ROCKET: 'rocket',
  BANK: 'bank',
  'বি': 'bkash', 'বিকাশ': 'bkash',
  'এন': 'nagad', 'নগদ': 'nagad',
  'সি': 'cash', 'রকেট': 'rocket', 'ব্যাংক': 'bank',
};

const CANCELLATION_PATTERN = /cancel|পাঠাবেন না|পাঠিও না|বাদ দিন|ফেরত/iu;

/** Normalise one matched mobile to its national 11-digit form (`01XXXXXXXXX`). */
export function nationalMobile(value) {
  const digits = toAsciiDigits(value).replace(/[^0-9]/g, '');
  const national = digits.replace(/^(?:00880|880)/, '0');
  return /^01[3-9][0-9]{8}$/.test(national) ? national : null;
}

/** Replace every matched range with spaces while keeping indices aligned. */
function maskMatches(text, matches) {
  // `split('')` keeps UTF-16 code-unit indices aligned with `match.index`.
  const chars = text.split('');
  for (const match of matches) {
    for (let i = match.index; i < match.index + match[0].length; i += 1) chars[i] = ' ';
  }
  return chars.join('');
}

/** Find the amount token, preferring an explicit `/-` or labelled amount. */
function findAmount(masked) {
  const slash = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*\/\s*-*/.exec(masked);
  if (slash) return {raw: slash[1], index: slash.index, length: slash[0].length};
  const labelled = /(?:tk|taka|amount|টাকা)\s*[:=]?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)/iu.exec(masked);
  if (labelled) return {raw: labelled[1], index: labelled.index, length: labelled[0].length};
  // Any remaining standalone number. The amount is normally written last, so
  // the final standalone number wins over incidental numbers in remarks.
  const bare = /(?<!\d)([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?!\d)/g;
  let last = null;
  for (const match of masked.matchAll(bare)) last = match;
  return last ? {raw: last[1], index: last.index, length: last[0].length} : null;
}

function amountToMinor(raw) {
  const clean = String(raw).replaceAll(',', '');
  const value = Number(clean);
  if (!Number.isFinite(value) || value <= 0) return null;
  const minor = Math.round(value * 100);
  return Number.isSafeInteger(minor) && minor > 0 ? minor : null;
}

function cleanName(value) {
  const cleaned = String(value)
    .replace(METHOD_MARKER, ' ')
    .replace(/^\s*(?:id|employee\s*id|আইডি)\s*[:;=\-]?\s*/iu, '')
    .replace(/[^\p{L}\p{M} .'’&\-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned.slice(0, 150);
}

function detectMethod(text) {
  const marker = METHOD_MARKER.exec(text);
  if (marker) return {method: METHOD_MAP[String(marker[1]).toUpperCase()] ?? METHOD_MAP[marker[1]], inferred: false};
  const word = METHOD_WORD.exec(text);
  if (word) return {method: METHOD_MAP[String(word[1]).toUpperCase()], inferred: false};
  return {method: null, inferred: true};
}

/**
 * Parse a message using the operator's element-based rule.
 *
 * @param {string} text
 * @returns {null | {
 *   mobiles: string[],
 *   amountMinor: number,
 *   amountRaw: string,
 *   nameHint: string,
 *   method: string | null,
 *   methodInferred: boolean,
 *   ambiguous: boolean,
 *   cancelled: boolean,
 * }}
 */
export function parseCashElements(text) {
  const source = String(text ?? '');
  if (!source.trim()) return null;

  const matches = [...source.matchAll(MOBILE_PATTERN)];
  const mobiles = matches
    .map((match) => nationalMobile(match[0]))
    .filter((mobile) => mobile !== null);
  if (!mobiles.length) return null;

  const masked = maskMatches(source, matches);
  const amount = findAmount(masked);
  if (!amount) return null;
  const amountMinor = amountToMinor(amount.raw);
  if (amountMinor === null) return null;

  // Name hint: text between the first and second mobile (ID + payout form),
  // otherwise the text between the last mobile and the amount, otherwise the
  // text before the first mobile. This covers `Name 01X 01Y amount` even when
  // the two numbers are adjacent. The canonical name still comes from the DB.
  const first = matches[0];
  const last = matches[matches.length - 1];
  const before = cleanName(source.slice(0, first.index));
  let nameHint = '';
  if (matches.length >= 2) {
    nameHint = cleanName(source.slice(first.index + first[0].length, matches[1].index));
  }
  if (!/\p{L}/u.test(nameHint)) {
    const tailStart = matches.length >= 2 ? last : first;
    const after = source.slice(tailStart.index + tailStart[0].length);
    const cut = amount.index - (tailStart.index + tailStart[0].length);
    nameHint = cleanName(cut >= 0 ? after.slice(0, cut) : after);
  }
  if (!/\p{L}/u.test(nameHint)) nameHint = before;
  // A hint made only of dashes/dots is not a name.
  if (!/\p{L}/u.test(nameHint)) nameHint = '';
  // All three operator elements are required: mobile, amount AND a name. A
  // message without a name goes to human review instead of being guessed.
  if (!nameHint) return null;

  const method = detectMethod(source);
  const distinct = [...new Set(mobiles)];

  return {
    mobiles,
    amountMinor,
    amountRaw: amount.raw,
    nameHint,
    method: method.method,
    methodInferred: method.inferred,
    // One or two mobiles are well-defined (ID, then optional payout). Three or
    // more are ambiguous and must go to human review, never be guessed.
    ambiguous: distinct.length > 2,
    cancelled: CANCELLATION_PATTERN.test(source),
  };
}

const cashElements = {parseCashElements, nationalMobile};
export default cashElements;
