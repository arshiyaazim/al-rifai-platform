// Vessel order-intake date/shift only. Payroll and release keep using
// lib/shift-boundary.ts; this module must never be imported by those paths.
//
// Owner rule: explicit (D)/(N), Day/Night wins. Otherwise Asia/Dhaka 15:30 is
// the boundary: before 15:30 = D, at/after 15:30 = N.

const DHAKA = 'Asia/Dhaka';
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: DHAKA,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

export type OrderIntakeShift = 'D' | 'N';

export function explicitShift(messageText: string | null | undefined): OrderIntakeShift | null {
  const text = String(messageText ?? '');
  const marker = /\(\s*([DN])\s*\)/i.exec(text);
  if (marker) return marker[1].toUpperCase() as OrderIntakeShift;
  const word = /\b(Day|Night)\b/i.exec(text);
  if (word) return word[1].toLowerCase() === 'day' ? 'D' : 'N';
  return null;
}

export function dhakaOrderClock(sourceTimestamp: Date | string): {date: string; hour: number; minute: number; second: number} | null {
  const value = sourceTimestamp instanceof Date ? sourceTimestamp : new Date(sourceTimestamp);
  if (!Number.isFinite(value.getTime())) return null;
  const parts = Object.fromEntries(formatter.formatToParts(value).map((part) => [part.type, part.value])) as Record<string, string>;
  const hour = Number(parts.hour) % 24;
  const minute = Number(parts.minute);
  const second = Number(parts.second);
  if (![hour, minute, second].every(Number.isInteger)) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return {date, hour, minute, second};
}

export function orderIntakeShift(sourceTimestamp: Date | string, messageText: string | null | undefined): OrderIntakeShift {
  const explicit = explicitShift(messageText);
  if (explicit) return explicit;
  const clock = dhakaOrderClock(sourceTimestamp);
  if (!clock) return 'D';
  return clock.hour < 15 || (clock.hour === 15 && clock.minute < 30) ? 'D' : 'N';
}

export function orderIntakeDateAndShift(
  sourceTimestamp: Date | string,
  messageText: string | null | undefined,
): {date: string; shift: OrderIntakeShift} | null {
  const clock = dhakaOrderClock(sourceTimestamp);
  if (!clock) return null;
  return {date: clock.date, shift: orderIntakeShift(sourceTimestamp, messageText)};
}
