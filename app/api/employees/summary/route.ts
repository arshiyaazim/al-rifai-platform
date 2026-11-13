import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {rows} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAILY_RATE_MINOR = 40000; // ৳400/day = 2 shifts × ৳200

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'employee.read');
    const data = await rows<Record<string, unknown>>(
      `WITH vessel AS (
         SELECT employee_mobile, sum(shifts) / 2.0 AS days
           FROM (
             SELECT DISTINCT pa.employee_mobile, pa.program_id, pp.shifts
               FROM program_assignments pa
               JOIN programs p ON p.id = pa.program_id
               JOIN program_pay pp ON pp.program_id = p.id
              WHERE p.state IN ('CONFIRMED','RELEASED')
                AND pp.shifts IS NOT NULL
           ) d
          GROUP BY employee_mobile
       ), attendance_slots AS (
         -- Every attendance row from both tables, deduplicated by
         -- (employee, day, shift). attendance_records contains the migration
         -- 024 backfill of these same legacy rows, so a UNION removes the
         -- double count.
         SELECT employee_mobile, attendance_date AS day, shift
           FROM attendance_records WHERE state = 'ACTIVE'
         UNION
         SELECT employee_mobile, duty_date AS day, shift::text
           FROM attendance WHERE state = 'PRESENT'
       ), non_vessel AS (
         -- Security attendance: every attendance day that is NOT already
         -- covered by a vessel program assignment on that date.
         SELECT s.employee_mobile,
                sum(CASE WHEN s.shift = 'FULL' THEN 1 ELSE 0.5 END) AS days
           FROM attendance_slots s
          WHERE NOT EXISTS (
            SELECT 1
              FROM program_assignments pa
              JOIN programs p ON p.id = pa.program_id
             WHERE pa.employee_mobile = s.employee_mobile
               AND p.state IN ('CONFIRMED','RELEASED')
               AND s.day BETWEEN p.start_date AND coalesce(p.end_date, p.start_date)
          )
          GROUP BY s.employee_mobile
       ), paid AS (
         SELECT i.employee_mobile, sum(p.amount_minor)::bigint AS total_paid
           FROM cash_postings p
           JOIN cash_instructions i ON i.id = p.instruction_id
          WHERE i.state = 'POSTED' AND i.employee_mobile IS NOT NULL
          GROUP BY i.employee_mobile
       ), security AS (
         -- Security attendance is the same set as non-vessel attendance: every
         -- legacy, imported and frontend-entered row not covered by a vessel day.
         SELECT employee_mobile, days FROM non_vessel
       ), days AS (
         SELECT e.employee_mobile,
                coalesce(v.days, 0) AS vessel_days,
                coalesce(n.days, 0) AS non_vessel_days,
                coalesce(s.days, 0) AS security_days,
                coalesce(v.days, 0) + coalesce(n.days, 0) AS total_days
           FROM employees e
           LEFT JOIN vessel v ON v.employee_mobile = e.employee_mobile
           LEFT JOIN non_vessel n ON n.employee_mobile = e.employee_mobile
           LEFT JOIN security s ON s.employee_mobile = e.employee_mobile
       )
       SELECT e.employee_mobile,
              e.preferred_name,
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
        ORDER BY e.preferred_name`,
      [DAILY_RATE_MINOR],
    );
    return ok({rows: data, dailyRateMinor: DAILY_RATE_MINOR});
  } catch (error) {
    return errorResponse(error);
  }
}
