// Cash lifecycle integration tests — isolated test database only.
//
// Covers the complete role-authorized workflow required by the standalone
// platform: instruction → review → approval → posting → reversal →
// reconciliation → audit history. It never touches production.
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {row, rows} from '../../lib/standalone/db.ts';
import {
  approveInstruction,
  closeReconciliation,
  createAccount,
  createInstruction,
  createLedgerEntry,
  createReconciliation,
  decideCashSubmission,
  getInstructionDetail,
  listAccounts,
  postInstruction,
  reversePosting,
  submitCash,
} from '../../lib/standalone/finance.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {resetBusinessState} from './reset.mjs';

before(async () => { await resetBusinessState('alrifai-cash-test-reset'); });

const adminA = {id: '1'.repeat(64), role: 'ADMIN'};
const adminB = {id: '2'.repeat(64), role: 'ADMIN'};
const staff = {id: '3'.repeat(64), role: 'USER'};

async function ensureUser(id, username, role) {
  const hash = await hashBootstrapPassword('TestPass123');
  await row(
    `INSERT INTO cash_portal_users (id, username, password_hash, role, display_name, must_change_password, active)
     VALUES ($1,$2,$3,$4,$4,false,true)
     ON CONFLICT (id) DO NOTHING`,
    [id, username, hash, role],
  );
}

async function account() {
  const accounts = await listAccounts();
  if (accounts.length) return accounts[0];
  await createAccount(adminA, {code: 'TESTS', name: 'Test cash', type: 'CASH'});
  return (await listAccounts())[0];
}

test('cash: complete instruction lifecycle with reversible immutable posting', async () => {
  await ensureUser(adminA.id, 'cash-admin-a', 'ADMIN');
  await ensureUser(adminB.id, 'cash-admin-b', 'ADMIN');
  await ensureUser(staff.id, 'cash-staff', 'USER');
  const acc = await account();
  const before = Number(acc.balance_minor);

  const instruction = await createInstruction(adminA, {
    employeeName: 'Lifecycle Escort',
    employeeMobile: '01712345678',
    method: 'bkash',
    amountMinor: 32100,
    accountId: acc.id,
    purpose: 'Lifecycle test',
  });
  assert.equal(instruction.state, 'REVIEW');

  await assert.rejects(() => postInstruction(adminA, instruction.id), /INSTRUCTION_NOT_APPROVED/);
  await assert.rejects(() => approveInstruction(adminA, instruction.id), /REVIEWER_IS_SUBMITTER/);
  const approved = await approveInstruction(adminB, instruction.id);
  assert.equal(approved.state, 'APPROVED');

  const posted = await postInstruction(adminB, instruction.id);
  assert.equal(posted.state, 'POSTED');
  const afterPost = Number((await listAccounts()).find((entry) => entry.id === acc.id).balance_minor);
  assert.equal(afterPost, before - 32100);

  const reversal = await reversePosting(adminA, instruction.id, 'Duplicate payment corrected');
  assert.equal(reversal.state, 'VOID');
  const afterReversal = Number((await listAccounts()).find((entry) => entry.id === acc.id).balance_minor);
  assert.equal(afterReversal, before, 'reversal restores the account balance');

  const reversalRow = await row('SELECT * FROM cash_reversals WHERE instruction_id = $1', [instruction.id]);
  assert.ok(reversalRow, 'immutable reversal row exists');
  assert.equal(Number(reversalRow.amount_minor), 32100);
  const posting = await row('SELECT * FROM cash_postings WHERE instruction_id = $1', [instruction.id]);
  assert.ok(posting, 'original posting is preserved');
  const ledger = await rows('SELECT direction, source, amount_minor FROM ledger_entries WHERE instruction_id = $1 ORDER BY id', [instruction.id]);
  assert.deepEqual(ledger.map((entry) => `${entry.direction}:${entry.source}`), ['DEBIT:INSTRUCTION', 'CREDIT:REVERSAL']);
  await assert.rejects(() => reversePosting(adminA, instruction.id, 'again'), /INSTRUCTION_NOT_POSTED/);

  const detail = await getInstructionDetail(instruction.id);
  assert.equal(detail.instruction.state, 'VOID');
  assert.ok(detail.reversal);
  assert.equal(detail.ledger.length, 2);
  assert.ok(detail.audit.some((entry) => entry.action === 'INSTRUCTION_POSTED'));
  assert.ok(detail.audit.some((entry) => entry.action === 'INSTRUCTION_REVERSED'));
});

test('cash: approved review candidate creates a linked REVIEW instruction', async () => {
  await ensureUser(adminA.id, 'cash-admin-a', 'ADMIN');
  await ensureUser(adminB.id, 'cash-admin-b', 'ADMIN');
  const acc = await account();
  const before = Number((await listAccounts()).find((entry) => entry.id === acc.id).balance_minor);

  const suffix = Date.now().toString(36);
  const submission = await submitCash(adminA, {
    employeeName: `Candidate Escort ${suffix}`,
    employeeMobile: '01812345678',
    method: 'nagad',
    amountMinor: 45000,
    purpose: 'Candidate review',
    accountId: acc.id,
    sourceMessageId: `cash-candidate-${suffix}`,
    sourceChatJid: '8801844836824@s.whatsapp.net',
    sourceAccountId: 'wa-01',
    category: 'INCOMPLETE_CASH_INSTRUCTION',
  });
  assert.equal(submission.state, 'PENDING_REVIEW');

  const decided = await decideCashSubmission(adminB, submission.id, 'APPROVED');
  assert.equal(decided.state, 'APPROVED');
  assert.ok(decided.instructionId);
  assert.equal(decided.instructionState, 'REVIEW');

  const linked = await row('SELECT * FROM cash_submissions WHERE id = $1', [submission.id]);
  assert.equal(linked.instruction_id, decided.instructionId);
  const instruction = await row('SELECT * FROM cash_instructions WHERE id = $1', [decided.instructionId]);
  assert.equal(instruction.state, 'REVIEW');
  assert.equal(Number(instruction.amount_minor), 45000);
  assert.equal(instruction.source_channel, 'WHATSAPP');

  // The candidate reviewer cannot also approve their own generated instruction.
  await assert.rejects(() => approveInstruction(adminB, decided.instructionId), /REVIEWER_IS_SUBMITTER/);
  await approveInstruction(adminA, decided.instructionId);
  await postInstruction(adminB, decided.instructionId);
  const after = Number((await listAccounts()).find((entry) => entry.id === acc.id).balance_minor);
  assert.equal(after, before - 45000);

  // A second decision is refused; the candidate is not duplicated.
  await assert.rejects(
    () => decideCashSubmission(adminB, submission.id, 'APPROVED'),
    /SUBMISSION_NOT_PENDING/,
  );
});

test('cash: reconciliation records expected, counted and variance without auto-adjusting', async () => {
  const acc = await account();
  const balance = Number((await listAccounts()).find((entry) => entry.id === acc.id).balance_minor);

  const exact = await createReconciliation(adminA, {
    accountId: acc.id,
    periodStart: '2000-01-01',
    periodEnd: '2099-12-31',
    countedBalanceMinor: balance,
    note: 'Physical count matches ledger',
  });
  assert.equal(exact.variance, 0);
  assert.equal(exact.state, 'OPEN');
  const closed = await closeReconciliation(adminA, exact.id);
  assert.equal(closed.state, 'CLOSED');

  const variance = await createReconciliation(adminB, {
    accountId: acc.id,
    periodStart: '2000-01-01',
    periodEnd: '2099-12-31',
    countedBalanceMinor: balance + 125,
  });
  assert.equal(variance.variance, 125);
  await assert.rejects(() => closeReconciliation(adminB, variance.id), /RECONCILIATION_NOTE_REQUIRED/);
  const explained = await closeReconciliation(adminB, variance.id, 'Teller shortfall investigated; no adjustment posted');
  assert.equal(explained.state, 'CLOSED');

  const ledgerCount = await row('SELECT count(*)::int AS n FROM ledger_entries WHERE category = $1', ['RECONCILIATION']);
  assert.equal(ledgerCount.n, 0, 'closing a reconciliation never posts automatically');
});

test('cash: USER cannot post, reverse, write the ledger or create accounts', async () => {
  const acc = await account();
  await assert.rejects(
    () => createLedgerEntry(staff, {
      accountId: acc.id, entryDate: '2026-11-06', direction: 'DEBIT', amountMinor: 100, category: 'test',
    }),
    /CAPABILITY_REQUIRED/,
  );
  await assert.rejects(
    () => createAccount(staff, {code: 'NOPE', name: 'No', type: 'CASH'}),
    /CAPABILITY_REQUIRED/,
  );

  const instruction = await createInstruction(staff, {
    employeeName: 'Staff Submitted',
    method: 'cash',
    amountMinor: 1000,
    accountId: acc.id,
  });
  assert.equal(instruction.state, 'REVIEW');
  await assert.rejects(() => approveInstruction(staff, instruction.id), /CAPABILITY_REQUIRED/);
  await assert.rejects(() => postInstruction(staff, instruction.id), /CAPABILITY_REQUIRED/);
});

test('cash: audit trail is atomic and append-only for the lifecycle', async () => {
  const events = await rows(
    `SELECT action FROM audit_events WHERE entity = 'instruction' AND action LIKE 'INSTRUCTION_%' ORDER BY id DESC LIMIT 20`,
  );
  const actions = events.map((event) => event.action);
  assert.ok(actions.includes('INSTRUCTION_CREATED'));
  assert.ok(actions.includes('INSTRUCTION_APPROVED'));
  assert.ok(actions.includes('INSTRUCTION_POSTED'));
  assert.ok(actions.includes('INSTRUCTION_REVERSED'));
  // The runtime role has no UPDATE grant; the trigger is the second defence for
  // an owner connection. Either rejection is a valid immutability proof.
  await assert.rejects(
    () => row("UPDATE audit_events SET action = 'TAMPERED' WHERE entity = 'instruction'"),
    /IMMUTABLE_audit_events|permission denied/,
  );
});
