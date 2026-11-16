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
  return value.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
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
  if (/(গত\s*এক\s*মাস|গত\s*মাস|\blast\s+30\s+days\b|গত\s*৩০\s*দিন)/i.test(value)) {
    return rolling(30, today, 'গত মাস (৩০ দিন)');
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
