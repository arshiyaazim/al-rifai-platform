// AL-RIFA'I — Phase 3 Increment 5: Review Queue service & DB integration tests.
// Requires disposable PostgreSQL prepared by scripts/standalone/install.mjs.
import assert from 'node:assert/strict';
import test, {before} from 'node:test';
import {row} from '../../lib/standalone/db.ts';
import {submitCash} from '../../lib/standalone/finance.ts';
import {
  correctCashSubmission,
  correctReviewItem,
  decideReview,
  getReviewDetail,
  listCashReviewCandidates,
  listReviewQueue,
  reviewQueueCounts,
  submitForReview,
  withdrawReview,
} from '../../lib/standalone/review.ts';
import {hashBootstrapPassword} from '../../lib/cash-portal.ts';
import {resetBusinessState} from './reset.mjs';

before(async () => { await resetBusinessState('alrifai-review-test-reset'); });

const adminA = {id: '1'.repeat(64), role: 'ADMIN'};
const adminB = {id: '2'.repeat(64), role: 'ADMIN'};
const staff = {id: '3'.repeat(64), role: 'USER'};

async function ensureActor(actor, username) {
  const hash = await hashBootstrapPassword('TestPass123');
  await row(
    `INSERT INTO cash_portal_users (id, username, password_hash, role, display_name, must_change_password, active, capabilities)
     VALUES ($1,$2,$3,$4,$2,false,true,'["workspace.admin"]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [actor.id, username, hash, actor.role],
  );
}

test('setup review actors', async () => {
  await ensureActor(adminA, 'review-admin-a');
  await ensureActor(adminB, 'review-admin-b');
  await ensureActor(staff, 'review-staff');
});

test('category-aware uniqueness allows distinct categories on same target_ref while blocking duplicates', async () => {
  const first = await submitForReview(adminA, {
    domain: 'PROGRAM',
    action: 'CREATE',
    targetRef: 'msg-uniq-1',
    payload: {
      category: 'INCOMPLETE_VESSEL_ORDER',
      sourceMessageId: 'msg-uniq-1',
      motherVessel: 'MV Alpha',
      lighterVessel: 'LV One',
      startDate: '2026-11-05',
      startShift: 'Day',
    },
  });
  const second = await submitForReview(adminA, {
    domain: 'PROGRAM',
    action: 'CREATE',
    targetRef: 'msg-uniq-1',
    payload: {
      category: 'VESSEL_DUPLICATE_CANDIDATE',
      sourceMessageId: 'msg-uniq-1',
      motherVessel: 'MV Alpha',
      lighterVessel: 'LV One',
      startDate: '2026-11-05',
      startShift: 'Day',
    },
  });
  assert.notEqual(first.id, second.id);

  await assert.rejects(
    () =>
      submitForReview(adminA, {
        domain: 'PROGRAM',
        action: 'CREATE',
        targetRef: 'msg-uniq-1',
        payload: {category: 'INCOMPLETE_VESSEL_ORDER', sourceMessageId: 'msg-uniq-1'},
      }),
    /PENDING_REVIEW_EXISTS/,
  );
});

test('listReviewQueue filters by state, domain, category, search query and mine', async () => {
  const pendingByCategory = await listReviewQueue({
    state: 'PENDING',
    domain: 'PROGRAM',
    category: 'VESSEL_DUPLICATE_CANDIDATE',
    q: 'msg-uniq-1',
  });
  assert.equal(pendingByCategory.length, 1);
  assert.equal(pendingByCategory[0].category, 'VESSEL_DUPLICATE_CANDIDATE');

  const mineStaff = await listReviewQueue({state: 'PENDING', mine: true, actor: staff});
  assert.equal(mineStaff.some((item) => item.target_ref === 'msg-uniq-1'), false);
});

test('correctReviewItem enforces ADMIN + non-submitter, keeps PENDING state and writes audit history', async () => {
  const created = await submitForReview(staff, {
    domain: 'PROGRAM',
    action: 'CREATE',
    targetRef: 'msg-correct-1',
    payload: {
      category: 'INCOMPLETE_VESSEL_ORDER',
      sourceMessageId: 'msg-correct-1',
      motherVessel: 'MV Beta',
      lighterVessel: 'LV Two',
      startDate: '2026-11-06',
      startShift: 'Day',
    },
  });

  await assert.rejects(
    () => correctReviewItem(staff, created.id, {destination: 'Chattogram'}),
    /ADMIN_REQUIRED|CAPABILITY_REQUIRED/,
  );

  const ownAdmin = await submitForReview(adminA, {
    domain: 'EMPLOYEE',
    action: 'CREATE',
    targetRef: 'emp-own-1',
    payload: {category: 'UNKNOWN_IDENTITY', employeeMobile: '01799887766', preferredName: 'Test Staff'},
  });
  await assert.rejects(
    () => correctReviewItem(adminA, ownAdmin.id, {preferredName: 'Updated Staff'}),
    /REVIEWER_IS_SUBMITTER/,
  );

  const res = await correctReviewItem(adminB, created.id, {destination: 'Chattogram', masterMobile: '01811223344'});
  assert.equal(res.state, 'PENDING');
  assert.equal(res.corrected, true);

  const detail = await getReviewDetail(created.id);
  assert.ok(detail);
  assert.equal(detail.kind, 'review_item');
  assert.equal(detail.item.state, 'PENDING');
  assert.equal(detail.item.payload.destination, 'Chattogram');
  assert.equal(detail.item.payload.masterMobile, '01811223344');
  assert.ok(detail.audit.some((entry) => entry.action === 'REVIEW_ITEM_CORRECTED'));
});

test('correctCashSubmission updates candidate without creating instruction or posting ledger', async () => {
  const beforeInstructions = await row('SELECT count(*)::int AS count FROM cash_instructions');
  const beforePostings = await row('SELECT count(*)::int AS count FROM cash_postings');

  const sub = await submitCash(staff, {
    rawText: 'Pay Karim 500 bkash',
    category: 'INCOMPLETE_CASH_INSTRUCTION',
    sourceMessageId: 'msg-cash-cand-1',
  });
  const corrected = await correctCashSubmission(adminA, sub.id, {
    employeeName: 'Karim Mia',
    payoutMobile: '01711223344',
    method: 'bkash',
    amountMinor: 50000,
    purpose: 'Conveyance',
  });
  assert.equal(corrected.state, 'PENDING_REVIEW');

  const detail = await getReviewDetail(sub.id);
  assert.ok(detail);
  assert.equal(detail.kind, 'cash_submission');
  assert.equal(detail.item.payload.amountMinor, 50000);

  const candidates = await listCashReviewCandidates({state: 'PENDING_REVIEW', q: 'Karim Mia'});
  assert.ok(candidates.some((entry) => entry.id === sub.id));

  const afterInstructions = await row('SELECT count(*)::int AS count FROM cash_instructions');
  const afterPostings = await row('SELECT count(*)::int AS count FROM cash_postings');
  assert.equal(afterInstructions.count, beforeInstructions.count);
  assert.equal(afterPostings.count, beforePostings.count);
});

test('reviewQueueCounts aggregates pending review_items and cash_submissions', async () => {
  const counts = await reviewQueueCounts();
  assert.ok(counts.pending >= 3);
  assert.ok(counts.cashPending >= 1);
  assert.ok((counts.byCategory.INCOMPLETE_VESSEL_ORDER ?? 0) >= 2);
});

test('withdrawReview and decideReview enforce submitter and admin separation', async () => {
  const item = await submitForReview(staff, {
    domain: 'EMPLOYEE',
    action: 'CREATE',
    targetRef: 'emp-decide-1',
    payload: {employeeMobile: '01611223344', preferredName: 'Jamal Hossain', dutyType: 'escort'},
  });
  await assert.rejects(() => withdrawReview(adminA, item.id), /NOT_SUBMITTER/);
  await assert.rejects(() => decideReview(staff, item.id, 'REJECTED', 'nope'), /ADMIN_REQUIRED|CAPABILITY_REQUIRED/);

  const rejected = await decideReview(adminA, item.id, 'REJECTED', 'Duplicate record');
  assert.equal(rejected.state, 'REJECTED');

  const resolvedList = await listReviewQueue({state: 'REJECTED', q: item.id});
  assert.equal(resolvedList.length, 1);
  assert.equal(resolvedList[0].decision, 'REJECTED');
});
