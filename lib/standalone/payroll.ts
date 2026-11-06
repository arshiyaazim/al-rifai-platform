import {rows, row, tx, text, isoDate, moneyMinor, DomainError, type Actor} from './db.ts';
import {recordAudit} from './audit.ts';
import {assertCapability} from './authz.ts';
import {enumerateDutyShifts} from '../shift-boundary.ts';

export type RateRow = {
  destination_key: string; destination_label: string; shift_rate_minor: string;
  conveyance_minor: string; effective_from: string; active: boolean;
};

export async function listRates(): Promise<RateRow[]> {
  return rows<RateRow>(
    `SELECT destination_key, destination_label, shift_rate_minor::text, conveyance_minor::text,
            effective_from::text AS effective_from, active FROM rate_config ORDER BY destination_key`,
  );
}

export async function upsertRate(actor: Actor, input: {
  destinationKey: string; destinationLabel: string; shiftRateMinor: number;
  conveyanceMinor?: number; effectiveFrom?: string; active?: boolean;
}) {
  assertCapability(actor, 'payroll.manage');
  const key = text(input.destinationKey, 'destinationKey', {max: 80}).toLowerCase();
  const created = await row(
    `INSERT INTO rate_config (destination_key, destination_label, shift_rate_minor, conveyance_minor, effective_from, active)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (destination_key) DO UPDATE
       SET destination_label = EXCLUDED.destination_label,
           shift_rate_minor = EXCLUDED.shift_rate_minor,
           conveyance_minor = EXCLUDED.conveyance_minor,
           effective_from = EXCLUDED.effective_from,
           active = EXCLUDED.active,
           updated_at = now()
     RETURNING *`,
    [key, text(input.destinationLabel, 'destinationLabel', {max: 120}), moneyMinor(input.shiftRateMinor, 'shiftRateMinor'),
      Math.max(0, Number(input.conveyanceMinor ?? 0)), input.effectiveFrom ? isoDate(input.effectiveFrom, 'effectiveFrom') : '2025-01-01',
      input.active ?? true],
  );
  await recordAudit({actor, action: 'RATE_CONFIGURED', entity: 'rate', entityId: key});
  return created;
}

export async function programPayList(filters: {state?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  return rows(
    `SELECT p.id, p.escort_name, p.escort_mobile, p.lighter_vessel, p.mother_vessel, p.start_date::text AS start_date, p.end_date::text AS end_date,
            pp.state, pp.shifts, pp.salary_minor::text, pp.conveyance_minor::text, pp.total_minor::text, pp.reasons,
            pp.computed_at
       FROM programs p JOIN program_pay pp ON pp.program_id = p.id
      WHERE ($1::text IS NULL OR pp.state = $1)
      ORDER BY p.start_date DESC LIMIT $2`,
    [filters.state ?? null, limit],
  );
}

type ProgramForPay = {
  id: string; escort_mobile: string | null; escort_name: string | null;
  start_date: string; start_shift: 'D' | 'N'; end_date: string; end_shift: 'D' | 'N';
  destination: string | null;
};

/**
 * Monthly salary allocation: every worked shift is attributed to the month of
 * its actual duty date (cross-month programs are split, never allocated wholly).
 * Conveyance is NOT allocated here: the application does not capture a verified
 * travel date, so allocating it would invent a rule.
 */
export async function monthlySalary(month: string) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new DomainError('INVALID_MONTH');
  const programs = await rows<ProgramForPay>(
    `SELECT id, escort_mobile, escort_name, start_date::text AS start_date, start_shift, end_date::text AS end_date, end_shift, destination
       FROM programs
      WHERE end_date IS NOT NULL AND state <> 'VOIDED'`,
  );
  const rates = await listRates();
  const rateFor = (destination: string | null) => {
    const key = (destination ?? 'default').trim().toLowerCase();
    return rates.find((rate) => rate.active && rate.destination_key === key)
      ?? rates.find((rate) => rate.active && rate.destination_key === 'default')
      ?? null;
  };
  const byEmployee = new Map<string, {employee: string; name: string; shifts: number; salary: number}>();
  let totalShifts = 0;
  let totalSalary = 0;
  for (const program of programs) {
    const shifts = enumerateDutyShifts(program.start_date, program.start_shift, program.end_date, program.end_shift);
    if (!shifts.length) continue;
    const rate = rateFor(program.destination);
    if (!rate) continue;
    const perShift = Number(rate.shift_rate_minor);
    const inMonth = shifts.filter((s) => s.date.slice(0, 7) === month).length;
    if (!inMonth) continue;
    totalShifts += inMonth;
    totalSalary += inMonth * perShift;
    const key = program.escort_mobile ?? `unknown:${program.escort_name ?? program.id}`;
    const bucket = byEmployee.get(key) ?? {
      employee: program.escort_mobile ?? '', name: program.escort_name ?? '', shifts: 0, salary: 0,
    };
    bucket.shifts += inMonth;
    bucket.salary += inMonth * perShift;
    byEmployee.set(key, bucket);
  }
  return {
    month,
    shifts: totalShifts,
    salaryMinor: totalSalary,
    conveyanceAllocatedMinor: null,
    conveyanceNote: 'Conveyance needs a verified travel date; it is reported per program, not allocated to a month.',
    employees: [...byEmployee.values()].sort((a, b) => b.salary - a.salary),
  };
}

export async function payrollSummary() {
  const totals = await row<{payable: string; unresolved: string; programs: string}>(
    `SELECT coalesce(sum(total_minor),0)::text AS payable,
            count(*) FILTER (WHERE state = 'UNRESOLVED')::text AS unresolved,
            count(*)::text AS programs
       FROM program_pay`,
  );
  return totals;
}

export const payrollText = text;
export const payrollTx = tx;
