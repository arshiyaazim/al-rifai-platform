// Read-only vessel reporting aggregates (pure, no database, no writes).
// Reports never invent salary, release or attendance data: a program without a
// recorded release date contributes only what the source evidence proves.

import {computeDuty, formatBdtMinor, type PayrollConfig, DEFAULT_PAYROLL_CONFIG} from './payroll-rules.ts';

export type ReportProgram = {
  id: string;
  motherVessel: string;
  lighterVessel: string;
  escortName?: string | null;
  escortMobile?: string | null;
  startDate: string;
  startShift?: 'D' | 'N' | null;
  releaseDate?: string | null;
  endShift?: 'D' | 'N' | null;
  status?: string | null;
  transportMinor?: number | null;
  datasetEpoch?: string | null;
};

export type ReportRow = {
  key: string;
  programs: number;
  escorts: number;
  durationDays: number | null;
  employeePayMinor: number | null;
  transportMinor: number;
  totalMinor: number | null;
  incomplete: number;
};

export type ReportGroupBy = 'mother' | 'lighter' | 'escort' | 'status';

const inRange = (p: ReportProgram, from?: string, to?: string) =>
  (!from || p.startDate >= from) && (!to || p.startDate <= to);

const keyFor = (p: ReportProgram, groupBy: ReportGroupBy) => {
  if (groupBy === 'mother') return p.motherVessel;
  if (groupBy === 'lighter') return p.lighterVessel;
  if (groupBy === 'escort') return p.escortName || p.escortMobile || 'Unassigned escort';
  return p.status || 'Unknown';
};

/**
 * Aggregate programs. `includePayroll` requires complete duty data; incomplete
 * programs are counted and reported instead of being given an invented value.
 */
export function vesselReport(
  programs: ReportProgram[],
  options: {groupBy: ReportGroupBy; from?: string; to?: string; includePayroll?: boolean; config?: PayrollConfig} = {groupBy: 'mother'},
): {rows: ReportRow[]; totals: {programs: number; incomplete: number; employeePayMinor: number; transportMinor: number}} {
  const config = options.config ?? DEFAULT_PAYROLL_CONFIG;
  const groups = new Map<string, ReportRow>();
  let payTotal = 0;
  let transportTotal = 0;
  for (const program of programs) {
    if (!inRange(program, options.from, options.to)) continue;
    const key = keyFor(program, options.groupBy) || 'Unknown';
    const group = groups.get(key) ?? {key, programs: 0, escorts: 0, durationDays: 0, employeePayMinor: 0, transportMinor: 0, totalMinor: 0, incomplete: 0};
    group.programs += 1;
    if (program.escortName || program.escortMobile) group.escorts += 1;
    if (options.includePayroll) {
      const duty = program.releaseDate && program.endShift && program.startShift
        ? computeDuty({
            startDate: program.startDate,
            startShift: program.startShift,
            releaseDate: program.releaseDate,
            endShift: program.endShift,
            transportMinor: program.transportMinor ?? null,
          }, config)
        : null;
      if (!duty || !duty.ok) {
        group.incomplete += 1;
      } else {
        group.durationDays = (group.durationDays ?? 0) + (duty.equivalentDutyDays ?? 0);
        group.employeePayMinor = (group.employeePayMinor ?? 0) + (duty.employeePayMinor ?? 0);
        group.transportMinor += duty.transportMinor ?? 0;
        group.totalMinor = (group.totalMinor ?? 0) + (duty.totalPayableMinor ?? 0);
        payTotal += duty.employeePayMinor ?? 0;
        transportTotal += duty.transportMinor ?? 0;
      }
    } else {
      group.durationDays = null;
      group.employeePayMinor = null;
      group.totalMinor = null;
    }
    groups.set(key, group);
  }
  const rows = [...groups.values()].sort((a, b) => b.programs - a.programs || a.key.localeCompare(b.key));
  return {
    rows,
    totals: {
      programs: rows.reduce((n, row) => n + row.programs, 0),
      incomplete: rows.reduce((n, row) => n + row.incomplete, 0),
      employeePayMinor: payTotal,
      transportMinor: transportTotal,
    },
  };
}

/** CSV helper (formula-injection safe, BDT minor units to decimal text). */
export function reportCsv(rows: ReportRow[]): string {
  const escape = (value: string | number | null) => {
    let text = String(value ?? '');
    if (/^[\s\u0000-\u001f]*[=+@-]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
  };
  const header = ['Group', 'Programs', 'Escorts', 'Duration days', 'Employee pay (BDT)', 'Transport (BDT)', 'Total (BDT)', 'Incomplete'];
  const body = rows.map((row) => [
    row.key, row.programs, row.escorts,
    row.durationDays === null ? '' : row.durationDays,
    row.employeePayMinor === null ? '' : (row.employeePayMinor / 100).toFixed(2),
    (row.transportMinor / 100).toFixed(2),
    row.totalMinor === null ? '' : (row.totalMinor / 100).toFixed(2),
    row.incomplete,
  ]);
  return '\uFEFF' + [header, ...body].map((line) => line.map(escape).join(',')).join('\r\n');
}

export {formatBdtMinor};
