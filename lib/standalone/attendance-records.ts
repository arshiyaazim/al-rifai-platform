import {row, rows, tx, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';
import {assertCapability} from './authz.ts';
import {DomainError, isoDate, mobile, optionalText, text} from './db.ts';

export type AttendanceRecordInput = {
  employeeMobile: string;
  attendanceDate: string;
  shift: 'D' | 'N' | 'FULL';
  location?: string | null;
  clientName?: string | null;
  designation?: string | null;
  remarks?: string | null;
};

const SHIFTS = new Set(['D', 'N', 'FULL']);

export async function createAttendanceRecord(
  actor: Actor,
  input: AttendanceRecordInput,
  client?: Pick<import('pg').PoolClient, 'query'>,
) {
  assertCapability(actor as never, 'attendance.manage');
  const employeeMobile = mobile(input.employeeMobile, 'employeeMobile');
  const attendanceDate = isoDate(input.attendanceDate, 'attendanceDate');
  const shift = String(input.shift ?? '').toUpperCase();
  if (!SHIFTS.has(shift)) throw new DomainError('INVALID_SHIFT');
  const location = optionalText(input.location, 'location', 250);
  const clientName = optionalText(input.clientName, 'clientName', 150);
  const designation = optionalText(input.designation, 'designation', 80);
  const remarks = optionalText(input.remarks, 'remarks', 2000);
  const run = async (txClient: Pick<import('pg').PoolClient, 'query'>) => {
    const employee = await txClient.query<{designation: string | null}>(
      'SELECT designation FROM employees WHERE employee_mobile = $1', [employeeMobile],
    );
    if (!employee.rowCount) throw new DomainError('EMPLOYEE_NOT_FOUND', 404);
    const id = stableId('att', [employeeMobile, attendanceDate, shift]);
    const created = await txClient.query(
      `INSERT INTO attendance_records
         (id, employee_mobile, attendance_date, shift, location, client_name, designation, remarks, created_by, state)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'ACTIVE')
       ON CONFLICT (employee_mobile, attendance_date, shift) DO NOTHING
       RETURNING *`,
      [id, employeeMobile, attendanceDate, shift, location, clientName,
        designation ?? employee.rows[0].designation, remarks, actor.id],
    );
    if (!created.rowCount) throw new DomainError('ATTENDANCE_EXISTS', 409);
    await recordAudit({actor, action: 'ATTENDANCE_RECORDED', entity: 'attendance_record',
      entityId: id, detail: {employeeMobile, attendanceDate, shift, location, clientName}}, txClient);
    return created.rows[0];
  };
  return client ? run(client) : tx(run);
}

export type AttendanceRecordFilters = {
  employeeMobile?: string;
  from?: string;
  to?: string;
  month?: string;
  clientName?: string;
  limit?: number;
  offset?: number;
};

export async function listAttendanceRecords(filters: AttendanceRecordFilters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  return rows(
    `SELECT a.id, a.employee_mobile, e.preferred_name, a.attendance_date::text AS attendance_date,
            a.shift, a.location, a.client_name, a.designation, a.remarks, a.state,
            to_char(a.attendance_date, 'FMDay') AS day_name,
            extract(dow FROM a.attendance_date) IN (5,6) AS is_weekend
       FROM attendance_records a
       LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
      WHERE ($1::text IS NULL OR a.employee_mobile = $1)
        AND ($2::date IS NULL OR a.attendance_date >= $2)
        AND ($3::date IS NULL OR a.attendance_date <= $3)
        AND ($4::text IS NULL OR to_char(a.attendance_date, 'YYYY-MM') = $4)
        AND ($5::text IS NULL OR a.client_name ILIKE '%' || $5 || '%')
        AND a.state = 'ACTIVE'
      ORDER BY a.attendance_date DESC, a.shift DESC
      LIMIT $6 OFFSET $7`,
    [filters.employeeMobile ?? null, filters.from ?? null, filters.to ?? null,
      filters.month ?? null, filters.clientName ?? null, limit, offset],
  );
}

export type AttendancePatch = Partial<Omit<AttendanceRecordInput, 'employeeMobile'>>;

export async function updateAttendanceRecord(actor: Actor, id: string, patch: AttendancePatch) {
  assertCapability(actor as never, 'attendance.manage');
  const key = text(id, 'id', {max: 160});
  return tx(async (client) => {
    const found = await client.query('SELECT * FROM attendance_records WHERE id = $1 AND state = $2 FOR UPDATE',
      [key, 'ACTIVE']);
    if (!found.rowCount) throw new DomainError('ATTENDANCE_NOT_FOUND', 404);
    const current = found.rows[0];
    const attendanceDate = patch.attendanceDate ? isoDate(patch.attendanceDate, 'attendanceDate') : current.attendance_date;
    const shift = patch.shift ? String(patch.shift).toUpperCase() : current.shift;
    if (!SHIFTS.has(shift)) throw new DomainError('INVALID_SHIFT');
    const updated = await client.query(
      `UPDATE attendance_records
          SET attendance_date=$2, shift=$3, location=$4, client_name=$5,
              designation=$6, remarks=$7, updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [key, attendanceDate, shift,
        patch.location === undefined ? current.location : optionalText(patch.location, 'location', 250),
        patch.clientName === undefined ? current.client_name : optionalText(patch.clientName, 'clientName', 150),
        patch.designation === undefined ? current.designation : optionalText(patch.designation, 'designation', 80),
        patch.remarks === undefined ? current.remarks : optionalText(patch.remarks, 'remarks', 2000)],
    );
    await recordAudit({actor, action: 'ATTENDANCE_CORRECTED', entity: 'attendance_record',
      entityId: key, detail: {patch}}, client);
    return updated.rows[0];
  });
}

export async function voidAttendanceRecord(actor: Actor, id: string) {
  assertCapability(actor as never, 'attendance.manage');
  const key = text(id, 'id', {max: 160});
  return tx(async (client) => {
    const updated = await client.query(
      `UPDATE attendance_records SET state='VOIDED', updated_at=now()
        WHERE id=$1 AND state='ACTIVE' RETURNING id`,
      [key],
    );
    if (!updated.rowCount) throw new DomainError('ATTENDANCE_NOT_FOUND', 404);
    await recordAudit({actor, action: 'ATTENDANCE_VOIDED', entity: 'attendance_record', entityId: key}, client);
    return {id: key, state: 'VOIDED'};
  });
}

export async function unifiedAttendance(input: {employeeMobile?: string; month?: string; from?: string; to?: string}) {
  const isoDay = /^\d{4}-\d{2}-\d{2}$/;
  const month = /^\d{4}-\d{2}$/.test(input.month ?? '') ? String(input.month) : new Date().toISOString().slice(0, 7);
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).toISOString().slice(0, 10);
  const from = isoDay.test(input.from ?? '') ? String(input.from) : `${month}-01`;
  const to = isoDay.test(input.to ?? '') ? String(input.to) : lastDay;
  const employee = input.employeeMobile ? mobile(input.employeeMobile, 'employeeMobile') : null;
  const vessel = await rows<Record<string, unknown>>(
    `SELECT pa.employee_mobile, e.preferred_name,
            p.start_date::text AS attendance_date, p.start_shift AS shift,
            coalesce(p.mother_vessel_normalized, p.mother_vessel) AS location,
            NULL::text AS client_name, e.designation,
            NULL::text AS remarks, 'VESSEL' AS source,
            pp.shifts AS vessel_shifts, p.state AS program_state, p.id AS source_id
       FROM program_assignments pa
       JOIN programs p ON p.id = pa.program_id
       JOIN program_pay pp ON pp.program_id = p.id
       LEFT JOIN employees e ON e.employee_mobile = pa.employee_mobile
      WHERE p.state IN ('CONFIRMED','RELEASED')
        AND p.start_date >= $1::date
        AND p.start_date <= $2::date
        AND ($3::text IS NULL OR pa.employee_mobile = $3)`,
    [from, to, employee],
  );
  const manual = await rows<Record<string, unknown>>(
    `SELECT a.id AS source_id, a.employee_mobile, e.preferred_name,
            a.attendance_date::text AS attendance_date, a.shift, a.location,
            a.client_name, a.designation, a.remarks, 'NON_VESSEL' AS source,
            NULL::int AS vessel_shifts, a.state AS program_state
       FROM attendance_records a
       LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
      WHERE a.state = 'ACTIVE'
        AND a.attendance_date >= $1::date
        AND a.attendance_date <= $2::date
        AND ($3::text IS NULL OR a.employee_mobile = $3)`,
    [from, to, employee],
  );
  const all: Array<Record<string, unknown>> = [...vessel, ...manual].map((rowData): Record<string, unknown> => {
    const date = String(rowData.attendance_date);
    const dayName = new Intl.DateTimeFormat('en-US', {weekday: 'long', timeZone: 'Asia/Dhaka'})
      .format(new Date(`${date}T00:00:00+06:00`));
    const dow = new Date(`${date}T12:00:00+06:00`).getUTCDay();
    return {...rowData, day_name: dayName, is_weekend: dow === 5 || dow === 6};
  }).sort((left, right) => String(right.attendance_date).localeCompare(String(left.attendance_date)));

  const vesselDays = vessel.reduce((sum, item) => sum + Number(item.vessel_shifts ?? 0) / 2, 0);
  const nonVesselDays = manual.reduce((sum, item) => sum + (item.shift === 'FULL' ? 1 : 0.5), 0);
  const totalDays = vesselDays + nonVesselDays;
  const active = await row<{count: string}>("SELECT count(*)::text AS count FROM employees WHERE state = 'ACTIVE'");
  return {
    rows: all,
    range: {from, to},
    summary: {
      vesselDays,
      nonVesselDays,
      totalDays,
      salaryMinor: Math.round(totalDays * 40000),
      activeEmployees: Number(active?.count ?? 0),
    },
  };
}

export async function attendanceRecordById(id: string) {
  return row('SELECT * FROM attendance_records WHERE id = $1', [id]);
}
