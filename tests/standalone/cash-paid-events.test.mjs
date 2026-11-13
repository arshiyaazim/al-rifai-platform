// Business Paid Event integration tests — isolated disposable database only.
//
// Verifies the Owner rules:
//   * single mobile = employee identity = payout destination
//   * WhatsApp automatic Paid does not require Office approval
//   * Business Paid is not Financial POSTED
//   * flag default OFF; corrections/reversals are append-only
//   * reporting preserves legacy POSTED without double counting
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {row} from '../../lib/standalone/db.ts';
import {
  approveInstruction,
  correctBusinessPaidEvent,
  createAccount,
  createInstruction,
  decideCashSubmission,
  listAccounts,
  postInstruction,
  reverseBusinessPaidEvent,
  submitCash,
} from '../../lib/standalone/finance.ts';
import {
  businessPaidSummary,
  cashDashboardSummary,
  listBusinessPaidEvents,
} from '../../lib/standalone/cash-dashboard.ts';
import {createEmployee} from '../../lib/standalone/employees.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {resetBusinessState} from './reset.mjs';

const adminA = {id: '1'.repeat(64), role: 'ADMIN'};
const adminB = {id: '2'.repeat(64), role: 'ADMIN'};

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
  await createAccount(adminA, {code: 'PAIDTEST', name: 'Paid test cash', type: 'CASH'});
  return (await listAccounts())[0];
}

async function withFlag(value, fn) {
  const previous = process.env.PHASE3_PAID_EVENTS_ENABLED;
  if (value === undefined) delete process.env.PHASE3_PAID_EVENTS_ENABLED;
  else process.env.PHASE3_PAID_EVENTS_ENABLED = value;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.PHASE3_PAID_EVENTS_ENABLED;
    else process.env.PHASE3_PAID_EVENTS_ENABLED = previous;
  }
}

async function eventCount(instructionId = null) {
  const result = instructionId
    ? await row('SELECT count(*)::int AS n FROM cash_payment_events WHERE instruction_id = $1', [instructionId])
    : await row('SELECT count(*)::int AS n FROM cash_payment_events');
  return result.n;
}

beforeEach(async () => {
  delete process.env.PHASE3_PAID_EVENTS_ENABLED;
  await resetBusinessState('alrifai-paid-events-reset');
  await ensureUser(adminA.id, 'paid-admin-a', 'ADMIN');
  await ensureUser(adminB.id, 'paid-admin-b', 'ADMIN');
});

test('flag OFF (default) creates no Business Paid Event', async () => {
  const acc = await account();
  const instruction = await createInstruction(adminA, {
    employeeName: 'Flag Off Employee',
    employeeMobile: '01712345678',
    payoutMobile: '01712345678',
    method: 'bkash',
    amountMinor: 50000,
    accountId: acc.id,
    sourceChannel: 'WHATSAPP',
    sourceMessageId: 'flag-off-1',
    sourceBlockKey: 'payment-block-0',
  }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
  assert.ok(instruction);
  assert.equal(await eventCount(), 0);
  const summary = await cashDashboardSummary();
  assert.equal(summary.totalPaidMinor, '0', 'POSTED-based reporting is unchanged when disabled');
});

test('verified WhatsApp payment creates one Business Paid Event and no financial posting', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    const instruction = await createInstruction(adminA, {
      employeeName: 'Single Mobile Employee',
      employeeMobile: '01712345678',
      // Parser-level single-number rule: payout == employee.
      payoutMobile: '01712345678',
      method: 'nagad',
      amountMinor: 125050,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-auto-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:05:30Z'});

    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
    assert.ok(event, 'Business Paid Event exists');
    assert.equal(event.event_type, 'PAYMENT');
    assert.equal(event.status, 'PAID');
    assert.equal(event.source_category, 'WHATSAPP');
    assert.equal(event.source_message_id, 'wa-auto-1');
    assert.equal(event.source_block_key, 'payment-block-0');
    assert.equal(event.employee_mobile, '+8801712345678');
    assert.equal(event.payout_mobile, '+8801712345678');
    assert.equal(event.amount_minor, '125050');
    assert.equal(event.method, 'nagad');
    // Phase 4 auto-creates the employee from cash, so the link is REGISTERED.
    assert.equal(event.employee_link_status, 'REGISTERED');

    // Business Paid is not Financial POSTED.
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_postings')).n, 0);
    assert.equal((await row('SELECT count(*)::int AS n FROM ledger_entries')).n, 0);
  });
});

test('an unregistered mobile is never linked to an unrelated employee', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    await createEmployee(adminA, {employeeMobile: '01799990000', preferredName: 'Someone Else'});
    const before = (await row('SELECT count(*)::int AS n FROM employees')).n;
    const instruction = await createInstruction(adminA, {
      employeeName: 'New Person',
      employeeMobile: '01811112222',
      payoutMobile: '01811112222',
      method: 'cash',
      amountMinor: 20000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-unregistered-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
    // Phase 4 auto-creates the employee from cash, so the link is REGISTERED.
    assert.equal(event.employee_link_status, 'REGISTERED');
    // Phase 4 auto-creates exactly one employee identity for the paying mobile.
    assert.equal((await row('SELECT count(*)::int AS n FROM employees')).n, before + 1,
      'one employee identity is auto-created, never reassigned');
    const linked = await row('SELECT * FROM employees WHERE employee_mobile = $1', ['+8801811112222']);
    // Phase 4 creates the paying mobile's own identity, never the unrelated employee.
    assert.equal(linked?.preferred_name, 'New Person');
  });
});

test('a registered mobile is linked by the canonical employee_mobile key', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    await createEmployee(adminA, {employeeMobile: '01733334444', preferredName: 'Registered Employee'});
    const instruction = await createInstruction(adminA, {
      employeeName: 'Registered Employee',
      employeeMobile: '01733334444',
      payoutMobile: '01733334444',
      method: 'bkash',
      amountMinor: 30000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-registered-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
    assert.equal(event.employee_link_status, 'REGISTERED');
  });
});

test('replay and concurrent insertion produce one instruction and one event', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    const input = {
      employeeName: 'Concurrent Employee',
      employeeMobile: '01755556666',
      payoutMobile: '01755556666',
      method: 'bkash',
      amountMinor: 20000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-concurrent-paid-1',
      sourceBlockKey: 'payment-block-0',
    };
    const options = {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'};
    const results = await Promise.all([
      createInstruction(adminA, input, options),
      createInstruction(adminA, input, options),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal((await row(`SELECT count(*)::int AS n FROM cash_instructions WHERE source_message_id='wa-concurrent-paid-1'`)).n, 1);
    assert.equal((await row(`SELECT count(*)::int AS n FROM cash_payment_events WHERE source_message_id='wa-concurrent-paid-1'`)).n, 1);
  });
});

test('Office approval creates exactly one OFFICE event; rejection creates none', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    const approvedSubmission = await submitCash(adminA, {
      employeeName: 'Office Approved Employee',
      employeeMobile: '01777778888',
      payoutMobile: '01777778888',
      method: 'bank',
      amountMinor: 45000,
      accountId: acc.id,
      category: 'INCOMPLETE_CASH_INSTRUCTION',
    });
    const decided = await decideCashSubmission(adminB, approvedSubmission.id, 'APPROVED');
    assert.ok(decided.instructionId);
    assert.ok(decided.paidEventId);
    const event = await row('SELECT * FROM cash_payment_events WHERE id = $1', [decided.paidEventId]);
    assert.equal(event.event_type, 'PAYMENT');
    assert.equal(event.source_category, 'OFFICE');
    assert.equal(event.source_submission_id, approvedSubmission.id);
    assert.equal(event.instruction_id, decided.instructionId);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_postings')).n, 0,
      'Office approval is not a financial posting');

    const rejectedSubmission = await submitCash(adminA, {
      employeeName: 'Office Rejected Employee',
      employeeMobile: '01777779999',
      payoutMobile: '01777779999',
      method: 'cash',
      amountMinor: 10000,
    });
    const rejected = await decideCashSubmission(adminB, rejectedSubmission.id, 'REJECTED', 'not a payment');
    assert.equal(rejected.state, 'REJECTED');
    const rejectedEvent = await row(
      'SELECT count(*)::int AS n FROM cash_payment_events WHERE source_submission_id = $1', [rejectedSubmission.id],
    );
    assert.equal(rejectedEvent.n, 0);
  });
});

test('Office approval requires a method and never fabricates cash', async () => {
  await withFlag('1', async () => {
    const submission = await submitCash(adminA, {
      employeeName: 'No Method Employee',
      employeeMobile: '01766667777',
      method: 'cash',
      amountMinor: 1000,
    });
    // Simulate a corrected candidate that still has no method.
    await row(`UPDATE cash_submissions SET payload = jsonb_set(payload, '{method}', 'null'::jsonb) WHERE id=$1`, [submission.id]);
    await assert.rejects(
      () => decideCashSubmission(adminB, submission.id, 'APPROVED'),
      /PAYMENT_METHOD_UNRESOLVED/,
    );
    assert.equal(await eventCount(), 0);
  });
});

test('explicit financial posting links the event but never creates one', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    // Flag OFF creation leaves no event.
    delete process.env.PHASE3_PAID_EVENTS_ENABLED;
    const noEvent = await createInstruction(adminA, {
      employeeName: 'Posting Only Employee',
      employeeMobile: '01744445555',
      payoutMobile: '01744445555',
      method: 'cash',
      amountMinor: 7000,
      accountId: acc.id,
      sourceChannel: 'WEB',
      sourceMessageId: 'posting-only-1',
      sourceBlockKey: 'payment-block-0',
    });
    process.env.PHASE3_PAID_EVENTS_ENABLED = '1';
    await approveInstruction(adminB, noEvent.id);
    await postInstruction(adminB, noEvent.id);
    assert.equal(await eventCount(noEvent.id), 0, 'posting does not create a Business Paid Event');
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_payment_event_postings')).n, 0);

    // Event created by WhatsApp automatic Paid; posting then links it.
    const withEvent = await createInstruction(adminA, {
      employeeName: 'Posting Link Employee',
      employeeMobile: '01744446666',
      payoutMobile: '01744446666',
      method: 'cash',
      amountMinor: 8000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'posting-link-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    await approveInstruction(adminB, withEvent.id);
    await postInstruction(adminB, withEvent.id);
    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [withEvent.id]);
    const link = await row('SELECT * FROM cash_payment_event_postings WHERE payment_event_id = $1', [event.id]);
    assert.ok(link, 'posting link exists');
    assert.ok(link.posted_at);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_payment_events')).n, 1,
      'posting did not create a second event');
  });
});

test('correction and reversal are append-only and never write the ledger', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    const instruction = await createInstruction(adminA, {
      employeeName: 'Correction Employee',
      employeeMobile: '01710101010',
      payoutMobile: '01710101010',
      method: 'bkash',
      amountMinor: 50000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-correction-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    const original = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);

    const correction = await correctBusinessPaidEvent(adminB, original.id, {
      amountMinor: 60000,
      reason: 'Amount corrected against the bank slip',
    });
    assert.equal(correction.eventType, 'CORRECTION');
    const summaryAfterCorrection = await businessPaidSummary();
    assert.equal(summaryAfterCorrection.totalPaidMinor, '60000');

    const reversal = await reverseBusinessPaidEvent(adminB, original.id, 'Owner confirmed the payment was cancelled');
    assert.equal(reversal.eventType, 'REVERSAL');
    const summaryAfterReversal = await businessPaidSummary();
    assert.equal(summaryAfterReversal.totalPaidMinor, '0');

    const originalAfter = await row('SELECT * FROM cash_payment_events WHERE id = $1', [original.id]);
    assert.equal(originalAfter.amount_minor, '50000', 'original event is untouched');
    assert.equal(originalAfter.status, 'PAID');
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_postings')).n, 0);
    assert.equal((await row('SELECT count(*)::int AS n FROM ledger_entries')).n, 0);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_reversals')).n, 0);
    await assert.rejects(
      () => reverseBusinessPaidEvent(adminB, original.id, 'again'),
      /PAYMENT_EVENT_ALREADY_REVERSED/,
    );
  });
});

test('business reporting counts events plus legacy POSTED without double counting', async () => {
  const acc = await account();
  // Legacy Phase 2 posting with no Business Paid Event.
  const legacy = await createInstruction(adminA, {
    employeeName: 'Legacy Posted Employee',
    employeeMobile: '01720202020',
    payoutMobile: '01720202020',
    method: 'cash',
    amountMinor: 11000,
    accountId: acc.id,
  });
  await approveInstruction(adminB, legacy.id);
  await postInstruction(adminB, legacy.id);

  // Verified business event not financially posted.
  await withFlag('1', async () => {
    await createInstruction(adminA, {
      employeeName: 'Business Paid Employee',
      employeeMobile: '01730303030',
      payoutMobile: '01730303030',
      method: 'bkash',
      amountMinor: 22000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-report-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});

    const summary = await cashDashboardSummary();
    assert.equal(summary.totalPaidMinor, '33000', '22000 business + 11000 legacy');
    assert.equal(
      Number(summary.viaWhatsAppPaidMinor) + Number(summary.byOfficePaidMinor),
      Number(summary.totalPaidMinor),
      'the WhatsApp and Office cards reconcile with the total card',
    );
    const detail = await listBusinessPaidEvents({limit: 100});
    assert.equal(detail.count, 2);
    assert.equal(detail.totalMinor, '33000');
    const sources = detail.rows.map((r) => r.source).sort();
    assert.deepEqual(sources, ['WEB', 'WHATSAPP']);
  });

  // Flag OFF: exactly the original POSTED-only definition.
  const postedOnly = await cashDashboardSummary();
  assert.equal(postedOnly.totalPaidMinor, '11000');
});

test('events are immutable at the database layer', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    const instruction = await createInstruction(adminA, {
      employeeName: 'Immutable Employee',
      employeeMobile: '01740404040',
      payoutMobile: '01740404040',
      method: 'cash',
      amountMinor: 1000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-immutable-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
    await assert.rejects(
      () => row("UPDATE cash_payment_events SET amount_minor = 1 WHERE id = $1", [event.id]),
      /IMMUTABLE_cash_payment_events|permission denied/,
    );
    await assert.rejects(
      () => row('DELETE FROM cash_payment_events WHERE id = $1', [event.id]),
      /IMMUTABLE_cash_payment_events|permission denied/,
    );
  });
});

test('Paid Event created without an Office approval does not create a submission', async () => {
  await withFlag('1', async () => {
    const acc = await account();
    await createInstruction(adminA, {
      employeeName: 'No Office Approval Employee',
      employeeMobile: '01750505050',
      payoutMobile: '01750505050',
      method: 'bkash',
      amountMinor: 9000,
      accountId: acc.id,
      sourceChannel: 'WHATSAPP',
      sourceMessageId: 'wa-no-office-1',
      sourceBlockKey: 'payment-block-0',
    }, {whatsAppVerified: true, paidAt: '2026-11-07T06:00:00Z'});
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_submissions')).n, 0);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_submission_reviews')).n, 0);
  });
});