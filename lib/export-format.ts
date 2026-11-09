/**
 * Client-safe CSV/print helpers shared by the Cash, Vessel and employee
 * statement exports. No server import, no dependency.
 */

export type ExportColumn<T> = {
  header: string;
  value: (row: T) => unknown;
};

/** RFC-4180 style escaping; the BOM prefix is added by `toCsv`. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\r\n]/.test(text)) return `"${text.replaceAll('"', '""')}"`;
  return text;
}

/** UTF-8 BOM + CRLF so Excel opens Bangla text without corruption. */
export function toCsv<T>(rows: T[], columns: ExportColumn<T>[]): string {
  const lines = [
    columns.map((column) => csvCell(column.header)).join(','),
    ...rows.map((row) => columns.map((column) => csvCell(column.value(row))).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

export function downloadTextFile(filename: string, contents: string, mime = 'text/csv;charset=utf-8') {
  const blob = new Blob([contents], {type: mime});
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadCsv<T>(filename: string, rows: T[], columns: ExportColumn<T>[]) {
  downloadTextFile(filename, toCsv(rows, columns));
}

/** Minor units (paisa) to a plain decimal number, no currency symbol. */
export function bdtNumber(minor: string | number | null | undefined): string {
  if (minor === null || minor === undefined || minor === '') return '';
  const value = Number(minor);
  if (!Number.isFinite(value)) return '';
  return (value / 100).toFixed(2);
}

/** Accepts ISO date, timestamp or Date and renders DD-MM-YYYY. */
export function dateDdMmYyyy(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    // Already a plain YYYY-MM-DD from the database.
    const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return match ? `${match[3]}-${match[2]}-${match[1]}` : String(value);
  }
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric',
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('day')}-${part('month')}-${part('year')}`;
}

export function dhakaDateTime(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).format(date);
}

/** Dhaka clock time with AM/PM, e.g. 08:26 PM. */
export function dhakaTime12(value: string | Date | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', hour12: true,
  }).format(date);
}

/** +8801XXXXXXXXX -> 01XXXXXXXXX for display. */
export function localMobile(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (raw.startsWith('+880')) return `0${raw.slice(4)}`;
  if (raw.startsWith('8801')) return `0${raw.slice(3)}`;
  return raw;
}

export function todayStamp(date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

/** Print header suffix: "Vessel Register — CONFIRMED — 2026-11-09". */
export function printHeading(title: string, filters: Array<string | null | undefined>): string {
  return [title, ...filters.filter((value): value is string => Boolean(value && String(value).trim())), todayStamp()].join(' — ');
}
