// Monthly salary and conveyance allocation — Owner decision D4, 2026-11-04.
//
// Rule: "Every completed duty shift and every actual expense must be attributed
// to the month in which it occurred."
//
//   * Salary is split by the ACTUAL duty date of each shift, never by the
//     Program's start month or release month.
//   * Conveyance is attributed to the month the travel actually happened, which
//     is the verified travel/return date — not the start month and not
//     automatically the release month. An unverified travel date stays
//     UNRESOLVED and is recognised in no month.
//   * Program-level totals are preserved and must reconcile with the sum of the
//     monthly allocations; nothing is counted twice.
//
// Pure functions only: no database, no I/O, no clock. Money is integer paisa,
// consistent with program_pay and cash_instructions.

import {dutyCount, enumerateDutyShifts, isValidDutyDate, monthOf, type DutyShift, type Shift} from './shift-boundary.ts';

export type ProgramPayTotals = {
  salaryMinor: number;
  conveyanceMinor: number;
  totalMinor: number;
};

export type MonthlySalary = {
  period: string;
  shiftCount: number;
  dutyDays: number;
  salaryMinor: number;
};

export type SalaryAllocation = {
  months: MonthlySalary[];
  shiftCount: number;
  dutyDays: number;
  salaryMinor: number;
  state: 'ALLOCATED' | 'UNRESOLVED_NO_SHIFTS' | 'UNRESOLVED_RATE';
  reasons: string[];
};

export type SalarySource = {
  startDate: string | null | undefined;
  startShift: Shift | null | undefined;
  endDate: string | null | undefined;
  endShift: Shift | null | undefined;
};

const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/**
 * Split a Program's earnings across the months its shifts were actually worked.
 * The sum always equals shiftCount × shiftRateMinor.
 */
export function allocateSalaryByMonth(shifts: readonly DutyShift[], shiftRateMinor: number): SalaryAllocation {
  const counts = dutyCount(shifts);
  if (!shifts.length) {
    return {months: [], shiftCount: 0, dutyDays: 0, salaryMinor: 0, state: 'UNRESOLVED_NO_SHIFTS', reasons: ['NO_WORKED_SHIFTS']};
  }
  if (!positiveInt(shiftRateMinor)) {
    return {months: [], shiftCount: counts.shifts, dutyDays: counts.dutyDays, salaryMinor: 0, state: 'UNRESOLVED_RATE', reasons: ['SHIFT_RATE_MISSING']};
  }
  const byMonth = new Map<string, MonthlySalary>();
  for (const shift of shifts) {
    const period = monthOf(shift.date);
    if (!period) {
      return {months: [], shiftCount: counts.shifts, dutyDays: counts.dutyDays, salaryMinor: 0, state: 'UNRESOLVED_NO_SHIFTS', reasons: ['DUTY_DATE_INVALID']};
    }
    const bucket = byMonth.get(period) ?? {period, shiftCount: 0, dutyDays: 0, salaryMinor: 0};
    bucket.shiftCount += 1;
    bucket.dutyDays = bucket.shiftCount / 2;
    bucket.salaryMinor = bucket.shiftCount * shiftRateMinor;
    byMonth.set(period, bucket);
  }
  const months = [...byMonth.values()].sort((a, b) => a.period.localeCompare(b.period));
  return {
    months,
    shiftCount: counts.shifts,
    dutyDays: counts.dutyDays,
    salaryMinor: months.reduce((sum, month) => sum + month.salaryMinor, 0),
    state: 'ALLOCATED',
    reasons: [],
  };
}

export type ConveyanceSource = SalarySource & {shiftRateMinor?: never};

/**
 * Convenience wrapper: enumerate the Program's shifts from its own window, then
 * allocate. Returns UNRESOLVED (never zero) when the window is not a valid,
 * confirmed range, so a missing end date can never be priced as BDT 0.
 */
export function allocateProgramSalary(
  source: SalarySource,
  shiftRateMinor: number,
): SalaryAllocation {
  const shifts = enumerateDutyShifts(source.startDate, source.startShift, source.endDate, source.endShift);
  return allocateSalaryByMonth(shifts, shiftRateMinor);
}

export type ConveyanceEvent = {
  programId: string;
  /** Date the travel actually happened (verified). Null means not known yet. */
  eventDate: string | null;
  amountMinor: number;
  verified: boolean;
  sourceRef?: string | null;
};

export type ConveyanceAllocation = {
  period: string | null;
  amountMinor: number;
  state: 'ALLOCATED' | 'UNRESOLVED_TRAVEL_DATE' | 'UNVERIFIED_EVENT' | 'BEFORE_COMPLETION';
  reasons: string[];
};

export type ConveyanceAllocationResult = {
  allocated: Array<ConveyanceAllocation & {event: ConveyanceEvent}>;
  allocatedMinor: number;
  unresolvedMinor: number;
  duplicateMinor: number;
  duplicates: string[];
  totalMinor: number;
};

/**
 * Attribute each verified travel event to the month it occurred in.
 *
 * An event dated before the Program's release date is not recognised in an
 * earlier month: it is held as BEFORE_COMPLETION for review. Identical events
 * (same program, date and amount) count once; the extra copies are reported,
 * never silently summed.
 */
export function allocateConveyance(
  events: readonly ConveyanceEvent[],
  options: { releaseDate: string | null } = {releaseDate: null },
): ConveyanceAllocationResult {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  const allocated: Array<ConveyanceAllocation & {event: ConveyanceEvent}> = [];
  let allocatedMinor = 0;
  let unresolvedMinor = 0;
  let duplicateMinor = 0;

  for (const event of events) {
    const key = `${event.programId}|${event.eventDate ?? 'null'}|${event.amountMinor}`;
    if (seen.has(key)) {
      duplicates.push(key);
      duplicateMinor += event.amountMinor;
      continue;
    }
    seen.add(key);

    const amount = positiveInt(event.amountMinor) ? event.amountMinor : 0;
    if (!amount) {
      allocated.push({period: null, amountMinor: 0, state: 'UNVERIFIED_EVENT', reasons: ['CONVEYANCE_AMOUNT_INVALID'], event});
      continue;
    }
    if (!event.verified) {
      unresolvedMinor += amount;
      allocated.push({period: null, amountMinor: amount, state: 'UNVERIFIED_EVENT', reasons: ['CONVEYANCE_EVIDENCE_UNVERIFIED'], event});
      continue;
    }
    if (!event.eventDate || !isValidDutyDate(event.eventDate)) {
      unresolvedMinor += amount;
      allocated.push({period: null, amountMinor: amount, state: 'UNRESOLVED_TRAVEL_DATE', reasons: ['TRAVEL_DATE_UNVERIFIED'], event});
      continue;
    }
    if (options.releaseDate && isValidDutyDate(options.releaseDate) && event.eventDate < options.releaseDate) {
      unresolvedMinor += amount;
      allocated.push({period: null, amountMinor: amount, state: 'BEFORE_COMPLETION', reasons: ['CONVEYANCE_BEFORE_RELEASE'], event});
      continue;
    }
    const period = monthOf(event.eventDate);
    if (!period) {
      unresolvedMinor += amount;
      allocated.push({period: null, amountMinor: amount, state: 'UNRESOLVED_TRAVEL_DATE', reasons: ['TRAVEL_DATE_UNVERIFIED'], event});
      continue;
    }
    allocatedMinor += amount;
    allocated.push({period, amountMinor: amount, state: 'ALLOCATED', reasons: [], event});
  }

  return {
    allocated,
    allocatedMinor,
    unresolvedMinor,
    duplicateMinor,
    duplicates,
    totalMinor: allocatedMinor + unresolvedMinor,
  };
}

export type Reconciliation = {
  ok: boolean;
  salaryMatches: boolean;
  conveyanceMatches: boolean;
  conveyancePendingMinor: number;
  duplicateConveyanceMinor: number;
  differences: string[];
};

/**
 * Prove the monthly view adds up to the Program's derived pay. A monthly
 * payroll that cannot pass this must be shown as unreconciled, not presented as
 * a payable total.
 */
export function reconcileProgramPay(
  pay: ProgramPayTotals,
  salary: SalaryAllocation,
  conveyance: ConveyanceAllocationResult,
): Reconciliation {
  const differences: string[] = [];
  const salaryMatches = salary.salaryMinor === pay.salaryMinor;
  if (!salaryMatches) {
    differences.push(`SALARY_MISMATCH:monthly=${salary.salaryMinor}:program=${pay.salaryMinor}`);
  }
  const conveyanceTotal = conveyance.allocatedMinor + conveyance.unresolvedMinor;
  const conveyanceMatches = conveyanceTotal === pay.conveyanceMinor;
  if (!conveyanceMatches) {
    differences.push(`CONVEYANCE_MISMATCH:monthly=${conveyanceTotal}:program=${pay.conveyanceMinor}`);
  }
  const allocatedTotal = salary.salaryMinor + conveyance.allocatedMinor;
  if (allocatedTotal + conveyance.unresolvedMinor !== pay.totalMinor) {
    differences.push(`TOTAL_MISMATCH:allocated=${allocatedTotal}:pending=${conveyance.unresolvedMinor}:program=${pay.totalMinor}`);
  }
  if (conveyance.duplicateMinor > 0) {
    differences.push(`DUPLICATE_CONVEYANCE:${conveyance.duplicateMinor}`);
  }
  return {
    ok: differences.length === 0,
    salaryMatches,
    conveyanceMatches,
    conveyancePendingMinor: conveyance.unresolvedMinor,
    duplicateConveyanceMinor: conveyance.duplicateMinor,
    differences,
  };
}

/** Monthly payroll rows: salary buckets plus allocated conveyance, one entry per month. */
export function monthlyPayroll(
  salary: SalaryAllocation,
  conveyance: ConveyanceAllocationResult,
): Array<{ period: string; shiftCount: number; dutyDays: number; salaryMinor: number; conveyanceMinor: number; totalMinor: number }> {
  const rows = new Map<string, {period: string; shiftCount: number; dutyDays: number; salaryMinor: number; conveyanceMinor: number; totalMinor: number}>();
  const ensure = (period: string) => {
    const row = rows.get(period) ?? {period, shiftCount: 0, dutyDays: 0, salaryMinor: 0, conveyanceMinor: 0, totalMinor: 0};
    rows.set(period, row);
    return row;
  };
  for (const month of salary.months) {
    const row = ensure(month.period);
    row.shiftCount += month.shiftCount;
    row.dutyDays += month.dutyDays;
    row.salaryMinor += month.salaryMinor;
  }
  for (const item of conveyance.allocated) {
    if (item.state !== 'ALLOCATED' || !item.period) continue;
    ensure(item.period).conveyanceMinor += item.amountMinor;
  }
  return [...rows.values()]
    .map((row) => ({...row, totalMinor: row.salaryMinor + row.conveyanceMinor}))
    .sort((a, b) => a.period.localeCompare(b.period));
}
