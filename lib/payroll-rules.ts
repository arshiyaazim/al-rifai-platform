// Configurable duty/pay calculation engine (pure, no database, no posting).
//
// This module deliberately separates three distinct money concepts:
//   * employee pay       — what the worker earns;
//   * customer charge    — what the client is billed (historically BDT 440/day);
//   * approved transport — an additive allowance, only when explicitly supplied.
//
// BDT 450/day is a *proposed configurable default*, not a business ruling.
// Nothing here writes, posts, or reconciles financial records.

export type Shift = 'D' | 'N';
export type ReleaseDayPolicy = 'HALF_DAY_ENDS' | 'INCLUSIVE' | 'EXCLUSIVE';

export type PayrollConfig = {
  /** Proposed configurable employee day rate (2 shifts = 1 day). */
  employeeDayRateMinor: number;
  /** Optional separate customer-service-charge day rate (historical: 44000). */
  customerDayRateMinor?: number | null;
  currency: 'BDT';
  releaseDayPolicy: ReleaseDayPolicy;
};

/** Proposed default only — requires Owner confirmation of business meaning/date. */
export const PROPOSED_EMPLOYEE_DAY_RATE_MINOR = 45_000; // BDT 450.00
export const HISTORICAL_CUSTOMER_CHARGE_MINOR = 44_000;  // BDT 440.00 observed

export const DEFAULT_PAYROLL_CONFIG: PayrollConfig = {
  employeeDayRateMinor: PROPOSED_EMPLOYEE_DAY_RATE_MINOR,
  customerDayRateMinor: HISTORICAL_CUSTOMER_CHARGE_MINOR,
  currency: 'BDT',
  releaseDayPolicy: 'HALF_DAY_ENDS',
};

export type DutyInput = {
  startDate: string;       // YYYY-MM-DD
  startShift: Shift;
  releaseDate?: string | null;
  endShift?: Shift | null;
  /** Explicit approved transport; null/undefined means not approved yet. */
  transportMinor?: number | null;
  /** Overrides the configured rate for this calculation only. */
  employeeDayRateMinor?: number;
  customerDayRateMinor?: number | null;
};

export type DutyResult = {
  ok: boolean;
  status: 'CALCULATED' | 'UNRESOLVED' | 'INVALID';
  calendarSpanDays: number | null;
  totalShifts: number | null;
  equivalentDutyDays: number | null;
  employeePayMinor: number | null;
  customerChargeMinor: number | null;
  transportMinor: number | null;
  totalPayableMinor: number | null;
  releaseDayPolicy: ReleaseDayPolicy;
  reasons: string[];
  assumptions: string[];
};

const DAY = 86_400_000;
const isDate = (v?: string | null) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
  && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const isShift = (v?: string | null): v is Shift => v === 'D' || v === 'N';

export function calendarSpanDays(startDate: string, releaseDate: string): number {
  return Math.round((Date.parse(`${releaseDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / DAY) + 1;
}

/**
 * Shift accounting for the supported model:
 *   each duty day holds two shifts (D and N);
 *   HALF_DAY_ENDS (historical convention, 23/23 observed bills):
 *     days = span - 0.5*[start=N] - 0.5*[end=D]
 *   INCLUSIVE counts every shift in the span;
 *   EXCLUSIVE drops the release day entirely.
 * Overnight clock time is NOT modelled: a night shift is the token N on a date.
 */
export function shiftAccounting(input: {startDate: string; startShift: Shift; releaseDate: string; endShift: Shift; policy: ReleaseDayPolicy}) {
  const span = calendarSpanDays(input.startDate, input.releaseDate);
  if (span < 1) return {span, shifts: null as number | null, days: null as number | null, reason: 'RELEASE_BEFORE_START'};
  let shifts: number;
  if (input.policy === 'INCLUSIVE') shifts = span * 2;
  else if (input.policy === 'EXCLUSIVE') shifts = Math.max(0, (span - 1) * 2);
  else shifts = span * 2 - (input.startShift === 'N' ? 1 : 0) - (input.endShift === 'D' ? 1 : 0);
  return {span, shifts, days: shifts / 2, reason: null};
}

export function computeDuty(input: DutyInput, config: PayrollConfig = DEFAULT_PAYROLL_CONFIG): DutyResult {
  const assumptions = [
    'Night shift is the token N on a calendar date; overnight clock time is not modelled.',
    config.releaseDayPolicy === 'HALF_DAY_ENDS'
      ? 'Release day follows the historical half-day convention (start N and end D each deduct half a day).'
      : config.releaseDayPolicy === 'INCLUSIVE'
        ? 'Release day is counted in full (inclusive policy).'
        : 'Release day is not counted (exclusive policy).',
  ];
  const base: DutyResult = {
    ok: false, status: 'UNRESOLVED', calendarSpanDays: null, totalShifts: null,
    equivalentDutyDays: null, employeePayMinor: null, customerChargeMinor: null,
    transportMinor: input.transportMinor ?? null, totalPayableMinor: null,
    releaseDayPolicy: config.releaseDayPolicy, reasons: [], assumptions,
  };
  if (!isDate(input.startDate) || !isShift(input.startShift)) {
    return {...base, status: 'INVALID', reasons: ['START_DATE_OR_SHIFT_INVALID']};
  }
  if (!input.releaseDate) {
    return {...base, reasons: ['RELEASE_DATE_NOT_RECORDED']};
  }
  if (!isDate(input.releaseDate) || !isShift(input.endShift)) {
    return {...base, status: 'INVALID', reasons: ['RELEASE_DATE_OR_SHIFT_INVALID']};
  }
  const accounting = shiftAccounting({
    startDate: input.startDate, startShift: input.startShift,
    releaseDate: input.releaseDate, endShift: input.endShift, policy: config.releaseDayPolicy,
  });
  if (accounting.shifts === null) {
    return {...base, status: 'INVALID', calendarSpanDays: accounting.span, reasons: [accounting.reason ?? 'SHIFT_ACCOUNTING_FAILED']};
  }
  const days = accounting.days as number;
  const rate = input.employeeDayRateMinor ?? config.employeeDayRateMinor;
  if (!Number.isFinite(rate) || rate <= 0) {
    return {...base, status: 'INVALID', calendarSpanDays: accounting.span, totalShifts: accounting.shifts, reasons: ['EMPLOYEE_RATE_INVALID']};
  }
  const transport = input.transportMinor ?? null;
  if (transport !== null && (!Number.isInteger(transport) || transport < 0)) {
    return {...base, status: 'INVALID', calendarSpanDays: accounting.span, totalShifts: accounting.shifts, reasons: ['TRANSPORT_INVALID']};
  }
  const employeePayMinor = Math.round(days * rate);
  const customerRate = input.customerDayRateMinor ?? config.customerDayRateMinor ?? null;
  const customerChargeMinor = customerRate === null ? null : Math.round(days * customerRate);
  const reasons: string[] = [];
  if (transport === null) reasons.push('TRANSPORT_NOT_APPROVED');
  return {
    ok: true, status: 'CALCULATED', calendarSpanDays: accounting.span,
    totalShifts: accounting.shifts, equivalentDutyDays: accounting.days,
    employeePayMinor, customerChargeMinor, transportMinor: transport,
    totalPayableMinor: employeePayMinor + (transport ?? 0),
    releaseDayPolicy: config.releaseDayPolicy, reasons, assumptions,
  };
}

/** Format helper shared by reports; minor units in, BDT text out. */
export function formatBdtMinor(minor: number | null): string {
  if (minor === null || !Number.isFinite(minor)) return '—';
  return new Intl.NumberFormat('en-BD', {style: 'currency', currency: 'BDT', maximumFractionDigits: 2}).format(minor / 100);
}
