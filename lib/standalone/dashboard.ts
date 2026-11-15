import {row, rows} from './db.ts';

export type DashboardPeriod = 'total' | 'last_month' | 'this_month' | 'yesterday' | 'today';
export type DashboardDomain = 'employees' | 'attendance' | 'cash' | 'vessel';

export type DashboardEmployeeRow = {
  employee_mobile: string;
  preferred_name: string;
  date_of_join: string | null;
  designation: string | null;
  vessel_attendance: string;
  non_vessel_attendance: string;
  security_attendance: string;
  total_attendance: string;
  salary_minor: string;
  cash_paid_minor: string;
  due_minor: string;
};

const DAILY_RATE_MINOR = 40000;

export function dashboardToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

function addDays(iso: string, days: number): string {
  const date = new Date(`${iso}T12:00:00+06:00`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function monthStart(iso: string, offset: number): string {
  const [year, month] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 10);
}

function monthEnd(iso: string, offset: number): string {
  const [year, month] = iso.split('-').map(Number);
  return new Date(Date.UTC(year, month + offset, 0)).toISOString().slice(0, 10);
}

export function dashboardPeriodBounds(period: DashboardPeriod): {from?: string; to?: string; label: string} {
  const today = dashboardToday();
  if (period === 'total') return {label: 'All Time'};
  if (period === 'last_month') return {from: monthStart(today, -1), to: monthEnd(today, -1), label: 'Last Month'};
  if (period === 'this_month') return {from: monthStart(today, 0), to: today, label: 'This Month'};
  if (period === 'yesterday') return {from: addDays(today, -1), to: addDays(today, -1), label: 'Yesterday'};
  return {from: today, to: today, label: 'Today'};
}

export type DashboardCounts = {
  employeesTotal: number; employeesLastMonth: number; employeesThisMonth: number; employeesYesterday: number; employeesToday: number;
  attendanceTotal: number; attendanceLastMonth: number; attendanceThisMonth: number; attendanceYesterday: number; attendanceToday: number;
  paymentsTotal: number; paymentsLastMonth: number; paymentsThisMonth: number; paymentsYesterday: number; paymentsToday: number;
  vesselsTotal: number; vesselsLastMonth: number; vesselsThisMonth: number; vesselsYesterday: number; vesselsToday: number;
};

/**
 * Dashboard counts. Every source is a live domain table:
 * employees, attendance_records/program_assignments, cash_instructions,
 * and programs. Pending review rows live in review_items/cash_submissions and
 * are therefore never counted.
 */
export async function dashboardCounts(): Promise<DashboardCounts> {
  const today = dashboardToday();
  const thisStart = monthStart(today, 0);
  const lastStart = monthStart(today, -1);
  const lastEnd = monthEnd(today, -1);
  const data = await row<Record<string, string>>(
    `WITH bounds AS (
       SELECT $1::date AS today, $2::date AS this_start,
              $3::date AS last_start, $4::date AS last_end
     ), emp AS (
       SELECT coalesce(e.date_of_join, e.joined_on) AS day
         FROM employees e WHERE e.state = 'ACTIVE'
     ), att AS (
       SELECT a.employee_mobile, a.attendance_date AS day, a.shift
         FROM attendance_records a WHERE a.state = 'ACTIVE'
       UNION
       SELECT pa.employee_mobile, p.start_date AS day, p.start_shift AS shift
         FROM program_assignments pa
         JOIN programs p ON p.id = pa.program_id
        WHERE p.state IN ('CONFIRMED','RELEASED')
     ), pay AS (
       SELECT (i.event_at AT TIME ZONE 'Asia/Dhaka')::date AS day
         FROM cash_instructions i
        WHERE i.state NOT IN ('VOID','REJECTED')
     ), ves AS (
       SELECT p.start_date AS day FROM programs p
     )
     SELECT
       (SELECT count(*)::int FROM emp) AS employees_total,
       (SELECT count(*)::int FROM emp e, bounds b WHERE e.day >= b.last_start AND e.day <= b.last_end) AS employees_last_month,
       (SELECT count(*)::int FROM emp e, bounds b WHERE e.day >= b.this_start AND e.day <= b.today) AS employees_this_month,
       (SELECT count(*)::int FROM emp e, bounds b WHERE e.day = b.today - 1) AS employees_yesterday,
       (SELECT count(*)::int FROM emp e, bounds b WHERE e.day = b.today) AS employees_today,
       (SELECT count(*)::int FROM att) AS attendance_total,
       (SELECT count(*)::int FROM att a, bounds b WHERE a.day >= b.last_start AND a.day <= b.last_end) AS attendance_last_month,
       (SELECT count(*)::int FROM att a, bounds b WHERE a.day >= b.this_start AND a.day <= b.today) AS attendance_this_month,
       (SELECT count(*)::int FROM att a, bounds b WHERE a.day = b.today - 1) AS attendance_yesterday,
       (SELECT count(*)::int FROM att a, bounds b WHERE a.day = b.today) AS attendance_today,
       (SELECT count(*)::int FROM pay) AS payments_total,
       (SELECT count(*)::int FROM pay p, bounds b WHERE p.day >= b.last_start AND p.day <= b.last_end) AS payments_last_month,
       (SELECT count(*)::int FROM pay p, bounds b WHERE p.day >= b.this_start AND p.day <= b.today) AS payments_this_month,
       (SELECT count(*)::int FROM pay p, bounds b WHERE p.day = b.today - 1) AS payments_yesterday,
       (SELECT count(*)::int FROM pay p, bounds b WHERE p.day = b.today) AS payments_today,
       (SELECT count(*)::int FROM ves) AS vessels_total,
       (SELECT count(*)::int FROM ves v, bounds b WHERE v.day >= b.last_start AND v.day <= b.last_end) AS vessels_last_month,
       (SELECT count(*)::int FROM ves v, bounds b WHERE v.day >= b.this_start AND v.day <= b.today) AS vessels_this_month,
       (SELECT count(*)::int FROM ves v, bounds b WHERE v.day = b.today - 1) AS vessels_yesterday,
       (SELECT count(*)::int FROM ves v, bounds b WHERE v.day = b.today) AS vessels_today`,
    [today, thisStart, lastStart, lastEnd],
  );
  const n = (key: string) => Number(data?.[key] ?? 0);
  return {
    employeesTotal: n('employees_total'), employeesLastMonth: n('employees_last_month'),
    employeesThisMonth: n('employees_this_month'), employeesYesterday: n('employees_yesterday'), employeesToday: n('employees_today'),
    attendanceTotal: n('attendance_total'), attendanceLastMonth: n('attendance_last_month'),
    attendanceThisMonth: n('attendance_this_month'), attendanceYesterday: n('attendance_yesterday'), attendanceToday: n('attendance_today'),
    paymentsTotal: n('payments_total'), paymentsLastMonth: n('payments_last_month'),
    paymentsThisMonth: n('payments_this_month'), paymentsYesterday: n('payments_yesterday'), paymentsToday: n('payments_today'),
    vesselsTotal: n('vessels_total'), vesselsLastMonth: n('vessels_last_month'),
    vesselsThisMonth: n('vessels_this_month'), vesselsYesterday: n('vessels_yesterday'), vesselsToday: n('vessels_today'),
  };
}

/** Employee directory rows, optionally filtered by join date (inclusive). */
export async function dashboardEmployeeRows(from?: string, to?: string): Promise<DashboardEmployeeRow[]> {
  return rows<DashboardEmployeeRow>(
    `WITH vessel AS (
       SELECT employee_mobile, sum(shifts) / 2.0 AS days
         FROM (
           SELECT DISTINCT pa.employee_mobile, pa.program_id, pp.shifts
             FROM program_assignments pa
             JOIN programs p ON p.id = pa.program_id
             JOIN program_pay pp ON pp.program_id = p.id
            WHERE p.state IN ('CONFIRMED','RELEASED')
              AND pp.shifts IS NOT NULL
         ) d GROUP BY employee_mobile
     ), attendance_slots AS (
       SELECT employee_mobile, attendance_date AS day, shift
         FROM attendance_records WHERE state = 'ACTIVE'
       UNION
       SELECT employee_mobile, duty_date AS day, shift::text
         FROM attendance WHERE state = 'PRESENT'
     ), non_vessel AS (
       SELECT s.employee_mobile,
              sum(CASE WHEN s.shift = 'FULL' THEN 1 ELSE 0.5 END) AS days
         FROM attendance_slots s
        WHERE NOT EXISTS (
          SELECT 1 FROM program_assignments pa
            JOIN programs p ON p.id = pa.program_id
           WHERE pa.employee_mobile = s.employee_mobile
             AND p.state IN ('CONFIRMED','RELEASED')
             AND s.day BETWEEN p.start_date AND coalesce(p.end_date, p.start_date)
        )
        GROUP BY s.employee_mobile
     ), paid AS (
       SELECT i.employee_mobile, sum(p.amount_minor)::bigint AS total_paid
         FROM cash_postings p JOIN cash_instructions i ON i.id = p.instruction_id
        WHERE i.state = 'POSTED' AND i.employee_mobile IS NOT NULL
        GROUP BY i.employee_mobile
     ), days AS (
       SELECT e.employee_mobile,
              coalesce(v.days, 0) AS vessel_days,
              coalesce(n.days, 0) AS non_vessel_days,
              coalesce(n.days, 0) AS security_days,
              coalesce(v.days, 0) + coalesce(n.days, 0) AS total_days
         FROM employees e
         LEFT JOIN vessel v ON v.employee_mobile = e.employee_mobile
         LEFT JOIN non_vessel n ON n.employee_mobile = e.employee_mobile
     )
     SELECT e.employee_mobile, e.preferred_name,
            coalesce(e.date_of_join, e.joined_on)::text AS date_of_join,
            e.designation,
            round(d.vessel_days, 2)::text AS vessel_attendance,
            round(d.non_vessel_days, 2)::text AS non_vessel_attendance,
            round(d.security_days, 2)::text AS security_attendance,
            round(d.total_days, 2)::text AS total_attendance,
            round(d.total_days * $1)::bigint AS salary_minor,
            coalesce(p.total_paid, 0)::bigint AS cash_paid_minor,
            (round(d.total_days * $1) - coalesce(p.total_paid, 0))::bigint AS due_minor
       FROM employees e
       JOIN days d ON d.employee_mobile = e.employee_mobile
       LEFT JOIN paid p ON p.employee_mobile = e.employee_mobile
      WHERE e.state = 'ACTIVE'
        AND ($2::date IS NULL OR coalesce(e.date_of_join, e.joined_on) >= $2::date)
        AND ($3::date IS NULL OR coalesce(e.date_of_join, e.joined_on) <= $3::date)
      ORDER BY e.preferred_name`,
    [DAILY_RATE_MINOR, from ?? null, to ?? null],
  );
}
