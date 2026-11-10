// Minimal, dependency-free CSV reader/writer used by the import/export APIs.
// Handles quoted fields, escaped quotes, CRLF and a UTF-8 BOM.

export type ParsedCsv = {
  headers: string[];
  rows: string[][];
  errors: Array<{line: number; reason: string}>;
};

function parseLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') { current += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else current += char;
    } else if (char === '"') quoted = true;
    else if (char === ',') { cells.push(current); current = ''; }
    else current += char;
  }
  cells.push(current);
  return cells.map((cell) => cell.trim());
}

export function parseCsv(text: string): ParsedCsv {
  const source = String(text ?? '').replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines: string[] = [];
  let current = '';
  let quoted = false;
  for (const char of source) {
    if (char === '"') quoted = !quoted;
    if (char === '\n' && !quoted) { lines.push(current); current = ''; }
    else if (char !== '\r') current += char;
  }
  if (current) lines.push(current);
  const clean = lines.filter((line, index) => line.trim() || index === 0);
  if (!clean.length) return {headers: [], rows: [], errors: [{line: 0, reason: 'EMPTY_FILE'}]};
  const headers = parseLine(clean[0]);
  const rows: string[][] = [];
  const errors: ParsedCsv['errors'] = [];
  for (let index = 1; index < clean.length; index += 1) {
    if (!clean[index].trim()) continue;
    const cells = parseLine(clean[index]);
    if (cells.every((cell) => !cell)) continue;
    if (cells.length !== headers.length) {
      errors.push({line: index + 1, reason: `COLUMN_COUNT_${cells.length}_EXPECTED_${headers.length}`});
    }
    rows.push(cells);
  }
  return {headers, rows, errors};
}

const escapeCell = (value: unknown) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** Excel-friendly CSV: UTF-8 BOM + escaped cells. */
export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  return `\uFEFF${[headers, ...rows].map((row) => row.map(escapeCell).join(',')).join('\r\n')}\r\n`;
}

export function parseAmountMinor(value: unknown): number | null {
  const text = String(value ?? '').replace(/[৳,\s]/g, '');
  if (!text) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || number <= 0) return null;
  return Math.round(number * 100);
}

/** Accepts YYYY-MM-DD, DD.MM.YY, DD.MM.YYYY, DD/MM/YY, DD-MM-YY. */
export function parseImportDate(value: unknown): string | null {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const match = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})$/.exec(text);
  if (!match) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  let year = Number(match[3]);
  if (year < 100) year += 2000;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

export function parseShift(value: unknown): 'D' | 'N' | null {
  const text = String(value ?? '').toUpperCase();
  if (/\bN\b|NIGHT/.test(text)) return 'N';
  if (/\bD\b|DAY/.test(text)) return 'D';
  return null;
}

/** Split "10.11.26 (D)" into date + shift. */
export function splitDateShift(value: unknown): {date: string | null; shift: 'D' | 'N' | null} {
  const text = String(value ?? '').trim();
  const match = /^(.*?)\s*\(+\s*([DN]|Day|Night)\s*\)+\s*$/i.exec(text);
  return {
    date: parseImportDate(match ? match[1] : text),
    shift: parseShift(match ? match[2] : text),
  };
}
