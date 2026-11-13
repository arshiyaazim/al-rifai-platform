// AL-RIFA'I — Cash employee resolution.
//
// Operator rule: a Cash payment must NEVER be dropped because the paying
// employee is not yet registered. When the mobile number is unknown, create
// the employee record from the message and continue recording the payment.
//
// Matching is digits-only, so `01581138565`, `01581-138565`, `+8801581138565`
// and `8801581138565` all resolve to the same person. The canonical stored
// mobile is always `+8801XXXXXXXXX` (the employees table CHECK constraint).

import {row} from './db.ts';

export type CashEmployee = {
  employee_mobile: string;
  preferred_name: string;
  /** True when this call created the row. */
  created: boolean;
};

export const AUTO_CREATED_MARKER = 'AUTO_CREATED_FROM_CASH';

/** Last 11 digits of any mobile form, used for digits-only matching. */
function nationalDigits(value: string): string {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  return digits.slice(-11);
}

async function findEmployee(national: string): Promise<CashEmployee | null> {
  return row<CashEmployee>(
    `SELECT employee_mobile, preferred_name
       FROM employees
      WHERE right(regexp_replace(employee_mobile, '[^0-9]', '', 'g'), 11) = $1
      ORDER BY created_at
      LIMIT 1`,
    [national],
  );
}

/**
 * Resolve an employee by national mobile digits, creating the record when it
 * does not exist. Never throws for a missing employee — only for a genuinely
 * malformed number or a database failure.
 */
export async function findOrCreateEmployeeByMobile(
  nationalMobile: string,
  nameHint: string,
  createdBy = 'system',
  /** Asia/Dhaka date (YYYY-MM-DD) of the triggering message. Never now(). */
  joinDate: string | null = null,
): Promise<CashEmployee> {
  const national = nationalDigits(nationalMobile);
  if (!/^01[3-9][0-9]{8}$/.test(national)) {
    throw new Error(`EMPLOYEE_MOBILE_INVALID:${nationalMobile}`);
  }

  const existing = await findEmployee(national);
  if (existing) return {...existing, created: false};

  const canonical = `+88${national}`;
  const preferredName = (String(nameHint ?? '').trim() || 'UNKNOWN').slice(0, 150);
  const notes = `${AUTO_CREATED_MARKER}: first seen in an outbound Cash payment (mobile ${national})`;

  const inserted = await row<{employee_mobile: string; preferred_name: string}>(
    `INSERT INTO employees (employee_mobile, preferred_name, notes, created_by, date_of_join, joined_on)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (employee_mobile) DO NOTHING
     RETURNING employee_mobile, preferred_name`,
    [canonical, preferredName, notes.slice(0, 2000), createdBy, joinDate],
  );
  if (inserted) return {...inserted, created: true};

  // A concurrent insert won the race; read the winning row.
  const raced = await findEmployee(national);
  if (raced) return {...raced, created: false};
  throw new Error(`EMPLOYEE_CREATE_FAILED:${national}`);
}
