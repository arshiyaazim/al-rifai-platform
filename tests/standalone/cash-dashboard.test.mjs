// Cash reporting integration tests — disposable test database only.
//
// Verifies that summary cards, filtered totals and detail rows use one
// definition of a posted payment, exclude reversals, and respect Dhaka dates.
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {row} from '../../lib/standalone/db.ts';
import {
  cashDashboardSummary, cashPaymentTotals, dhakaToday, formatPayoutNumber,
  listCashPayments, shiftIsoDate,
} from '../../lib/standalone/cash-dashboard.ts';
import {createEmployee, searchEmployees} from '../../lib/standalone/employees.ts';
import {
  approveInstruction, cashTransactionView, countCashTransactions, createAccount, createInstruction,
  getCashEmployeeSummary, listAccounts, listCashTransactions, postInstruction, reversePosting, updateCashTransaction,
  correctCashTransaction, reverseCashTransaction,
} from '../../lib/standalone/finance.ts';
import {resetBusinessState} from './reset.mjs';

before(async () => { await resetBusinessState('alrifai-cash-dashboard-reset'); });

const adminA = {id: 'a'.repeat(64), role: 'ADMIN'};
const adminB = {id: 'b'.repeat(64), role: 'ADMIN'};

async function account() {
  const accounts = await listAccounts();
  if (accounts.length) return accounts[0];
  await createAccount(adminA, {code: 'CASH', name: 'Cash', type: 'CASH'});
  return (await listAccounts())[0];
}

async function insertPosted(accountId, {
  id, employeeMobile, employeeName, amountMinor, method = 'cash', source = 'WEB',
  postedAt = new Date(), state = 'POSTED', payoutMobile = null, sourceMessageId = null,
  sourceBlockKey = null,
}) {
  await row(
    `INSERT INTO cash_instructions
       (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, state,
        source_channel, source_message_id, source_block_key, account_id, posted_at, event_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,'test')`,
    [
      id, employeeMobile, employeeName, payoutMobile, method, amountMinor, state,
      source, sourceMessageId, sourceBlockKey, accountId, postedAt,
    ],
  );
  await row(
    `INSERT INTO cash_postings (id, instruction_id, account_id, amount_minor, method, posted_at, posted_by)
     VALUES ($1,$2,$3,$4,$5,$6,'test')`,
    [`post-${id}`, id, accountId, amountMinor, method, postedAt],
  );
}

function noonOn(date) {
  return new Date(`${date}T12:00:00+06:00`);
}

test('cash summary: posted totals exclude reversed rows and reconcile with details', async () => {
  const acc = await account();
  const asOf = dhakaToday();
  const yesterday = shiftIsoDate(asOf, -1);
  const mobile = '01755550001';

  await createEmployee(adminA, {
    employeeMobile: mobile,
    preferredName: 'Summary Target',
    designation: 'Crew',
    joinedOn: '2025-01-15',
  });

  await insertPosted(acc.id, {
    id: 'sum-wa', employeeMobile: `+88${mobile}`, employeeName: 'Summary Target',
    amountMinor: 1000, method: 'bkash', source: 'WHATSAPP', postedAt: noonOn(asOf),
    payoutMobile: `+88${mobile}`, sourceMessageId: 'sum-wa-message', sourceBlockKey: 'b1',
  });
  await insertPosted(acc.id, {
    id: 'sum-office', employeeMobile: `+88${mobile}`, employeeName: 'Summary Target',
    amountMinor: 2000, method: 'cash', source: 'WEB', postedAt: noonOn(yesterday),
  });
  await insertPosted(acc.id, {
    id: 'sum-void', employeeMobile: `+88${mobile}`, employeeName: 'Summary Target',
    amountMinor: 5000, method: 'nagad', source: 'WHATSAPP', postedAt: noonOn(asOf), state: 'VOID',
  });

  const summary = await cashDashboardSummary();
  assert.equal(summary.asOfDate, asOf);
  assert.equal(summary.totalPaidMinor, '3000');
  assert.equal(summary.todayPaidMinor, '1000');
  assert.equal(summary.yesterdayPaidMinor, '2000');
  assert.equal(summary.viaWhatsAppPaidMinor, '1000');
  assert.equal(summary.byOfficePaidMinor, '2000');
  assert.equal(
    Number(summary.viaWhatsAppPaidMinor) + Number(summary.byOfficePaidMinor),
    Number(summary.totalPaidMinor),
    'WhatsApp plus Office equals the total',
  );

  const total = await cashPaymentTotals({});
  assert.equal(total.totalMinor, summary.totalPaidMinor);
  assert.equal(total.count, 2, 'the VOID posting is excluded');

  const today = await cashPaymentTotals({date: asOf});
  assert.equal(today.totalMinor, summary.todayPaidMinor);
  assert.equal(today.count, 1);

  const yesterdayTotals = await cashPaymentTotals({date: yesterday});
  assert.equal(yesterdayTotals.totalMinor, summary.yesterdayPaidMinor);

  const wa = await cashPaymentTotals({source: 'WHATSAPP'});
  assert.equal(wa.totalMinor, summary.viaWhatsAppPaidMinor);
  const office = await cashPaymentTotals({source: 'OFFICE'});
  assert.equal(office.totalMinor, summary.byOfficePaidMinor);

  const details = await listCashPayments({date: asOf, employeeMobile: mobile});
  assert.equal(details.count, 1);
  assert.equal(details.totalMinor, summary.todayPaidMinor);
  assert.equal(details.rows.length, 1);
  const detail = details.rows[0];
  assert.equal(detail.preferred_name, 'Summary Target');
  assert.equal(detail.designation, 'Crew');
  assert.equal(detail.joined_on, '2025-01-15');
  assert.equal(detail.amount_minor, '1000');
  assert.equal(detail.employee_total_minor, '3000', 'employee total includes both posted payments');
  assert.equal(formatPayoutNumber(detail.payout_mobile, detail.method), `${`+88${mobile}`} (bKash)`);
  assert.equal(detail.source_message_id, 'sum-wa-message');
});

test('cash details: empty results and server-side pagination are honest', async () => {
  const acc = await account();
  const mobile = '01755550002';
  await createEmployee(adminA, {employeeMobile: mobile, preferredName: 'Pagination Target'});
  const asOf = dhakaToday();
  for (let index = 1; index <= 3; index += 1) {
    await insertPosted(acc.id, {
      id: `page-${index}`, employeeMobile: `+88${mobile}`, employeeName: 'Pagination Target',
      amountMinor: 1000 * index, method: 'cash', source: 'WEB', postedAt: noonOn(asOf),
    });
  }

  const all = await cashPaymentTotals({employeeMobile: mobile});
  assert.equal(all.count, 3);
  assert.equal(all.totalMinor, '6000');

  const firstPage = await listCashPayments({employeeMobile: mobile, limit: 2, offset: 0});
  assert.equal(firstPage.count, 3);
  assert.equal(firstPage.rows.length, 2);
  assert.equal(firstPage.totalMinor, '6000');

  const secondPage = await listCashPayments({employeeMobile: mobile, limit: 2, offset: 2});
  assert.equal(secondPage.count, 3);
  assert.equal(secondPage.rows.length, 1);

  const emptyEmployee = await cashPaymentTotals({employeeMobile: '01755559999'});
  assert.equal(emptyEmployee.count, 0);
  assert.equal(emptyEmployee.totalMinor, '0');
  const emptyRange = await cashPaymentTotals({from: '1900-01-01', to: '1900-01-02'});
  assert.equal(emptyRange.count, 0);

  const invalid = await listCashPayments({date: '2026-02-30'});
  assert.deepEqual(invalid.filters.errors, ['INVALID_DATE']);
  assert.equal(invalid.filters.from, null, 'an invalid date is never applied as a filter');
});

test('cash dedupe: a replayed source message posts once and a reversal clears the total', async () => {
  const acc = await account();
  const mobile = '01755550003';
  await createEmployee(adminA, {employeeMobile: mobile, preferredName: 'Duplicate Target'});
  const sourceMessageId = `cash-dedupe-${Date.now()}`;
  const input = {
    employeeName: 'Duplicate Target',
    employeeMobile: mobile,
    payoutMobile: mobile,
    method: 'bkash',
    amountMinor: 4500,
    accountId: acc.id,
    sourceChannel: 'WHATSAPP',
    sourceMessageId,
    sourceBlockKey: 'block-1',
  };

  const created = await createInstruction(adminA, input);
  assert.ok(created?.id);
  const replay = await createInstruction(adminA, input);
  assert.equal(replay, null, 'a replay loses the source-identity insert race');

  await approveInstruction(adminB, created.id);
  await postInstruction(adminA, created.id);

  const posted = await cashPaymentTotals({q: 'Duplicate Target'});
  assert.equal(posted.count, 1, 'one instruction and one posting, never two');
  assert.equal(posted.totalMinor, '4500');

  await reversePosting(adminB, created.id, 'reporting test reversal');
  const reversed = await cashPaymentTotals({q: 'Duplicate Target'});
  assert.equal(reversed.count, 0, 'a VOID instruction is excluded from paid totals');
  const detail = await listCashPayments({q: 'Duplicate Target'});
  assert.equal(detail.rows.length, 0);
});

test('employee lookup: name, alias and mobile search are capped at ten', async () => {
  await createEmployee(adminA, {
    employeeMobile: '01766660001',
    preferredName: 'Lookup Alias Primary',
    designation: 'Escort',
  });
  await createEmployee(adminA, {
    employeeMobile: '01766660001',
    preferredName: 'Lookup Alias Secondary',
  });

  const byName = await searchEmployees('Lookup Alias Primary');
  assert.equal(byName.length, 1);
  assert.equal(byName[0].employee_mobile, '+8801766660001');
  assert.equal(byName[0].designation, 'Escort');

  const byAlias = await searchEmployees('Alias Secondary');
  assert.equal(byAlias.length, 1);
  assert.equal(byAlias[0].employee_mobile, '+8801766660001');

  const byMobile = await searchEmployees('01766660001');
  assert.equal(byMobile[0].employee_mobile, '+8801766660001');

  for (let index = 0; index < 12; index += 1) {
    await createEmployee(adminA, {
      employeeMobile: `0171111${String(index).padStart(4, '0')}`,
      preferredName: `Lookup Limit ${index}`,
    });
  }
  const capped = await searchEmployees('Lookup Limit', 50);
  assert.equal(capped.length, 10, 'the server never returns more than ten suggestions');
  assert.equal((await searchEmployees('   ')).length, 0);
});

test('cash transactions: 8-column read model, cumulative total, search and pagination', async () => {
  const mobile = '01755550999';
  await createEmployee(adminA, {
    employeeMobile: mobile,
    preferredName: 'Tx Target',
    designation: 'Loader',
    joinedOn: '2024-02-03',
  });
  const insert = (id, amountMinor, state, createdAt) => row(
    `INSERT INTO cash_instructions
       (id, employee_mobile, employee_name, method, amount_minor, state,
        source_channel, source_message_id, source_block_key, created_by, created_at, event_at)
     VALUES ($1,$2,'Tx Target','bkash',$3,$4,'WHATSAPP',$1,'b-'||$1,'test',$5,$5)`,
    [id, `+88${mobile}`, amountMinor, state, createdAt],
  );
  await insert('tx-a', 1000, 'REVIEW', '2026-10-01T10:00:00+06:00');
  await insert('tx-b', 2000, 'APPROVED', '2026-10-02T10:00:00+06:00');
  await insert('tx-c', 5000, 'VOID', '2026-10-03T10:00:00+06:00');

  const all = await listCashTransactions({q: 'Tx Target'});
  assert.equal(all.length, 2, 'VOID rows are excluded');
  assert.equal(all[0].id, 'tx-b');
  assert.equal(all[0].payout_number, '2');
  assert.equal(all[0].total_paid_minor, '3000');
  assert.equal(all[0].name_of_employee, 'Tx Target');
  assert.equal(all[0].designation, 'Loader');
  assert.equal(all[0].date_of_join, '2024-02-03');
  assert.equal(all[1].payout_number, '1');
  assert.equal(all[1].total_paid_minor, '1000');

  assert.equal(await countCashTransactions({q: 'Tx Target'}), 2);
  assert.equal((await listCashTransactions({q: mobile})).length, 2, 'search by employee mobile digits');

  const page = await listCashTransactions({q: 'Tx Target', limit: 1, offset: 1});
  assert.equal(page.length, 1);
  assert.equal(page[0].id, 'tx-a');

  const view = cashTransactionView(all[0]);
  assert.equal(view.employeeId, `+88${mobile}`);
  assert.equal(view.nameOfEmployee, 'Tx Target');
  assert.equal(view.payoutNumber, 2);
  assert.equal(view.amountMinor, '2000');
  assert.equal(view.totalPaidMinor, '3000');
});

test('cash transaction edit and employee history summary are audited', async () => {
  const mobile = '01755550999';
  const updated = await updateCashTransaction(adminA, 'tx-b', {
    designation: 'Senior Loader',
    amount: 2500,
    notes: 'corrected by admin',
  });
  assert.equal(updated?.designation, 'Senior Loader');
  assert.equal(updated?.amount_minor, '2500');
  assert.equal(updated?.notes, 'corrected by admin');

  const summary = await getCashEmployeeSummary(mobile);
  assert.equal(summary?.total_payouts, 2);
  assert.equal(summary?.total_paid_minor, '3500');
  assert.equal(summary?.name_of_employee, 'Tx Target');

  const audit = await row(
    "SELECT action FROM audit_events WHERE entity='cash_instruction' AND entity_id='tx-b' AND action='CASH_TRANSACTION_UPDATED'",
  );
  assert.ok(audit, 'the edit is recorded in audit_events');
});

test('cash correction keeps the posted original untouched and records an effective amount', async () => {
  const acc = await account();
  await insertPosted(acc.id, {
    id: 'corr-1', employeeMobile: '+8801755551111', employeeName: 'Correction Target',
    amountMinor: 5000, method: 'bkash', source: 'WHATSAPP', postedAt: new Date(),
  });
  const corrected = await correctCashTransaction(adminA, 'corr-1', {
    correctedAmount: 4500,
    reason: 'Amount corrected to match the receipt',
  });
  assert.equal(corrected?.original_amount_minor, '5000');
  assert.equal(corrected?.amount_minor, '4500');
  assert.equal(corrected?.adjustment_minor, '-500');
  assert.equal(corrected?.correction_count, 1);
  const original = await row("SELECT state, amount_minor FROM cash_instructions WHERE id='corr-1'");
  assert.equal(original.state, 'POSTED');
  assert.equal(original.amount_minor, '5000');
  const adjustment = await row("SELECT * FROM cash_transaction_adjustments WHERE correction_of='corr-1'");
  assert.equal(adjustment.amount_minor, '4500');
  assert.equal(adjustment.adjustment_minor, '-500');
  const audit = await row("SELECT action FROM audit_events WHERE entity_id='corr-1' AND action='CASH:CORRECTION'");
  assert.ok(audit);
});

test('cash reversal marks the original REVERSED and creates a new POSTED replacement', async () => {
  const acc = await account();
  await insertPosted(acc.id, {
    id: 'rev-1', employeeMobile: '+8801755552222', employeeName: 'Reversal Target',
    amountMinor: 7000, method: 'bkash', source: 'WHATSAPP', postedAt: new Date(),
  });
  const result = await reverseCashTransaction(adminA, 'rev-1', {
    amount: 6500,
    method: 'nagad',
    notes: 'Re-posted after method correction',
    reason: 'Wrong payment method on the original posting',
  });
  assert.equal(result.original?.state, 'REVERSED');
  assert.equal(result.original?.original_amount_minor, '7000');
  assert.equal(result.replacement?.state, 'POSTED');
  assert.equal(result.replacement?.amount_minor, '6500');
  assert.equal(result.replacement?.reversal_of, 'rev-1');
  const original = await row("SELECT state, amount_minor FROM cash_instructions WHERE id='rev-1'");
  assert.equal(original.state, 'REVERSED');
  assert.equal(original.amount_minor, '7000');
  const postings = await row("SELECT count(*)::int AS n FROM cash_postings WHERE instruction_id IN ('rev-1',$1)", [result.replacement?.id]);
  assert.equal(postings.n, 2);
  const audit = await row("SELECT action FROM audit_events WHERE entity_id='rev-1' AND action='CASH:REVERSAL'");
  assert.ok(audit);
});
