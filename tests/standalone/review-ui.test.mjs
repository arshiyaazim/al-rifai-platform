// AL-RIFA'I — Phase 3 Increment 5: Review Queue UI pure helper unit tests.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  REVIEW_CATEGORIES,
  REVIEW_CATEGORY_VALUES,
  buildReviewHref,
  canDecideReview,
  formatReviewAmount,
  formatReviewTimestamp,
  reviewActionsFor,
  reviewCategoryLabel,
  reviewCategoryTone,
  reviewConfirmationEvidence,
  reviewDomainLabel,
  reviewEscortConflict,
  reviewExtractedFieldValues,
  reviewExtractedFields,
  reviewMissingFields,
  reviewReasons,
  reviewSourceEvidence,
  reviewStateLabel,
  reviewStateTone,
  reviewVesselNames,
  sourceMessageHref,
} from '../../lib/review-ui.ts';

const adminA = {id: 'a'.repeat(64), role: 'ADMIN'};
const adminB = {id: 'b'.repeat(64), role: 'ADMIN'};
const staff = {id: 'c'.repeat(64), role: 'USER'};

test('review categories cover all 10 Phase 3 taxonomy entries', () => {
  assert.equal(REVIEW_CATEGORIES.length, 10);
  assert.equal(REVIEW_CATEGORY_VALUES.length, 10);
  assert.equal(reviewCategoryLabel('INCOMPLETE_VESSEL_ORDER'), 'Incomplete vessel order');
  assert.equal(reviewCategoryLabel(null), 'Uncategorised');
  assert.equal(reviewCategoryTone('UNKNOWN_IDENTITY'), 'danger');
  assert.equal(reviewCategoryTone('VESSEL_DUPLICATE_CANDIDATE'), 'warn');
  assert.equal(reviewCategoryTone('CUSTOM'), 'neutral');
});

test('domain and state labels and tones map deterministically', () => {
  assert.equal(reviewDomainLabel('PROGRAM'), 'Vessel program');
  assert.equal(reviewDomainLabel('CASH'), 'Cash');
  assert.equal(reviewDomainLabel(null), '—');
  assert.equal(reviewStateLabel('PENDING'), 'Pending');
  assert.equal(reviewStateLabel('RESOLVED'), 'Resolved');
  assert.equal(reviewStateLabel('WITHDRAWN'), 'Withdrawn');
  assert.equal(reviewStateTone('APPROVED'), 'ok');
  assert.equal(reviewStateTone('REJECTED'), 'danger');
  assert.equal(reviewStateTone('PENDING'), 'warn');
  assert.equal(reviewStateTone('WITHDRAWN'), 'neutral');
});

test('reviewActionsFor: non-submitter ADMIN can decide/correct PENDING item', () => {
  const item = {id: 'rev_1', domain: 'PROGRAM', state: 'PENDING', submitted_by: adminA.id};
  const actions = reviewActionsFor(adminB, item);
  assert.equal(actions.canApprove, true);
  assert.equal(actions.canReject, true);
  assert.equal(actions.canCorrect, true);
  assert.equal(actions.canMarkDuplicate, true);
  assert.equal(actions.canWithdraw, false);
  assert.equal(canDecideReview(adminB, item), true);
});

test('reviewActionsFor: submitter ADMIN cannot decide own item, only withdraw', () => {
  const item = {id: 'rev_2', domain: 'PROGRAM', state: 'PENDING', submitted_by: adminA.id};
  const actions = reviewActionsFor(adminA, item);
  assert.equal(actions.canApprove, false);
  assert.equal(actions.canReject, false);
  assert.equal(actions.canCorrect, false);
  assert.equal(actions.canWithdraw, true);
  assert.equal(canDecideReview(adminA, item), false);
});

test('reviewActionsFor: USER never receives approve, reject or correct controls', () => {
  const own = {id: 'rev_3', domain: 'EMPLOYEE', state: 'PENDING', submitted_by: staff.id};
  const other = {id: 'rev_4', domain: 'EMPLOYEE', state: 'PENDING', submitted_by: adminA.id};
  assert.deepEqual(reviewActionsFor(staff, own), {
    canApprove: false,
    canReject: false,
    canCorrect: false,
    canWithdraw: true,
    canMarkDuplicate: false,
  });
  assert.deepEqual(reviewActionsFor(staff, other), {
    canApprove: false,
    canReject: false,
    canCorrect: false,
    canWithdraw: false,
    canMarkDuplicate: false,
  });
});

test('reviewActionsFor: decided items disable all mutation actions', () => {
  const approved = {id: 'rev_5', domain: 'PROGRAM', state: 'APPROVED', submitted_by: adminA.id};
  assert.deepEqual(reviewActionsFor(adminB, approved), {
    canApprove: false,
    canReject: false,
    canCorrect: false,
    canWithdraw: false,
    canMarkDuplicate: false,
  });
});

test('reviewSourceEvidence extracts provenance and inbox link', () => {
  const evidence = reviewSourceEvidence({
    payload: {
      sourceMessageId: 'MSG-42',
      sourceChatJid: '120363000000000001@g.us',
      sourceAccountId: 'wa-01',
      senderJid: '8801711111111@s.whatsapp.net',
      direction: 'INCOMING',
      rawText: 'Mother Vessel: MV Star',
      parseReasons: ['missing_lighter_vessel'],
    },
  });
  assert.equal(evidence.messageId, 'MSG-42');
  assert.equal(evidence.chatJid, '120363000000000001@g.us');
  assert.equal(evidence.accountId, 'wa-01');
  assert.equal(evidence.needsReviewerResolution, true);
  assert.deepEqual(evidence.parseReasons, ['missing_lighter_vessel']);
  assert.equal(evidence.messageHref, '/messages?q=MSG-42&chat=120363000000000001%40g.us&account=wa-01');
});

test('reviewSourceEvidence prefers top-level source fields over nested payload', () => {
  const evidence = reviewSourceEvidence({
    sourceMessageId: 'TOP-1',
    sourceAccountId: 'wa-01',
    payload: {sourceMessageId: 'NESTED-1', needsReviewerResolution: false},
  });
  assert.equal(evidence.messageId, 'TOP-1');
  assert.equal(evidence.needsReviewerResolution, false);
});

test('reviewExtractedFields and reviewExtractedFieldValues merge nested fields in display order', () => {
  const item = {
    domain: 'PROGRAM',
    payload: {
      fields: {motherVessel: 'M.V. Ocean', destination: 'Mongla'},
      extractedFields: {lighterVessel: 'MV Delta 1'},
      masterMobile: '01712345678',
    },
  };
  const list = reviewExtractedFields(item);
  assert.deepEqual(list.map((entry) => entry.label), [
    'Mother vessel (original)',
    'Lighter vessel (original)',
    'Master mobile',
    'Destination',
  ]);
  const map = reviewExtractedFieldValues(item);
  assert.equal(map.motherVessel, 'M.V. Ocean');
  assert.equal(map.lighterVessel, 'MV Delta 1');
  assert.equal(map.masterMobile, '01712345678');
});

test('reviewReasons deduplicates router, parser, missing and decision reasons', () => {
  const list = reviewReasons({
    payload: {
      reasons: ['ambiguous_confirmation', 'missing_destination'],
      parseReasons: ['missing_destination'],
      missingFields: ['destination'],
      conflicts: ['escort_busy'],
      reason: 'Needs owner check',
    },
    decisionReason: 'Rejected duplicate',
  });
  assert.equal(list.length, 6);
  assert.deepEqual(list.map((r) => r.value), [
    'ambiguous_confirmation',
    'missing_destination',
    'destination',
    'escort_busy',
    'Needs owner check',
    'Rejected duplicate',
  ]);
});

test('reviewReasons includes decisionReason when unique', () => {
  const list = reviewReasons({
    payload: {reason: 'Incomplete'},
    decisionReason: 'Confirmed manually',
  });
  assert.equal(list.length, 2);
  assert.equal(list[1].label, 'Decision reason');
  assert.equal(list[1].value, 'Confirmed manually');
});

test('reviewMissingFields returns unique missing/conflict tokens', () => {
  const missing = reviewMissingFields({
    payload: {
      missingFields: ['lighterVessel', 'masterMobile'],
      missing: ['masterMobile'],
      conflicts: ['duplicate_window'],
    },
  });
  assert.deepEqual(missing, ['lighterVessel', 'masterMobile', 'duplicate_window']);
});

test('reviewVesselNames separates original and normalized vessel names', () => {
  const names = reviewVesselNames({
    payload: {
      originalMotherVessel: 'M.V. Star',
      motherVessel: 'M.V. Star',
      originalLighterVessel: 'L-7',
      normalizedMotherVessel: 'STAR',
      normalizedLighterVessel: 'L-7',
    },
  });
  assert.deepEqual(names.original, ['M.V. Star', 'L-7']);
  assert.deepEqual(names.normalized, ['STAR', 'L-7']);
});

test('reviewConfirmationEvidence and reviewEscortConflict read optional fields safely', () => {
  const conf = reviewConfirmationEvidence({payload: {confirmationMessageId: 'CONF-9'}});
  assert.equal(conf.messageId, 'CONF-9');
  assert.equal(conf.href, '/messages?q=CONF-9');
  assert.equal(reviewConfirmationEvidence({payload: {}}).href, null);
  assert.equal(reviewEscortConflict({payload: {escortConflict: 'Already assigned to L-2'}}), 'Already assigned to L-2');
  assert.equal(reviewEscortConflict({payload: {}}), null);
});

test('buildReviewHref and sourceMessageHref omit ALL/empty filters', () => {
  assert.equal(buildReviewHref({state: 'ALL', domain: 'ALL'}), '/review');
  assert.equal(buildReviewHref({state: 'PENDING', domain: 'PROGRAM', category: 'ALL'}), '/review?state=PENDING&domain=PROGRAM');
  assert.equal(sourceMessageHref(null), null);
});

test('formatReviewTimestamp formats valid ISO dates and preserves invalid strings', () => {
  assert.equal(formatReviewTimestamp(null), '—');
  assert.equal(formatReviewTimestamp('2026-11-05T14:30:00.000Z'), '2026-11-05 14:30');
  assert.equal(formatReviewTimestamp('not-a-date'), 'not-a-date');
});

test('formatReviewAmount formats paisa minor units as BDT', () => {
  assert.equal(formatReviewAmount(null), '—');
  assert.equal(formatReviewAmount(''), '—');
  assert.equal(formatReviewAmount(125050), '৳1,250.50');
  assert.equal(formatReviewAmount('50000'), '৳500.00');
});
