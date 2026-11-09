// Business Paid list/detail service tests — isolated disposable database only.
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {row} from '../../lib/standalone/db.ts';
import {
  approveInstruction, correctBusinessPaidEvent, createAccount, createInstruction,
  getBusinessPaidEventDetail, listAccounts, postInstruction, reverseBusinessPaidEvent,
} from '../../lib/standalone/finance.ts';
import {
  businessPaidSummary, listBusinessPaidEvents, normalizeCashPaymentFilters,
} from '../../lib/standalone/cash-dashboard.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {createEmployee} from '../../lib/standalone/employees.ts';
import {resetBusinessState} from './reset.mjs';

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
  await createAccount(adminA, {code: 'PAIDAPI', name: 'Paid API cash', type: 'CASH'});
  return (await listAccounts())[0];
}

async function makeEvent(acc, suffix, overrides = {}) {
  const instruction = await createInstruction(adminA, {
    employeeName: `Paid API ${suffix}`,
    employeeMobile: overrides.employeeMobile ?? '01712345678',
    payoutMobile: overrides.payoutMobile ?? overrides.employeeMobile ?? '01712345678',
    method: overrides.method ?? 'bkash',
    amountMinor: overrides.amountMinor ?? 50000,
    accountId: acc.id,
    sourceChannel: 'WHATSAPP',
    sourceMessageId: `paid-api-${suffix}`,
    sourceBlockKey: 'payment-block-0',
  }, {whatsAppVerified: true, paidAt: '2026-11-07T06:05:30Z'});
  const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
  return {instruction, event};
}

beforeEach(async () => {
  delete process.env.PHASE3_PAID_EVENTS_ENABLED;
  await resetBusinessState('alrifai-paid-api-reset');
  await ensureUser(adminA.id, 'paid-api-admin-a', 'ADMIN');
  await ensureUser(adminB.id, 'paid-api-admin-b', 'ADMIN');
  await ensureUser(staff.id, 'paid-api-staff', 'USER');
  process.env.PHASE3_PAID_EVENTS_ENABLED = '1';
});

test('list returns event_id, filters, totals and pagination', async () => {
  const acc = await account();
  await makeEvent(acc, 'one', {employeeMobile: '01711112222', amountMinor: 10000});
  await makeEvent(acc, 'two', {employeeMobile: '01733334444', amountMinor: 25000, method: 'nagad'});

  const all = await listBusinessPaidEvents({limit: 10});
  assert.equal(all.count, 2);
  assert.equal(all.totalMinor, '35000');
  assert.ok(all.rows.every((entry) => entry.event_id), 'event_id must be populated for detail links');
  assert.ok(all.rows.every((entry) => entry.financial_status === 'NOT_POSTED'));

  const filtered = await listBusinessPaidEvents({employeeMobile: '01711112222'});
  assert.equal(filtered.count, 1);
  assert.equal(filtered.totalMinor, '10000');

  const source = await listBusinessPaidEvents({source: 'WHATSAPP'});
  assert.equal(source.count, 2);

  const page = await listBusinessPaidEvents({limit: 1, offset: 1});
  assert.equal(page.count, 2);
  assert.equal(page.rows.length, 1);
});

test('list reconciles with businessPaidSummary for the same basis', async () => {
  const acc = await account();
  await makeEvent(acc, 'reconcile', {amountMinor: 12345});
  const list = await listBusinessPaidEvents({limit: 10});
  const summary = await businessPaidSummary();
  assert.equal(list.totalMinor, summary.totalPaidMinor);
});

test('detail returns base event, employee, instruction, corrections, reversal, posting link and audit', async () => {
  const acc = await account();
  await createEmployee(adminA, {employeeMobile: '01712345678', preferredName: 'Registered Detail Employee'});
  const {instruction, event} = await makeEvent(acc, 'detail', {amountMinor: 70000});
  const correction = await correctBusinessPaidEvent(adminB, event.id, {
    amountMinor: 75000, reason: 'Bank slip correction',
  });
  const reversal = await reverseBusinessPaidEvent(adminB, event.id, 'Owner cancelled');

  const detail = await getBusinessPaidEventDetail(event.id);
  assert.equal(detail.event.id, event.id);
  assert.equal(detail.event.event_type, 'PAYMENT');
  assert.equal(detail.employee.employee_mobile, '+8801712345678');
  assert.equal(detail.instruction.id, instruction.id);
  assert.equal(detail.corrections.length, 1);
  assert.equal(detail.corrections[0].id, correction.id);
  assert.equal(detail.reversal.id, reversal.id);
  assert.ok(detail.audit.some((entry) => entry.action === 'CASH_PAYMENT_EVENT_CORRECTED'));
  assert.ok(detail.audit.some((entry) => entry.action === 'CASH_PAYMENT_EVENT_REVERSED'));

  // A correction/reversal id resolves to the root PAYMENT chain.
  const viaCorrection = await getBusinessPaidEventDetail(correction.id);
  assert.equal(viaCorrection.rootEventId, event.id);
  const viaReversal = await getBusinessPaidEventDetail(reversal.id);
  assert.equal(viaReversal.rootEventId, event.id);
});

test('detail exposes the financial posting link only when genuinely posted', async () => {
  const acc = await account();
  const {instruction, event} = await makeEvent(acc, 'posted');
  let detail = await getBusinessPaidEventDetail(event.id);
  assert.equal(detail.postingLink, null);

  await approveInstruction(adminB, instruction.id);
  await postInstruction(adminB, instruction.id);
  detail = await getBusinessPaidEventDetail(event.id);
  assert.ok(detail.postingLink);
  assert.ok(detail.postingLink.posting_id);
  assert.ok(detail.postingLink.financial_posted_at);
});

test('correction/reversal preserve ADMIN + cash.review authorization and flag gate', async () => {
  const acc = await account();
  const {event} = await makeEvent(acc, 'auth');
  await assert.rejects(
    () => correctBusinessPaidEvent(staff, event.id, {amountMinor: 60000, reason: 'nope'}),
    /CAPABILITY_REQUIRED/,
  );
  await assert.rejects(
    () => reverseBusinessPaidEvent(staff, event.id, 'nope'),
    /CAPABILITY_REQUIRED/,
  );
  delete process.env.PHASE3_PAID_EVENTS_ENABLED;
  await assert.rejects(
    () => correctBusinessPaidEvent(adminB, event.id, {amountMinor: 60000, reason: 'flag off'}),
    /PAID_EVENTS_DISABLED/,
  );
  await assert.rejects(
    () => reverseBusinessPaidEvent(adminB, event.id, 'flag off'),
    /PAID_EVENTS_DISABLED/,
  );
});

test('filters reject invalid date/source without applying them', () => {
  const invalid = normalizeCashPaymentFilters({date: '2026-02-30', source: 'NOPE'});
  assert.deepEqual(invalid.errors, ['INVALID_DATE', 'INVALID_SOURCE']);
  assert.equal(invalid.from, null);
  assert.equal(invalid.source, null);
  const valid = normalizeCashPaymentFilters({from: '2026-11-01', to: '2026-11-07', source: 'OFFICE'});
  assert.deepEqual(valid.errors, []);
  assert.equal(valid.source, 'OFFICE');
});