/**
 * Character-by-character Bengali → Latin fallback used by employee search.
 *
 * This is a transliteration table, not a phonetic engine: each Bengali code
 * point maps to the closest Latin sequence, the hasanta (্) is dropped, matras
 * are expanded, and unmapped combining marks pass through unchanged. Latin
 * input is returned untouched, so callers can always pass raw user text.
 *
 * Every key is quoted: a bare candrabindu/nukta is not a valid identifier
 * character in TypeScript. Input is NFC-normalised first so a decomposed
 * ড়/ঢ়/য় still hits the single code point keys below.
 */
const BENGALI: Record<string, string> = {
  'অ': 'o', 'আ': 'a', 'ই': 'i', 'ঈ': 'i', 'উ': 'u', 'ঊ': 'u', 'ঋ': 'ri', 'এ': 'e', 'ঐ': 'oi', 'ও': 'o', 'ঔ': 'ou',
  'ক': 'k', 'খ': 'kh', 'গ': 'g', 'ঘ': 'gh', 'ঙ': 'ng',
  'চ': 'ch', 'ছ': 'chh', 'জ': 'j', 'ঝ': 'jh', 'ঞ': 'n',
  'ট': 't', 'ঠ': 'th', 'ড': 'd', 'ঢ': 'dh', 'ণ': 'n',
  'ত': 't', 'থ': 'th', 'দ': 'd', 'ধ': 'dh', 'ন': 'n',
  'প': 'p', 'ফ': 'f', 'ব': 'b', 'ভ': 'bh', 'ম': 'm',
  'য': 'j', 'র': 'r', 'ল': 'l', 'শ': 'sh', 'ষ': 'sh', 'স': 's', 'হ': 'h',
  // Dotted/nukta forms as single code points (ড় ঢ় য়).
  '\u09DC': 'r', '\u09DD': 'rh', '\u09DF': 'y',
  'ৎ': 't', 'ং': 'ng', 'ঃ': 'h', 'ঁ': '',
  'া': 'a', 'ি': 'i', 'ী': 'i', 'ু': 'u', 'ূ': 'u', 'ৃ': 'ri',
  'ে': 'e', 'ৈ': 'oi', 'ো': 'o', 'ৌ': 'ou', '্': '',
  '\u09BC': '', '\u200C': '', '\u200D': '',
  '০': '0', '১': '1', '২': '2', '৩': '3', '৪': '4',
  '৫': '5', '৬': '6', '৭': '7', '৮': '8', '৯': '9',
};

const BENGALI_RANGE = /[\u0980-\u09FF]/;

/** Bengali rra/rhha/yya decompose to letter+nukta and NFC does not compose them. */
const SEQUENCES: Array<[RegExp, string]> = [
  [/\u09A1\u09BC/g, 'r'],
  [/\u09A2\u09BC/g, 'rh'],
  [/\u09AF\u09BC/g, 'y'],
];

export function transliterate(input: string): string {
  if (!BENGALI_RANGE.test(input)) return input;
  let text = input.normalize('NFC');
  for (const [pattern, latin] of SEQUENCES) text = text.replace(pattern, latin);
  return [...text].map((character) => BENGALI[character] ?? character).join('');
}
