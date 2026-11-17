/**
 * Date-expression parser for the assistant (Asia/Dhaka).
 *
 * Converts Bengali digits first, then recognises relative and absolute phrases.
 * Pure: every result is derived from `now` and an explicit ISO range.
 */
export type ParsedDateRange = {from: string; to: string; labelBn: string};

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const BN_MONTHS = [
  'জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন',
  'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর',
];

export function toLatinDigits(value: string): string {
  const digits = value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
  return bengaliWordsToDigits(digits);
}

/** Bengali word numbers 1–31 (common spellings/variants). */
const BN_WORD_VALUES: Record<string, number> = {
  'এক': 1, 'দুই': 2, 'দুইটি': 2, 'তিন': 3, 'চার': 4, 'পাঁচ': 5, 'ছয়': 6, 'ছয়': 6,
  'সাত': 7, 'আট': 8, 'নয়': 9, 'নয়': 9, 'দশ': 10,
  'এগারো': 11, 'এগারোই': 11, 'বারো': 12, 'তেরো': 13, 'চৌদ্দ': 14, 'চোদ্দ': 14,
  'পনেরো': 15, 'পনের': 15, 'ষোলো': 16, 'ষোল': 16, 'সতেরো': 17, 'আঠারো': 18, 'আঠার': 18,
  'উনিশ': 19, 'ঊনিশ': 19, 'কুড়ি': 20, 'কুড়ি': 20, 'বিশ': 20,
  'একুশ': 21, 'একুশে': 21, 'বাইশ': 22, 'তেইশ': 23, 'চব্বিশ': 24, 'পঁচিশ': 25,
  'ছাব্বিশ': 26, 'সাতাশ': 27, 'আটাশ': 28, 'ঊনত্রিশ': 29, 'উনত্রিশ': 29,
  'ত্রিশ': 30, 'একত্রিশ': 31, 'একতিরিশ': 31,
};

const BN_WORDS_LONGEST_FIRST = Object.keys(BN_WORD_VALUES).sort((a, b) => b.length - a.length);

/**
 * Converts standalone Bengali number words ("তিন", "পঁচিশ") to ASCII digits so
 * one regex handles "গত তিন দিন" and "গত ৩ দিন" identically. A word glued to
 * another Bengali letter ("একটি", "ত্রিশটি") is left untouched.
 */
export function bengaliWordsToDigits(text: string): string {
  if (!text) return text;
  let out = text;
  for (const word of BN_WORDS_LONGEST_FIRST) {
    out = out.replace(new RegExp(`${word}(?![\\u0980-\\u09FF])`, 'g'), String(BN_WORD_VALUES[word]));
  }
  return out;
}

export function toBengaliDigits(value: number | string): string {
  return String(value).replace(/[0-9]/g, (digit) => BN_DIGITS[Number(digit)]);
}

function isoDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

function monthStartOf(day: string): string {
  return `${day.slice(0, 7)}-01`;
}

function monthEndOf(day: string): string {
  const [year, month] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
}

/** `2026-11-15` → `১৫ নভেম্বর` (Bengali day + month name). */
export function formatBnDate(day: string): string {
  const [, month, date] = day.split('-').map(Number);
  return `${toBengaliDigits(date)} ${BN_MONTHS[month - 1]}`;
}

function label(day: string): string {
  return formatBnDate(day);
}

function rolling(days: number, today: string, text: string): ParsedDateRange {
  const from = addDays(today, -(days - 1));
  return {from, to: today, labelBn: `${text} (${label(from)} – ${label(today)})`};
}

function previousMonth(today: string): ParsedDateRange {
  const previousEnd = addDays(monthStartOf(today), -1);
  const from = monthStartOf(previousEnd);
  const [year, month] = previousEnd.split('-').map(Number);
  return {from, to: previousEnd, labelBn: `${BN_MONTHS[month - 1]} ${toBengaliDigits(year)}`};
}

/** Calendar month N months before `today`; N=0 means month-to-date. */
function monthsAgo(today: string, months: number): ParsedDateRange {
  const [year, month] = today.split('-').map(Number);
  const index = year * 12 + (month - 1) - months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12 + 12) % 12 + 1;
  const start = `${targetYear}-${String(targetMonth).padStart(2, '0')}-01`;
  const end = months === 0 ? today : new Date(Date.UTC(targetYear, targetMonth, 0)).toISOString().slice(0, 10);
  const suffix = months === 0 ? 'এই মাস' : `${toBengaliDigits(months)} মাস আগে`;
  return {from: start, to: end, labelBn: `${suffix} (${label(start)} – ${label(end)})`};
}

export function parseDateExpression(text: string, now: Date = new Date()): ParsedDateRange | null {
  const value = toLatinDigits(String(text ?? ''));
  if (!value.trim()) return null;
  const today = isoDay(now);

  // 1) Explicit ISO range.
  const iso = value.match(/(\d{4}-\d{2}-\d{2})\s*(?:থেকে|to|–|—|-)\s*(\d{4}-\d{2}-\d{2})/i);
  if (iso) {
    const from = iso[1];
    const to = iso[2];
    if (from > to) return null;
    return {from, to, labelBn: `${label(from)} – ${label(to)}`};
  }

  // 2) Today / yesterday (Bengali inflections included).
  if (/(আজকে|আজকের|আজ|today)/i.test(value)) {
    return {from: today, to: today, labelBn: `আজ (${label(today)})`};
  }
  if (/(গতকালের|গতকালে|গতকাল|yesterday)/i.test(value)) {
    const day = addDays(today, -1);
    return {from: day, to: day, labelBn: `গতকাল (${label(day)})`};
  }

  // 2b) Single-day / single-week / calendar-month offsets in the past.
  const daysAgo = value.match(/(\d{1,3})\s*দিন\s*আগে(?:র|রটা|রে)?/i)
    ?? value.match(/(\d{1,3})\s*days?\s*ago/i);
  if (daysAgo) {
    const count = Math.min(Math.max(Number(daysAgo[1]) || 0, 0), 730);
    const day = addDays(today, -count);
    return {from: day, to: day, labelBn: `${toBengaliDigits(count)} দিন আগে (${label(day)})`};
  }
  const weeksAgo = value.match(/(\d{1,2})\s*সপ্তাহ\s*আগে(?:র|রটা|রে)?/i)
    ?? value.match(/(\d{1,2})\s*weeks?\s*ago/i);
  if (weeksAgo) {
    const count = Math.min(Math.max(Number(weeksAgo[1]) || 1, 1), 52);
    const to = addDays(today, -(count * 7));
    const from = addDays(to, -6);
    return {from, to, labelBn: `${toBengaliDigits(count)} সপ্তাহ আগে (${label(from)} – ${label(to)})`};
  }
  const monthsBack = value.match(/(\d{1,2})\s*মাস\s*আগে(?:র|রটা|রে)?/i)
    ?? value.match(/(\d{1,2})\s*months?\s*ago/i);
  if (monthsBack) {
    const count = Math.min(Math.max(Number(monthsBack[1]) || 0, 0), 24);
    return monthsAgo(today, count);
  }

  // 3) Previous calendar month — checked before the rolling "গত মাস".
  if (/(গত\s*মাসে|গত\s*মাসের|\blast\s+month\b)/i.test(value)) {
    return previousMonth(today);
  }

  // 4) Rolling windows.
  const days = value.match(/(?:গত|শেষ|last)\s*(\d{1,2})\s*(?:দিন|days?)/i)
    ?? value.match(/(\d{1,2})\s*(?:দিনের|দিনের\s*রেঞ্জ)/i);
  if (days) {
    const count = Math.min(Math.max(Number(days[1]) || 1, 1), 90);
    return rolling(count, today, `গত ${toBengaliDigits(count)} দিন`);
  }
  if (/(গত\s*সপ্তাহ|\blast\s+week\b)/i.test(value)) return rolling(7, today, 'গত সপ্তাহ');
  // "গত মাস" / "গত এক মাস" / "গত 1 মাস" are rolling 30-day windows; the
  // previous-calendar-month form ("গত মাসে/মাসের") was handled above.
  const rollingMonths = value.match(/(?:গত|শেষ)\s*(\d{1,2})?\s*মাস(?!ে|ের)/);
  if (rollingMonths) {
    const count = Math.min(Math.max(Number(rollingMonths[1] || 1), 1), 12);
    const text = count === 1 ? 'গত মাস (৩০ দিন)' : `গত ${toBengaliDigits(count)} মাস (${toBengaliDigits(count * 30)} দিন)`;
    return rolling(count * 30, today, text);
  }

  // 5) Month to date.
  if (/(এই\s*মাস|চলতি\s*মাস|এ\s*মাসে|\bthis\s+month\b|\bcurrent\s+month\b)/i.test(value)) {
    return {from: monthStartOf(today), to: today, labelBn: `এই মাস (${label(monthStartOf(today))} – ${label(today)})`};
  }

  // 6) "N তারিখ থেকে M তারিখ" in one month; N in the future means last month.
  const dayRange = value.match(/(\d{1,2})\s*তারিখ\s*(?:থেকে|to|–|-)\s*(\d{1,2})\s*তারিখ/i);
  if (dayRange) {
    const fromDay = Number(dayRange[1]);
    const toDay = Number(dayRange[2]);
    if (!fromDay || !toDay || fromDay > 31 || toDay > 31 || toDay < fromDay) return null;
    const todayDay = Number(today.slice(8, 10));
    const monthEnd = fromDay > todayDay ? addDays(monthStartOf(today), -1) : monthEndOf(today);
    const monthStart = monthStartOf(monthEnd);
    const clamp = (day: number) => {
      const last = Number(monthEnd.slice(8, 10));
      return String(Math.min(day, last)).padStart(2, '0');
    };
    const from = `${monthStart.slice(0, 7)}-${clamp(fromDay)}`;
    const to = `${monthStart.slice(0, 7)}-${clamp(toDay)}`;
    return {from, to, labelBn: `${label(from)} – ${label(to)}`};
  }

  return null;
}
