// Task 1 end-to-end verification: exercise the mutation services that every
// audited form calls, then assert the database state and audit trail.
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {row, rows} from '../../lib/standalone/db.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {
  approveInstruction, correctCashTransaction, createInstruction, createLedgerEntry,
  postInstruction, rejectInstruction, reverseCashTransaction, updateCashTransaction,
} from '../../lib/standalone/finance.ts';
import {
  assignEscort, completeProgram, createProgram, releaseProgram, updateProgram,
} from '../../lib/standalone/programs.ts';
import {createEmployee, getEmployee, updateEmployee} from '../../lib/standalone/employees.ts';
import {decideReview, submitForReview} from '../../lib/standalone/review.ts';
import {resetBusinessState} from './reset.mjs';

const adminA = {id: 'fa'.repeat(32), role: 'ADMIN'};
const adminB = {id: 'fb'.repeat(32), role: 'ADMIN'};
const staff = {id: 'fc'.repeat(32), role: 'USER'};

before(async () => {
  await resetBusinessState('alrifai-form-audit-reset');
  const hash = await hashBootstrapPassword('TestPass123');
  for (const [id, username, role] of [
    [adminA.id, 'audit-admin-a', 'ADMIN'],
    [adminB.id, 'audit-admin-b', 'ADMIN'],
    [staff.id, 'audit-staff', 'USER'],
  ]) {
    await row(
      `INSERT INTO cash_portal_users (id, username, password_hash, role, display_name, must_change_password, active, capabilities)
       VALUES ($1,$2,$3,$4,$2,false,true,'["workspace.admin"]'::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [id, username, hash, role],
    );
  }
});

async function auditCount(action, entityId) {
  const value = await row(
    'SELECT count(*)::int AS n FROM audit_events WHERE action = $1 AND entity_id = $2',
    [action, entityId],
  );
  return value.n;
}

test('cash: instruction, edit, approve, post, correction and reversal all audit', async () => {
  await createEmployee(adminA, {employeeMobile: '01766666666', preferredName: 'Audit Payee', dutyType: 'escort'});
  const instruction = await createInstruction(adminA, {
    employeeMobile: '01766666666', employeeName: 'Audit Payee', method: 'bkash', amountMinor: 10000, accountId: 'acc-cash',
  });
  assert.ok(instruction?.id);
  assert.equal(await auditCount('INSTRUCTION_CREATED', instruction.id), 1);

  await updateCashTransaction(adminA, instruction.id, {designation: 'Senior escort', notes: 'audit note'});
  const edited = await row('SELECT purpose FROM cash_instructions WHERE id = $1', [instruction.id]);
  assert.equal(edited.purpose, 'audit note');
  assert.equal(await auditCount('CASH_TRANSACTION_UPDATED', instruction.id), 1);

  await approveInstruction(adminB, instruction.id);
  await postInstruction(adminB, instruction.id);
  const posted = await row(
    'SELECT state, amount_minor::text FROM cash_instructions WHERE id = $1', [instruction.id],
  );
  assert.equal(posted.state, 'POSTED');
  assert.equal(Number(posted.amount_minor), 10000);
  assert.equal(await auditCount('INSTRUCTION_POSTED', instruction.id), 1);

  // Financial fields are locked after posting; designation/notes still change.
  await assert.rejects(
    () => updateCashTransaction(adminA, instruction.id, {amount: 12000}),
    /POSTED_FINANCIAL_FIELDS_LOCKED/,
  );

  await correctCashTransaction(adminA, instruction.id, {correctedAmount: 12000, reason: 'short by 20 taka'});
  const adjustment = await row(
    'SELECT adjustment_minor::text, reason FROM cash_transaction_adjustments WHERE correction_of = $1',
    [instruction.id],
  );
  assert.equal(Number(adjustment.adjustment_minor), 2000);
  assert.equal(adjustment.reason, 'short by 20 taka');
  const unchanged = await row(
    'SELECT amount_minor::text, state FROM cash_instructions WHERE id = $1', [instruction.id],
  );
  assert.equal(Number(unchanged.amount_minor), 10000);
  assert.equal(unchanged.state, 'POSTED');
  assert.equal(await auditCount('CASH:CORRECTION', instruction.id), 1);

  const reversed = await reverseCashTransaction(adminA, instruction.id, {
    amount: 15000, method: 'bkash', notes: 'replacement', reason: 'wrong amount originally',
  });
  assert.equal(reversed.original?.state, 'REVERSED');
  assert.equal(reversed.replacement?.state, 'POSTED');
  assert.equal(reversed.replacement?.reversal_of, instruction.id);
  assert.equal(await auditCount('CASH:REVERSAL', instruction.id), 1);

  // A second reversal is refused, not silently duplicated.
  await assert.rejects(
    () => reverseCashTransaction(adminA, instruction.id, {amount: 15000, reason: 'second reversal attempt'}),
    /REVERSAL_REQUIRES_POSTED/,
  );
});

test('cash: reject and ledger forms write audit entries', async () => {
  const pending = await createInstruction(adminA, {
    employeeName: 'Reject Payee', method: 'cash', amountMinor: 5000, accountId: 'acc-cash',
  });
  await assert.rejects(() => rejectInstruction(adminA, pending.id, 'not allowed'), /REVIEWER_IS_SUBMITTER/);
  await rejectInstruction(adminB, pending.id, 'duplicate payment');
  const rejected = await row('SELECT state FROM cash_instructions WHERE id = $1', [pending.id]);
  assert.equal(rejected.state, 'REJECTED');
  assert.equal(await auditCount('INSTRUCTION_REJECTED', pending.id), 1);

  const ledger = await createLedgerEntry(adminA, {
    accountId: 'acc-cash', entryDate: '2026-11-09', direction: 'CREDIT', amountMinor: 7000,
    category: 'office', description: 'form audit ledger',
  });
  assert.ok(ledger?.id);
  const stored = await row('SELECT amount_minor::text FROM ledger_entries WHERE id = $1', [String(ledger.id)]);
  assert.equal(Number(stored.amount_minor), 7000);
  assert.equal(await auditCount('LEDGER_ENTRY_CREATED', String(ledger.id)), 1);
});

test('vessel: create, edit, assign, release and complete persist and audit', async () => {
  const created = await createProgram(adminA, {
    motherVessel: 'MV Audit', lighterVessel: 'Audit Lighter', startDate: '2026-12-10', startShift: 'D',
  }, {channel: 'WEB', sourceType: 'MANUAL'});
  assert.equal(created.program.state, 'DRAFT');
  assert.equal(created.program.source_type, 'MANUAL');
  assert.equal(await auditCount('PROGRAM_CREATED', created.program.id), 1);

  await updateProgram(adminA, created.program.id, {masterName: 'Audit Master', notes: 'edited'});
  const edited = await row(
    'SELECT master_name, notes FROM programs WHERE id = $1', [created.program.id],
  );
  assert.equal(edited.master_name, 'Audit Master');
  assert.equal(edited.notes, 'edited');
  assert.equal(await auditCount('PROGRAM_UPDATED', created.program.id), 1);

  await assignEscort(adminA, created.program.id, {employeeMobile: '01911111111', employeeName: 'Audit Escort'});
  const assigned = await row(
    'SELECT state, escort_mobile, escort_name FROM programs WHERE id = $1', [created.program.id],
  );
  assert.equal(assigned.state, 'ASSIGNED');
  assert.equal(assigned.escort_mobile, '+8801911111111');
  assert.equal(assigned.escort_name, 'Audit Escort');
  assert.equal(await auditCount('ESCORT_ASSIGNED', created.program.id), 1);

  await assert.rejects(
    () => releaseProgram(adminA, created.program.id, {endDate: '2026-12-01', endShift: 'D'}),
    /END_BEFORE_START/,
  );
  await releaseProgram(adminA, created.program.id, {endDate: '2026-12-15', endShift: 'D'});
  const released = await row(
    'SELECT state, end_date::text FROM programs WHERE id = $1', [created.program.id],
  );
  assert.equal(released.state, 'RELEASED');
  assert.equal(released.end_date, '2026-12-15');
  assert.equal(await auditCount('PROGRAM_RELEASED', created.program.id), 1);

  await completeProgram(adminA, created.program.id);
  const completed = await row('SELECT state FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(completed.state, 'COMPLETED');
  assert.equal(await auditCount('PROGRAM_COMPLETED', created.program.id), 1);
});

test('employees: add and edit persist, invalid mobile is rejected', async () => {
  const created = await createEmployee(adminA, {
    employeeMobile: '01755555555', preferredName: 'Audit Employee', dutyType: 'escort',
    designation: 'Escort', joinedOn: '2026-01-15',
  });
  assert.equal(created.created, true);
  assert.equal(await auditCount('EMPLOYEE_CREATED', created.employeeMobile), 1);

  await updateEmployee(adminA, created.employeeMobile, {
    preferredName: 'Audit Employee Updated', designation: 'Senior escort', state: 'ACTIVE', notes: 'patched',
  });
  const detail = await getEmployee(created.employeeMobile);
  assert.equal(detail.employee.preferred_name, 'Audit Employee Updated');
  assert.equal(detail.employee.designation, 'Senior escort');
  assert.equal(await auditCount('EMPLOYEE_UPDATED', created.employeeMobile), 1);

  await assert.rejects(
    () => createEmployee(adminA, {employeeMobile: '123', preferredName: 'Bad Mobile'}),
    /INVALID_EMPLOYEEMOBILE/,
  );
});

test('review: approve applies the program, reject is final, each decision is audited', async () => {
  const approved = await submitForReview(staff, {
    domain: 'PROGRAM', action: 'CREATE',
    payload: {motherVessel: 'MV Review', lighterVessel: 'Review Lighter', startDate: '2026-12-20', startShift: 'D'},
  });
  const approval = await decideReview(adminB, approved.id, 'APPROVED');
  assert.equal(approval.state, 'APPROVED');
  assert.ok(approval.applied);
  assert.equal(await auditCount('REVIEW_APPROVED', approved.id), 1);
  const appliedProgram = await row('SELECT state FROM programs WHERE id = $1', [approval.applied.program.id]);
  assert.equal(appliedProgram.state, 'DRAFT');

  const rejected = await submitForReview(staff, {
    domain: 'PROGRAM', action: 'CREATE',
    payload: {motherVessel: 'MV Reject', lighterVessel: 'Reject Lighter', startDate: '2026-12-21', startShift: 'D'},
  });
  await decideReview(adminB, rejected.id, 'REJECTED', 'duplicate order');
  assert.equal(await auditCount('REVIEW_REJECTED', rejected.id), 1);

  const selfSubmitted = await submitForReview(adminA, {
    domain: 'PROGRAM', action: 'CREATE',
    payload: {motherVessel: 'MV Self', lighterVessel: 'Self Lighter', startDate: '2026-12-22', startShift: 'D'},
  });
  await assert.rejects(
    () => decideReview(adminA, selfSubmitted.id, 'APPROVED'),
    /REVIEWER_IS_SUBMITTER/,
  );
});

test('every mutation above is present in audit_events', async () => {
  const actions = (await rows(
    `SELECT DISTINCT action FROM audit_events
      WHERE action IN ('INSTRUCTION_CREATED','CASH_TRANSACTION_UPDATED','INSTRUCTION_POSTED',
        'CASH:CORRECTION','CASH:REVERSAL','INSTRUCTION_REJECTED','LEDGER_ENTRY_CREATED',
        'PROGRAM_CREATED','PROGRAM_UPDATED','ESCORT_ASSIGNED','PROGRAM_RELEASED','PROGRAM_COMPLETED',
        'EMPLOYEE_CREATED','EMPLOYEE_UPDATED','REVIEW_APPROVED','REVIEW_REJECTED')
      ORDER BY action`,
  )).map((entry) => entry.action);
  for (const action of [
    'INSTRUCTION_CREATED', 'CASH_TRANSACTION_UPDATED', 'INSTRUCTION_POSTED', 'CASH:CORRECTION',
    'CASH:REVERSAL', 'INSTRUCTION_REJECTED', 'LEDGER_ENTRY_CREATED', 'PROGRAM_CREATED',
    'PROGRAM_UPDATED', 'ESCORT_ASSIGNED', 'PROGRAM_RELEASED', 'PROGRAM_COMPLETED',
    'EMPLOYEE_CREATED', 'EMPLOYEE_UPDATED', 'REVIEW_APPROVED', 'REVIEW_REJECTED',
  ]) {
    assert.ok(actions.includes(action), `${action} is audited`);
  }
});
