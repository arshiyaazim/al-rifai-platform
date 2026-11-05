import {rows, row, tx, isoDate, shift, mobile, text, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';

export type AttendanceInput = {
  employeeMobile: string;
  dutyDate: string;
  shift: string;
  state?: 'PRESENT' | 'ABSENT' | 'LEAVE';
  hours?: number | null;
};

export async function recordAttendance(actor: Actor, input: AttendanceInput) {
  const employeeMobile = mobile(input.employeeMobile, 'employeeMobile');
  const dutyDate = isoDate(input.dutyDate, 'dutyDate');
  const dutyShift = shift(input.shift);
  const state = input.state ?? 'PRESENT';
  if (!['PRESENT', 'ABSENT', 'LEAVE'].includes(state)) throw new DomainError('INVALID_ATTENDANCE_STATE');
  const hours = input.hours === undefined || input.hours === null ? null : Number(input.hours);
  if (hours !== null && (!Number.isFinite(hours) || hours < 0 || hours > 24)) throw new DomainError('INVALID_HOURS');

  return tx(async (client) => {
    const employee = await client.query('SELECT 1 FROM employees WHERE employee_mobile = $1', [employeeMobile]);
    if (!employee.rowCount) throw new DomainError('EMPLOYEE_NOT_FOUND', 404);
    const id = stableId('att', [employeeMobile, dutyDate, dutyShift]);
    const result = await client.query(
      `INSERT INTO attendance (id, employee_mobile, duty_date, shift, state, hours, source, recorded_by)
       VALUES ($1,$2,$3,$4,$5,$6,'WEB',$7)
       ON CONFLICT (employee_mobile, duty_date, shift) DO UPDATE
         SET state = EXCLUDED.state, hours = EXCLUDED.hours
       RETURNING *`,
      [id, employeeMobile, dutyDate, dutyShift, state, hours, actor.id],
    );
    await recordAudit({actor, action: 'ATTENDANCE_RECORDED', entity: 'attendance', entityId: id,
      detail: {employeeMobile, dutyDate, shift: dutyShift, state, hours}});
    return result.rows[0];
  });
}

export async function listAttendance(filters: {from?: string; to?: string; employee?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  return rows(
    `SELECT a.id, a.employee_mobile, e.preferred_name, a.duty_date::text AS duty_date, a.shift, a.state, a.hours
       FROM attendance a LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
      WHERE ($1::date IS NULL OR a.duty_date >= $1)
        AND ($2::date IS NULL OR a.duty_date <= $2)
        AND ($3::text IS NULL OR a.employee_mobile = $3)
      ORDER BY a.duty_date DESC, a.shift DESC
      LIMIT $4`,
    [filters.from ?? null, filters.to ?? null, filters.employee ?? null, limit],
  );
}

export async function attendanceSummary(month?: string) {
  const key = /^\d{4}-\d{2}$/.test(month ?? '') ? month! : new Date().toISOString().slice(0, 7);
  return rows(
    `SELECT employee_mobile, count(*) FILTER (WHERE state = 'PRESENT')::int AS present,
            count(*) FILTER (WHERE state = 'ABSENT')::int AS absent,
            count(*) FILTER (WHERE state = 'LEAVE')::int AS leave,
            count(*)::int AS days
       FROM attendance
      WHERE to_char(duty_date, 'YYYY-MM') = $1
      GROUP BY employee_mobile ORDER BY employee_mobile`,
    [key],
  );
}

export async function deleteAttendance(actor: Actor, id: string) {
  const existing = await row<{id: string}>('SELECT id FROM attendance WHERE id = $1', [id]);
  if (!existing) throw new DomainError('ATTENDANCE_NOT_FOUND', 404);
  await row('DELETE FROM attendance WHERE id = $1 RETURNING id', [id]);
  await recordAudit({actor, action: 'ATTENDANCE_DELETED', entity: 'attendance', entityId: id});
  return {id};
}

export const attendanceText = text;
