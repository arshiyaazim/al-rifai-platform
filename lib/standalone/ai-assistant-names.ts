/**
 * Name variants for resilient employee search (E2.6).
 *
 * Bengali input is transliterated (bn→en), then expanded over the common
 * Bengali/English spelling pairs (j↔z, e↔i, u↔oo, a↔o, silent h). A best-effort
 * en→bn mapping produces the Bengali forms so the SQL search can match either
 * script. Pure: the same input always yields the same ordered variant list.
 */
import {transliterate} from './transliterate.ts';

const MAX_VARIANTS = 40;

export type NameVariants = {
  original: string;
  latin: string[];
  bengali: string[];
  all: string[];
};

const VOWEL_INDEPENDENT: Record<string, string> = {a: 'আ', e: 'এ', i: 'ই', o: 'ও', u: 'উ'};
const VOWEL_MATRA: Record<string, string> = {a: 'া', e: 'ে', i: 'ি', o: 'ো', u: 'ু'};
const CONSONANTS: Record<string, string> = {
  kh: 'খ', gh: 'ঘ', chh: 'ছ', ch: 'চ', jh: 'ঝ', th: 'থ', dh: 'ধ', ph: 'ফ', bh: 'ভ',
  sh: 'শ', ng: 'ং', k: 'ক', g: 'গ', j: 'জ', z: 'জ', t: 'ত', d: 'দ', n: 'ন',
  p: 'প', f: 'ফ', b: 'ব', m: 'ম', y: 'য়', r: 'র', l: 'ল', s: 'স', h: 'হ',
  v: 'ভ', q: 'ক', w: 'ও', x: 'ক্স', c: 'চ',
};

/** Best-effort English → Bengali. "neyaz" → "নেয়াজ". */
export function toBengali(text: string): string {
  const value = text.toLowerCase().replace(/[^a-z]/g, '');
  if (!value) return '';
  let out = '';
  let afterConsonant = false;
  for (let index = 0; index < value.length;) {
    const two = value.slice(index, index + 2);
    if (two === 'ee') { out += afterConsonant ? 'ি' : 'ঈ'; afterConsonant = false; index += 2; continue; }
    if (two === 'oo') { out += afterConsonant ? 'ু' : 'ঊ'; afterConsonant = false; index += 2; continue; }
    if (two === 'oi') { out += afterConsonant ? 'ৈ' : 'ঐ'; afterConsonant = false; index += 2; continue; }
    if (two === 'ou') { out += afterConsonant ? 'ৌ' : 'ঔ'; afterConsonant = false; index += 2; continue; }
    const consonant = CONSONANTS[two] ? two : CONSONANTS[value[index]] ? value[index] : '';
    if (consonant) {
      out += CONSONANTS[consonant];
      afterConsonant = true;
      index += consonant.length;
      continue;
    }
    const vowel = VOWEL_INDEPENDENT[value[index]];
    if (vowel) {
      out += afterConsonant ? VOWEL_MATRA[value[index]] : vowel;
      afterConsonant = false;
      index += 1;
      continue;
    }
    index += 1;
  }
  return out;
}

function cleanLatin(value: string): string {
  return value.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Single-rule expansions; each seed is transformed once per rule. */
function expandLatin(seed: string): string[] {
  const out = new Set<string>([seed]);
  const rules: Array<(value: string) => string> = [
    (value) => value.replace(/j/g, 'z'),
    (value) => value.replace(/z/g, 'j'),
    (value) => value.replace(/e/g, 'i'),
    (value) => value.replace(/i/g, 'e'),
    (value) => value.replace(/ee/g, 'i'),
    (value) => value.replace(/u/g, 'oo'),
    (value) => value.replace(/oo/g, 'u'),
    (value) => value.replace(/a/g, 'o'),
    (value) => value.replace(/h/g, ''),
    (value) => value.replace(/^([aeiou])/, 'h$1'),
  ];
  for (const rule of rules) {
    for (const current of [...out]) {
      const next = rule(current);
      if (next && next !== current) out.add(next);
      if (out.size >= MAX_VARIANTS) return [...out];
    }
  }
  // Second pass combines the most useful pairs (e.g. e→i then j→z).
  for (const current of [...out]) {
    const combined = current.replace(/e/g, 'i').replace(/j/g, 'z');
    if (combined !== current) out.add(combined);
    if (out.size >= MAX_VARIANTS) break;
  }
  return [...out];
}

export function generateNameVariants(query: string): NameVariants {
  const original = query.trim();
  const hasBengali = /[\u0980-\u09FF]/.test(original);
  const baseLatin = cleanLatin(hasBengali ? transliterate(original) : original);
  const latin = baseLatin ? expandLatin(baseLatin).slice(0, 24) : [];
  const bengali = new Set<string>();
  if (hasBengali && original) bengali.add(original);
  for (const variant of latin.slice(0, 6)) {
    const mapped = toBengali(variant);
    if (mapped) bengali.add(mapped);
  }
  const all: string[] = [];
  for (const value of [original, ...bengali, ...latin]) {
    const key = value.trim();
    if (key && !all.includes(key)) all.push(key);
    if (all.length >= MAX_VARIANTS) break;
  }
  return {original, latin, bengali: [...bengali], all};
}
