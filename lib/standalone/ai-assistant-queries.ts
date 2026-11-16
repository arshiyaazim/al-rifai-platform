/**
 * Read-only query layer for date-aware assistant summaries.
 *
 * Every statement is a parameterised SELECT. The runner is injectable so the
 * SQL shape and bound parameters can be unit-tested without a database.
 * Verified schema (2026-11-16): cash_instructions.state = POSTED | REVIEW
 * (there is no PENDING_REVIEW value); amounts are integer minor units (paisa).
 */
import {rows} from './db.ts';
import type {QueryResultRow} from 'pg';

export type RowRunner = <T extends QueryResultRow = QueryResultRow>(sql: string, params?: unknown[]) => Promise<T[]>;

const defaultRun: RowRunner = (sql, params = []) => rows(sql, params);

const CASH_IN_RANGE = `
  (event_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $1::date AND $2::date`;

export type CashSummary = {
  postedCount: number;
  totalMinor: number;
  reviewCount: number;
  byMethod: Array<{method: string; count: number; minor: number}>;
  top: Array<{employee: string; amountMinor: number; purpose: string | null}>;
};

export async function cashSummary(from: string, to: string, run: RowRunner = defaultRun): Promise<CashSummary> {
  const totals = (await run<{posted: number; minor: string; review: number}>(
    `SELECT count(*) FILTER (WHERE state = 'POSTED')::int AS posted,
            coalesce(sum(amount_minor) FILTER (WHERE state = 'POSTED'), 0)::text AS minor,
            count(*) FILTER (WHERE state = 'REVIEW')::int AS review
       FROM cash_instructions
      WHERE ${CASH_IN_RANGE}`,
    [from, to],
  ))[0];
  const byMethod = await run<{method: string; count: number; minor: string}>(
    `SELECT method, count(*)::int AS count, coalesce(sum(amount_minor), 0)::text AS minor
       FROM cash_instructions
      WHERE state = 'POSTED' AND ${CASH_IN_RANGE}
      GROUP BY method ORDER BY sum(amount_minor) DESC`,
    [from, to],
  );
  const top = await run<{employee: string; amount_minor: string; purpose: string | null}>(
    `SELECT coalesce(e.preferred_name, i.employee_name) AS employee,
            i.amount_minor::text, i.purpose
       FROM cash_instructions i
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
      WHERE i.state = 'POSTED' AND (i.event_at AT TIME ZONE 'Asia/Dhaka')::date
            BETWEEN $1::date AND $2::date
      ORDER BY i.amount_minor DESC, i.event_at DESC LIMIT 5`,
    [from, to],
  );
  return {
    postedCount: Number(totals?.posted ?? 0),
    totalMinor: Number(totals?.minor ?? 0),
    reviewCount: Number(totals?.review ?? 0),
    byMethod: byMethod.map((entry) => ({method: entry.method, count: Number(entry.count), minor: Number(entry.minor)})),
    top: top.map((entry) => ({employee: entry.employee, amountMinor: Number(entry.amount_minor), purpose: entry.purpose})),
  };
}

export type CashTransaction = {
  employee: string; amountMinor: number; method: string | null; purpose: string | null; eventAt: string;
};

export async function cashTransactions(
  from: string, to: string, limit = 20, run: RowRunner = defaultRun,
): Promise<CashTransaction[]> {
  const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
  const found = await run<{employee: string; amount_minor: string; method: string | null; purpose: string | null; event_at: string}>(
    `SELECT coalesce(e.preferred_name, i.employee_name) AS employee, i.amount_minor::text,
            i.method, i.purpose, i.event_at::text
       FROM cash_instructions i
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
      WHERE i.state = 'POSTED' AND (i.event_at AT TIME ZONE 'Asia/Dhaka')::date
            BETWEEN $1::date AND $2::date
      ORDER BY i.event_at DESC, i.id DESC LIMIT $3::int`,
    [from, to, safeLimit],
  );
  return found.map((entry) => ({
    employee: entry.employee, amountMinor: Number(entry.amount_minor),
    method: entry.method, purpose: entry.purpose, eventAt: entry.event_at,
  }));
}

export type AttendanceSummary = {
  records: number;
  days: number;
  employees: number;
  byShift: Array<{shift: string; count: number}>;
  byLocation: Array<{location: string; count: number}>;
};

export async function attendanceSummary(from: string, to: string, run: RowRunner = defaultRun): Promise<AttendanceSummary> {
  const totals = (await run<{records: number; days: number; employees: number}>(
    `SELECT count(*)::int AS records,
            count(DISTINCT attendance_date)::int AS days,
            count(DISTINCT employee_mobile)::int AS employees
       FROM attendance_records
      WHERE state = 'ACTIVE' AND attendance_date BETWEEN $1::date AND $2::date`,
    [from, to],
  ))[0];
  const byShift = await run<{shift: string; count: number}>(
    `SELECT shift, count(*)::int AS count FROM attendance_records
      WHERE state = 'ACTIVE' AND attendance_date BETWEEN $1::date AND $2::date
      GROUP BY shift ORDER BY count(*) DESC`,
    [from, to],
  );
  const byLocation = await run<{location: string; count: number}>(
    `SELECT coalesce(nullif(btrim(location), ''), '—') AS location, count(*)::int AS count
       FROM attendance_records
      WHERE state = 'ACTIVE' AND attendance_date BETWEEN $1::date AND $2::date
      GROUP BY 1 ORDER BY count(*) DESC LIMIT 5`,
    [from, to],
  );
  return {
    records: Number(totals?.records ?? 0),
    days: Number(totals?.days ?? 0),
    employees: Number(totals?.employees ?? 0),
    byShift: byShift.map((entry) => ({shift: entry.shift, count: Number(entry.count)})),
    byLocation: byLocation.map((entry) => ({location: entry.location, count: Number(entry.count)})),
  };
}

export async function employeeCashSummary(mobile: string, from: string, to: string, run: RowRunner = defaultRun) {
  const total = (await run<{count: number; minor: string}>(
    `SELECT count(*)::int AS count, coalesce(sum(amount_minor), 0)::text AS minor
       FROM cash_instructions
      WHERE state = 'POSTED' AND employee_mobile = $1
        AND (event_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $2::date AND $3::date`,
    [mobile, from, to],
  ))[0];
  return {count: Number(total?.count ?? 0), totalMinor: Number(total?.minor ?? 0)};
}

export async function employeeAttendance(mobile: string, from: string, to: string, run: RowRunner = defaultRun) {
  const found = await run<{attendance_date: string; shift: string; location: string | null}>(
    `SELECT attendance_date::text, shift, location FROM attendance_records
      WHERE state = 'ACTIVE' AND employee_mobile = $1
        AND attendance_date BETWEEN $2::date AND $3::date
      ORDER BY attendance_date DESC LIMIT 400`,
    [mobile, from, to],
  );
  const days = new Set(found.map((entry) => entry.attendance_date));
  return {records: found.length, days: days.size, rows: found};
}

export type VesselProgram = {
  mother: string; lighter: string; escortName: string | null; escortMobile: string | null;
  startDate: string; endDate: string | null; state: string;
};

export async function vesselPrograms(
  filters: {q?: string; from: string; to: string; limit?: number}, run: RowRunner = defaultRun,
): Promise<VesselProgram[]> {
  const term = (filters.q ?? '').trim();
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);
  const found = await run<{
    mother_vessel: string; lighter_vessel: string; escort_name: string | null; escort_mobile: string | null;
    start_date: string; end_date: string | null; state: string;
  }>(
    `SELECT p.mother_vessel, p.lighter_vessel, p.escort_name, p.escort_mobile,
            p.start_date::text, p.end_date::text, p.state
       FROM programs p
      WHERE p.state <> 'VOIDED'
        AND p.start_date <= $2::date
        AND coalesce(p.end_date, p.start_date) >= $1::date
        AND ($3 = '' OR p.mother_vessel ILIKE '%' || $3 || '%'
             OR p.lighter_vessel ILIKE '%' || $3 || '%'
             OR coalesce(p.escort_name, '') ILIKE '%' || $3 || '%'
             OR coalesce(p.escort_mobile, '') ILIKE '%' || $3 || '%')
      ORDER BY p.start_date DESC LIMIT $4::int`,
    [filters.from, filters.to, term, limit],
  );
  return found.map((entry) => ({
    mother: entry.mother_vessel, lighter: entry.lighter_vessel,
    escortName: entry.escort_name, escortMobile: entry.escort_mobile,
    startDate: entry.start_date, endDate: entry.end_date, state: entry.state,
  }));
}
