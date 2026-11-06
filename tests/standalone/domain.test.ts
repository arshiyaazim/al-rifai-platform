// Domain-level integration tests. Require the disposable database prepared by
// scripts/standalone/install.mjs (see tests/standalone/README.md).
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {createHash} from 'node:crypto';
import {rows, row} from '../../lib/standalone/db.ts';
import {createEmployee, updateEmployee, listEmployees} from '../../lib/standalone/employees.ts';
import {createProgram, assignEscort, releaseProgram, listPrograms} from '../../lib/standalone/programs.ts';
import {recordAttendance, attendanceSummary} from '../../lib/standalone/attendance.ts';
import {createInstruction, approveInstruction, postInstruction, listAccounts, createLedgerEntry, incomeExpense} from '../../lib/standalone/finance.ts';
import {submitForReview, decideReview} from '../../lib/standalone/review.ts';
import {upsertRate, monthlySalary} from '../../lib/standalone/payroll.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {resetBusinessState} from './reset.mjs';

before(async () => { await resetBusinessState('alrifai-domain-test-reset'); });

const adminA = {id: 'a'.repeat(64), role: 'ADMIN' as const};
const adminB = {id: 'b'.repeat(64), role: 'ADMIN' as const};
const user = {id: 'c'.repeat(64), role: 'USER' as const};

async function ensureUser(id, username, role) {
  const hash = await hashBootstrapPassword('TestPass123');
  await row(
    `INSERT INTO cash_portal_users (id, username, password_hash, role, display_name, must_change_password, active, capabilities)
     VALUES ($1,$2,$3,$4,$4,false,true,'["workspace.admin"]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, username, hash, role],
  );
}

test('setup: rate + actors', async () => {
  await ensureUser(adminA.id, 'admin-a', 'ADMIN');
  await ensureUser(adminB.id, 'admin-b', 'ADMIN');
  await ensureUser(user.id, 'staff-c', 'USER');
  await upsertRate(adminA, {destinationKey: 'default', destinationLabel: 'Default', shiftRateMinor: 20000, conveyanceMinor: 0});
  const rates = await rows('SELECT * FROM rate_config');
  assert.ok(rates.length >= 1);
});

test('employees: create, alias merge, duplicate prevention', async () => {
  const created = await createEmployee(adminA, {employeeMobile: '01712345678', preferredName: 'Rahim Uddin', dutyType: 'escort'});
  assert.equal(created.created, true);
  const again = await createEmployee(adminA, {employeeMobile: '01712345678', preferredName: 'Rahim Uddin'});
  assert.equal(again.created, false);
  const aliased = await createEmployee(adminA, {employeeMobile: '+8801712345678', preferredName: 'Rahim U.'});
  assert.equal(aliased.created, false);
  const employee = await row('SELECT name_aliases FROM employees WHERE employee_mobile = $1', [created.employeeMobile]);
  assert.ok(employee.name_aliases.includes('Rahim U.'));
  assert.equal((await listEmployees({q: 'rahim'})).length, 1);
});

test('programs: create, duplicate, assignment, release, pay', async () => {
  const program = await createProgram(adminA, {
    motherVessel: 'MV Test', lighterVessel: 'Lighter-1', startDate: '2026-11-01', startShift: 'D',
    escortMobile: '01712345678', escortName: 'Rahim Uddin',
  }, {channel: 'WEB'});
  assert.equal(program.program.state, 'ASSIGNED');

  await assert.rejects(
    () => createProgram(adminA, {motherVessel: 'MV Test', lighterVessel: 'Lighter-1', startDate: '2026-11-01', startShift: 'D'}),
    /DUPLICATE_PROGRAM/,
  );

  // ±1 day is a warning, not a block, and only for the same lighter.
  const near = await createProgram(adminA, {
    motherVessel: 'MV Test', lighterVessel: 'Lighter-1', startDate: '2026-11-02', startShift: 'D',
  });
  assert.equal(near.potentialDuplicates.length, 1);
  assert.equal(near.program.state, 'DRAFT');

  // Different lighter on the same day is a distinct record.
  const sibling = await createProgram(adminA, {
    motherVessel: 'MV Test', lighterVessel: 'Lighter-2', startDate: '2026-11-01', startShift: 'D',
  });
  assert.notEqual(sibling.program.id, program.program.id);

  await releaseProgram(adminA, program.program.id, {endDate: '2026-11-10', endShift: 'D'});
  const pay = await row('SELECT shifts, total_minor, state FROM program_pay WHERE program_id = $1', [program.program.id]);
  assert.equal(pay.state, 'CALCULATED');
  assert.equal(Number(pay.shifts), 19);
  assert.equal(Number(pay.total_minor), 380000);

  const assigned = await createProgram(adminA, {
    motherVessel: 'MV Other', lighterVessel: 'L-9', startDate: '2026-11-03', startShift: 'N',
  });
  await assignEscort(adminA, assigned.program.id, {employeeMobile: '01712345678', employeeName: 'Rahim Uddin'});
  const assignment = await row('SELECT * FROM program_assignments WHERE program_id = $1 AND end_date IS NULL', [assigned.program.id]);
  assert.ok(assignment);
  assert.equal((await listPrograms({})).length, 4);
});

test('attendance: record + upsert + summary', async () => {
  await recordAttendance(adminA, {employeeMobile: '01712345678', dutyDate: '2026-11-05', shift: 'D', state: 'PRESENT', hours: 12});
  await recordAttendance(adminA, {employeeMobile: '01712345678', dutyDate: '2026-11-05', shift: 'D', state: 'PRESENT', hours: 10});
  const summary = await attendanceSummary('2026-11');
  assert.equal(summary[0].present, 1);
  const count = await row('SELECT count(*)::int AS n FROM attendance');
  assert.equal(count.n, 1);
});

test('finance: instruction, approval, posting, ledger balance', async () => {
  const [account] = await listAccounts();
  const before = Number(account.balance_minor);

  const instruction = await createInstruction(adminA, {
    employeeName: 'Rahim Uddin', employeeMobile: '+8801712345678',
    method: 'bkash', amountMinor: 150000, accountId: account.id, purpose: 'Duty pay',
  });
  assert.equal(instruction.state, 'REVIEW');

  await assert.rejects(() => postInstruction(adminA, instruction.id), /INSTRUCTION_NOT_APPROVED/);
  await assert.rejects(() => approveInstruction(adminA, instruction.id), /REVIEWER_IS_SUBMITTER/);
  await approveInstruction(adminB, instruction.id);
  const posted = await postInstruction(adminB, instruction.id);
  assert.equal(posted.state, 'POSTED');

  const after = (await listAccounts())[0];
  assert.equal(Number(after.balance_minor), before - 150000);

  const ledger = await rows("SELECT * FROM ledger_entries WHERE instruction_id = $1", [instruction.id]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].direction, 'DEBIT');

  // Posting is immutable and happens exactly once.
  await assert.rejects(() => postInstruction(adminB, instruction.id), /INSTRUCTION_NOT_APPROVED/);
  await assert.rejects(() => row('UPDATE ledger_entries SET amount_minor = 1 WHERE id = $1', [ledger[0].id]), /IMMUTABLE|permission denied/);
});

test('finance: income entry and report', async () => {
  const [account] = await listAccounts();
  await createLedgerEntry(adminA, {accountId: account.id, entryDate: '2026-11-06', direction: 'CREDIT', amountMinor: 500000, category: 'service income'});
  const report = await incomeExpense('2026-11-01', '2026-11-30');
  assert.ok(report.income >= 500000);
  assert.ok(report.expense >= 150000);
  assert.equal(report.net, report.income - report.expense);
});

test('review: staff submit, admin decides, self-review refused', async () => {
  const item = await submitForReview(user, {
    domain: 'EMPLOYEE', action: 'CREATE',
    payload: {employeeMobile: '01812345678', preferredName: 'Karim Mia', dutyType: 'crew'},
  });
  assert.equal(item.state, 'PENDING');
  await assert.rejects(() => decideReview(user, item.id, 'APPROVED'), /ADMIN_REQUIRED|CAPABILITY_REQUIRED/);
  const decided = await decideReview(adminA, item.id, 'APPROVED');
  assert.equal(decided.state, 'APPROVED');
  const employee = await row('SELECT preferred_name FROM employees WHERE employee_mobile = $1', ['+8801812345678']);
  assert.equal(employee.preferred_name, 'Karim Mia');
});

test('payroll: monthly allocation splits a cross-month program', async () => {
  const program = await createProgram(adminA, {
    motherVessel: 'MV Month', lighterVessel: 'L-1', startDate: '2026-10-30', startShift: 'D',
  });
  await releaseProgram(adminA, program.program.id, {endDate: '2026-11-02', endShift: 'D'});
  const october = await monthlySalary('2026-10');
  const november = await monthlySalary('2026-11');
  // 30 Oct D → 02 Nov D: Oct 30 D+N, Oct 31 D+N, Nov 1 D+N, Nov 2 D = 7 shifts
  assert.equal(october.shifts, 4, `october shifts ${october.shifts}`);
  // November also contains the earlier 1-10 Nov program (19 shifts).
  assert.ok(november.shifts >= 3, `november shifts ${november.shifts}`);
});

test('audit: append-only', async () => {
  const entry = await row('SELECT id FROM audit_events LIMIT 1');
  assert.ok(entry);
  await assert.rejects(() => row('DELETE FROM audit_events WHERE id = $1', [entry.id]), /IMMUTABLE|permission denied/);
});
