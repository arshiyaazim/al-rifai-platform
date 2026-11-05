// Owner-approved shift boundary and duty-shift enumeration — the single
// implementation. Owner decision D5, 2026-11-04:
//
//   DAY   : 06:00:00 – 17:59:59 Asia/Dhaka
//   NIGHT : 18:00:00 – 05:59:59 Asia/Dhaka
//   exactly 06:00 is Day; exactly 18:00 is Night.
//
// The earlier release-bill boundary (05:00–17:59) is superseded: it was never
// tested and it put the 05:00–05:59 hour in the wrong shift. No second copy of
// the cutoff is allowed anywhere in the product — the release parser, the Order
// Draft date/shift derivation and the monthly payroll allocation all import
// from this module.
//
// Pure functions only: no database, no I/O, no clock. Timezone conversion uses
// Intl with the IANA zone so it follows Bangladesh's actual offset.

export const SHIFT_TIME_ZONE = 'Asia/Dhaka';
/** 06:00:00 local — first second of Day. */
export const SHIFT_DAY_START_SECOND = 6 * 3600;
/** 18:00:00 local — first second of Night (Day ends at 17:59:59). */
export const SHIFT_DAY_END_SECOND = 18 * 3600;

export type Shift = 'D' | 'N';

/** Seconds since local midnight (0 … 86399) → shift for that instant. */
export function shiftForSecondOfDay(secondOfDay: number): Shift {
  const value = Number(secondOfDay);
  if (!Number.isFinite(value) || value < 0 || value >= 86_400) {
    throw new Error('SECOND_OF_DAY_INVALID');
  }
  return value >= SHIFT_DAY_START_SECOND && value < SHIFT_DAY_END_SECOND ? 'D' : 'N';
}

/**
 * Hour-granularity form. Kept because the release parser reads an hour, but the
 * decision itself lives in shiftForSecondOfDay so 06:00 and 18:00 cannot drift.
 */
export function shiftForHour(hour: number): Shift {
  const value = Number(hour);
  if (!Number.isInteger(value) || value < 0 || value > 23) throw new Error('HOUR_INVALID');
  return shiftForSecondOfDay(value * 3600);
}

export type DhakaLocalTime = {
  date: string;
  hour: number;
  minute: number;
  second: number;
  secondOfDay: number;
  shift: Shift;
  localTime: string;
  timezone: typeof SHIFT_TIME_ZONE;
};

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SHIFT_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Verified WhatsApp timestamp → its Dhaka local date, clock and shift. */
export function dhakaLocalTime(timestampIso: string): DhakaLocalTime | null {
  if (typeof timestampIso !== 'string' || !timestampIso.trim()) return null;
  const parsed = new Date(timestampIso);
  if (!Number.isFinite(parsed.getTime())) return null;
  const parts = Object.fromEntries(
    formatter.formatToParts(parsed).map((part) => [part.type, part.value]),
  ) as Record<string, string>;
  // Some ICU builds render midnight as "24"; normalise before validating.
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![hour, minute, second].every((value) => Number.isInteger(value))) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const secondOfDay = hour * 3600 + minute * 60 + second;
  return {
    date,
    hour,
    minute,
    second,
    secondOfDay,
    shift: shiftForSecondOfDay(secondOfDay),
    localTime: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}`,
    timezone: SHIFT_TIME_ZONE,
  };
}

/** Order Draft date + shift, derived from the timestamp the Order arrived. */
export function orderDraftDateAndShift(timestampIso: string): { date: string; shift: Shift } | null {
  const local = dhakaLocalTime(timestampIso);
  return local ? { date: local.date, shift: local.shift } : null;
}

export type DutyShift = { date: string; shift: Shift };
export type DutyDayCount = { shifts: number; dutyDays: number };

export function isValidDutyDate(value: string | null | undefined): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

const shiftIndex = (shift: Shift): 0 | 1 => (shift === 'D' ? 0 : 1);
const dayMs = 86_400_000;

/**
 * Every worked shift between (start, startShift) and (end, endShift) inclusive.
 *
 * This mirrors public.count_shifts() exactly and is the single source for
 * monthly allocation:
 *     shifts = (end - start) * 2 + (endShift==N) - (startShift==N) + 1
 * A day is [D, N]; a program that starts on N does not claim that day's D, and a
 * program that ends on D does not claim that day's N.
 *
 * Invalid or reversed ranges return [] — callers must treat that as unresolved,
 * never as zero pay.
 */
export function enumerateDutyShifts(
  start: string | null | undefined,
  startShift: Shift | null | undefined,
  end: string | null | undefined,
  endShift: Shift | null | undefined,
): DutyShift[] {
  if (!isValidDutyDate(start) || !isValidDutyDate(end)) return [];
  if (startShift !== 'D' && startShift !== 'N') return [];
  if (endShift !== 'D' && endShift !== 'N') return [];
  const from = Date.parse(`${start}T00:00:00Z`);
  const to = Date.parse(`${end}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return [];
  // Guard against a pathological range producing millions of rows.
  if ((to - from) / dayMs > 3_660) return [];

  const startIdx = shiftIndex(startShift);
  const endIdx = shiftIndex(endShift);
  const out: DutyShift[] = [];
  for (let cursor = from; cursor <= to; cursor += dayMs) {
    const date = new Date(cursor).toISOString().slice(0, 10);
    const firstIdx = cursor === from ? startIdx : 0;
    const lastIdx = cursor === to ? endIdx : 1;
    for (let idx = firstIdx; idx <= lastIdx; idx += 1) {
      out.push({ date, shift: idx === 0 ? 'D' : 'N' });
    }
  }
  return out;
}

/** Shift count / equivalent duty days (two shifts = one full duty day). */
export function dutyCount(shifts: readonly DutyShift[]): DutyDayCount {
  const count = shifts.length;
  return { shifts: count, dutyDays: count / 2 };
}

export function monthOf(date: string): string | null {
  return isValidDutyDate(date) ? date.slice(0, 7) : null;
}
