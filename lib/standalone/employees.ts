import type {PoolClient} from 'pg';
import {row, rows, tx, text, optionalText, mobile, isoDate, DomainError, type Actor} from './db.ts';
import {recordAudit} from './audit.ts';
import {assertCapability} from './authz.ts';

export type EmployeeRow = {
  employee_mobile: string;
  preferred_name: string;
  name_aliases: string[];
  duty_type: string | null;
  designation: string | null;
  state: string;
  joined_on: string | null;
  notes: string | null;
  revision: number;
  created_at: string;
  updated_at: string;
};

export type EmployeeSuggestion = Pick<
  EmployeeRow,
  'employee_mobile' | 'preferred_name' | 'name_aliases' | 'designation' | 'state'
>;

export const EMPLOYEE_SUGGESTION_LIMIT = 10;

function mobileSearchKey(digits: string): string | null {
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  return null;
}

/**
 * Cash employee typeahead. The verified employee identifier in this schema is
 * `employees.employee_mobile` (the primary key); no second identifier is
 * invented. Search covers the preferred name, recorded aliases and mobile.
 */
export async function searchEmployees(query: string, limit = EMPLOYEE_SUGGESTION_LIMIT): Promise<EmployeeSuggestion[]> {
  const q = query.trim().toLowerCase().slice(0, 100);
  if (!q) return [];
  const digits = q.replace(/\D/g, '');
  const exactMobile = mobileSearchKey(digits);
  const max = Math.min(Math.max(Number(limit) || EMPLOYEE_SUGGESTION_LIMIT, 1), EMPLOYEE_SUGGESTION_LIMIT);
  return rows<EmployeeSuggestion>(
    `SELECT e.employee_mobile, e.preferred_name, e.name_aliases, e.designation, e.state
       FROM employees e
      WHERE lower(e.preferred_name) LIKE '%' || $1 || '%'
         OR EXISTS (
              SELECT 1 FROM unnest(e.name_aliases) AS alias
               WHERE lower(alias) LIKE '%' || $1 || '%'
            )
         OR ($2 <> '' AND e.employee_mobile LIKE '%' || $2 || '%')
      ORDER BY
        CASE
          WHEN lower(e.preferred_name) LIKE $1 || '%' THEN 0
          WHEN $3::text IS NOT NULL AND e.employee_mobile = $3 THEN 0
          ELSE 1
        END,
        (e.state = 'ACTIVE') DESC,
        e.preferred_name
      LIMIT $4`,
    [q, digits, exactMobile, max],
  );
}

export async function listEmployees(filters: {q?: string; state?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const q = (filters.q ?? '').trim().toLowerCase();
  return rows<EmployeeRow & {programs: string; attendance_days: string}>(
    `SELECT e.employee_mobile, e.preferred_name, e.name_aliases, e.duty_type, e.designation,
            e.state, e.joined_on::text AS joined_on, e.notes, e.revision, e.created_at, e.updated_at,
            (SELECT count(*)::text FROM programs p WHERE p.escort_mobile = e.employee_mobile AND p.state <> 'VOIDED') AS programs,
            (SELECT count(DISTINCT a.duty_date)::text FROM attendance a WHERE a.employee_mobile = e.employee_mobile) AS attendance_days
       FROM employees e
      WHERE ($1 = '' OR lower(e.preferred_name) LIKE '%' || $1 || '%' OR e.employee_mobile LIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR e.state = $2)
      ORDER BY e.preferred_name
      LIMIT $3`,
    [q, filters.state ?? null, limit],
  );
}

export async function getEmployee(employeeMobile: string) {
  const key = mobile(employeeMobile, 'employeeMobile');
  const employee = await row<EmployeeRow>(
    `SELECT employee_mobile, preferred_name, name_aliases, duty_type, designation, state,
            joined_on::text AS joined_on, notes, revision, created_at, updated_at
       FROM employees WHERE employee_mobile = $1`, [key]);
  if (!employee) throw new DomainError('EMPLOYEE_NOT_FOUND', 404);
  const programs = await rows(
    `SELECT p.id, p.mother_vessel, p.lighter_vessel, p.start_date::text AS start_date, p.start_shift, p.end_date::text AS end_date, p.state,
            pp.salary_minor, pp.conveyance_minor, pp.total_minor, pp.state AS pay_state
       FROM programs p LEFT JOIN program_pay pp ON pp.program_id = p.id
      WHERE p.escort_mobile = $1 ORDER BY p.start_date DESC LIMIT 50`,
    [key],
  );
  const attendance = await rows(
    `SELECT duty_date::text AS duty_date, shift, state, hours FROM attendance WHERE employee_mobile = $1
      ORDER BY duty_date DESC, shift DESC LIMIT 30`,
    [key],
  );
  return {employee, programs, attendance};
}

export type EmployeeInput = {
  employeeMobile: string;
  preferredName: string;
  dutyType?: string | null;
  designation?: string | null;
  joinedOn?: string | null;
  notes?: string | null;
};

async function createEmployeeOn(client: Pick<PoolClient, 'query'>, actor: Actor, input: EmployeeInput) {
  const employeeMobile = mobile(input.employeeMobile, 'employeeMobile');
  const preferredName = text(input.preferredName, 'preferredName', {max: 150});
  const dutyType = optionalText(input.dutyType, 'dutyType', 20);
  if (dutyType && !['escort', 'crew', 'office', 'other'].includes(dutyType)) {
    throw new DomainError('INVALID_DUTY_TYPE');
  }
  const designation = optionalText(input.designation, 'designation', 80);
  const joinedOn = input.joinedOn ? isoDate(input.joinedOn, 'joinedOn') : null;
  const notes = optionalText(input.notes, 'notes', 2000);

  const existing = await client.query<{employee_mobile: string; preferred_name: string}>(
    'SELECT employee_mobile, preferred_name FROM employees WHERE employee_mobile = $1',
    [employeeMobile],
  );
  if (existing.rowCount) {
    // Same mobile = same employee. A different name becomes an alias, never a
    // second employee.
    const current = existing.rows[0];
    if (current.preferred_name.toLowerCase() !== preferredName.toLowerCase()) {
      await client.query(
        `UPDATE employees
            SET name_aliases = (
                  SELECT array_agg(DISTINCT v) FROM unnest(name_aliases || ARRAY[$1]::text[]) AS v
                ),
                revision = revision + 1
          WHERE employee_mobile = $2`,
        [preferredName, employeeMobile],
      );
    }
    await recordAudit({actor, action: 'EMPLOYEE_EXISTS', entity: 'employee', entityId: employeeMobile}, client);
    return {created: false, employeeMobile};
  }
  await client.query(
    `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, joined_on, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [employeeMobile, preferredName, dutyType, designation, joinedOn, notes, actor.id],
  );
  await recordAudit({
    actor, action: 'EMPLOYEE_CREATED', entity: 'employee', entityId: employeeMobile,
    detail: {preferredName, dutyType},
  }, client);
  return {created: true, employeeMobile};
}

export async function createEmployee(actor: Actor, input: EmployeeInput, client?: Pick<PoolClient, 'query'>) {
  assertCapability(actor, 'employee.manage');
  if (client) return createEmployeeOn(client, actor, input);
  return tx((txClient) => createEmployeeOn(txClient, actor, input));
}

async function updateEmployeeOn(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  employeeMobile: string,
  patch: {preferredName?: string; dutyType?: string | null; designation?: string | null; state?: string; notes?: string | null},
) {
  const key = mobile(employeeMobile, 'employeeMobile');
  const existing = await client.query<EmployeeRow>('SELECT * FROM employees WHERE employee_mobile = $1 FOR UPDATE', [key]);
  const employee = existing.rows[0];
  if (!employee) throw new DomainError('EMPLOYEE_NOT_FOUND', 404);
  const nextState = patch.state ?? employee.state;
  if (!['ACTIVE', 'INACTIVE', 'SUSPENDED'].includes(nextState)) throw new DomainError('INVALID_STATE');
  const dutyType = patch.dutyType === undefined ? employee.duty_type : optionalText(patch.dutyType, 'dutyType', 20);
  if (dutyType && !['escort', 'crew', 'office', 'other'].includes(dutyType)) throw new DomainError('INVALID_DUTY_TYPE');
  const updated = await client.query<EmployeeRow>(
    `UPDATE employees
        SET preferred_name = $2, duty_type = $3, designation = $4, state = $5, notes = $6,
            revision = revision + 1
      WHERE employee_mobile = $1
      RETURNING *`,
    [
      key,
      patch.preferredName ? text(patch.preferredName, 'preferredName', {max: 150}) : employee.preferred_name,
      dutyType,
      patch.designation === undefined ? employee.designation : optionalText(patch.designation, 'designation', 80),
      nextState,
      patch.notes === undefined ? employee.notes : optionalText(patch.notes, 'notes', 2000),
    ],
  );
  await recordAudit({actor, action: 'EMPLOYEE_UPDATED', entity: 'employee', entityId: key, detail: {patch}}, client);
  return updated.rows[0];
}

export async function updateEmployee(
  actor: Actor,
  employeeMobile: string,
  patch: {preferredName?: string; dutyType?: string | null; designation?: string | null; state?: string; notes?: string | null},
  client?: Pick<PoolClient, 'query'>,
) {
  assertCapability(actor, 'employee.manage');
  if (client) return updateEmployeeOn(client, actor, employeeMobile, patch);
  return tx((txClient) => updateEmployeeOn(txClient, actor, employeeMobile, patch));
}
