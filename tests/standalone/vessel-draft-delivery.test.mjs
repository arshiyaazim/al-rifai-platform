// Pure Vessel Draft delivery tests. No database, no bridge, no outbound send.
import test from 'node:test';
import assert from 'node:assert/strict';
import {renderOwnerDraftFields} from '../../lib/order-draft-template.ts';
import {
  CONFIRMATION_RULE,
  MAX_DELIVERY_ATTEMPTS,
  MemoryDraftDeliveryStore,
  VESSEL_DRAFT_DELIVERY_MODE,
  VESSEL_DRAFT_OUTBOUND_ACCOUNT,
  applyDeliveryOutcome,
  buildOutboundRequest,
  deliveryGate,
  deliveryGateFromEnv,
  deliveryViewModel,
  draftIdempotencyKey,
  enqueueDraftDelivery,
  isOwnerDraftShape,
  isRetryDue,
  markSending,
  prepareDraftDelivery,
  requeueDelivery,
  retryDelayMs,
} from '../../lib/vessel-draft-delivery.ts';

const DRAFT = renderOwnerDraftFields({
  motherVessel: 'CLONE INTAKE',
  lighterVessel: 'L-CLONE-01',
  masterMobile: '01711111111',
  destination: 'Chattogram',
  date: '2026-11-07',
  shift: 'D',
});

const RECIPIENT = '8801880446111@s.whatsapp.net';
const T0 = '2026-11-07T12:00:00.000Z';
const prepared = () => prepareDraftDelivery({
  programId: 'prog_test_1',
  sourceMessageId: 'msg-order-1',
  text: DRAFT,
  recipientJid: RECIPIENT,
  now: T0,
});

const enabledConfig = () => ({
  envEnabled: true,
  dbEnabled: true,
  ownerApprovedSender: '8801880446111@s.whatsapp.net',
  ownerApprovedRecipient: RECIPIENT,
  transportConfigured: true,
  authorizedRecipientJids: [RECIPIENT],
});

test('Owner draft keeps the exact shape with blank escort fields', () => {
  assert.equal(isOwnerDraftShape(DRAFT), true);
  assert.match(DRAFT, /^Escort Name:\s*$/m);
  assert.match(DRAFT, /^Escort Mobile:\s*$/m);
  assert.equal(isOwnerDraftShape(DRAFT.replace('Escort Name:', 'Escort Name: Someone')), false);
  assert.equal(isOwnerDraftShape('not a draft'), false);
});

test('idempotency key is stable per program/text/recipient and changes otherwise', () => {
  const key = draftIdempotencyKey({programId: 'prog_test_1', text: DRAFT, recipientJid: RECIPIENT});
  assert.match(key, /^vdd_[a-f0-9]{64}$/);
  assert.equal(key, draftIdempotencyKey({programId: 'prog_test_1', text: DRAFT, recipientJid: RECIPIENT}));
  assert.notEqual(key, draftIdempotencyKey({programId: 'prog_test_2', text: DRAFT, recipientJid: RECIPIENT}));
  assert.notEqual(key, draftIdempotencyKey({programId: 'prog_test_1', text: DRAFT + ' ', recipientJid: RECIPIENT}));
  assert.notEqual(key, draftIdempotencyKey({programId: 'prog_test_1', text: DRAFT, recipientJid: '8801999999999@s.whatsapp.net'}));
});

test('prepareDraftDelivery produces a PREPARED WA-01 record, never a send', () => {
  const record = prepared();
  assert.equal(record.state, 'PREPARED');
  assert.equal(record.accountId, VESSEL_DRAFT_OUTBOUND_ACCOUNT);
  assert.equal(record.recipientJid, RECIPIENT);
  assert.equal(record.attempts, 0);
  assert.equal(record.id, draftIdempotencyKey({programId: record.programId, text: DRAFT, recipientJid: RECIPIENT}));
  assert.equal(record.deliveryRef, null);
});

test('incomplete or invalid drafts are rejected rather than transmitted', () => {
  assert.throws(() => prepareDraftDelivery({programId: '', text: DRAFT, recipientJid: RECIPIENT}), /VESSEL_DRAFT_PROGRAM_REQUIRED/);
  assert.throws(() => prepareDraftDelivery({programId: 'p', text: DRAFT, recipientJid: ''}), /VESSEL_DRAFT_RECIPIENT_REQUIRED/);
  assert.throws(() => prepareDraftDelivery({programId: 'p', text: 'incomplete', recipientJid: RECIPIENT}), /VESSEL_DRAFT_TEXT_INVALID/);
});

test('enqueue is idempotent: a duplicate key is never queued twice', async () => {
  const store = new MemoryDraftDeliveryStore();
  const first = await enqueueDraftDelivery(store, prepared(), T0);
  assert.equal(first.queued, true);
  assert.equal(first.duplicate, false);
  assert.equal(first.record.state, 'QUEUED');
  const second = await enqueueDraftDelivery(store, prepared(), T0);
  assert.equal(second.queued, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.record.state, 'QUEUED');
  assert.equal(store.records.size, 1);
});

test('outbound request is prepared but never executed by the module', () => {
  const config = enabledConfig();
  const gate = deliveryGate(config);
  assert.equal(gate.enabled, true);
  assert.equal(gate.mode, 'OUTBOUND_APPROVED');
  const {record} = {record: {...prepared(), state: 'QUEUED'}};
  const result = buildOutboundRequest(record, gate, config);
  assert.equal(result.allowed, true);
  assert.deepEqual(result.request, {
    accountId: 'wa-01',
    recipientJid: RECIPIENT,
    text: DRAFT,
    idempotencyKey: record.id,
  });
});

test('default gate stays MANUAL_COPY_ONLY with five independent blocks', () => {
  const config = deliveryGateFromEnv({});
  const gate = deliveryGate(config);
  assert.equal(gate.enabled, false);
  assert.equal(gate.mode, VESSEL_DRAFT_DELIVERY_MODE);
  assert.deepEqual(gate.reasons, [
    'VESSEL_DRAFT_OUTBOUND_ENV_DISABLED',
    'VESSEL_DRAFT_OUTBOUND_DB_DISABLED',
    'VESSEL_DRAFT_SENDER_NOT_APPROVED',
    'VESSEL_DRAFT_RECIPIENT_NOT_APPROVED',
    'VESSEL_DRAFT_TRANSPORT_NOT_CONFIGURED',
  ]);
  const denied = buildOutboundRequest({...prepared(), state: 'QUEUED'}, gate, config);
  assert.equal(denied.allowed, false);
});

test('recipient mismatch is refused even when the gate is enabled', () => {
  const config = enabledConfig();
  const record = {...prepared(), state: 'QUEUED', recipientJid: '8801999999999@s.whatsapp.net'};
  const result = buildOutboundRequest(record, deliveryGate(config), config);
  assert.equal(result.allowed, false);
  assert.ok(result.reasons.includes('VESSEL_DRAFT_RECIPIENT_MISMATCH'));
});

test('an approved group conversation is a valid recipient', () => {
  const group = '120363426895117693@g.us';
  const config = {
    ...enabledConfig(),
    ownerApprovedRecipient: null,
    authorizedRecipientJids: [group],
  };
  const record = {...prepared(), state: 'QUEUED', recipientJid: group};
  const result = buildOutboundRequest(record, deliveryGate(config), config);
  assert.equal(result.allowed, true);
  assert.equal(result.request.recipientJid, group);
});

test('without a pin the recipient must be one approved business conversation', () => {
  const client = '8801555000001@s.whatsapp.net';
  const config = {
    ...enabledConfig(),
    ownerApprovedRecipient: null,
    authorizedRecipientJids: [client],
  };
  const gate = deliveryGate(config);
  assert.equal(gate.enabled, true);

  const approved = {...prepared(), state: 'QUEUED', recipientJid: client};
  assert.equal(buildOutboundRequest(approved, gate, config).allowed, true);

  const stranger = {
    ...prepared(),
    state: 'QUEUED',
    recipientJid: '8801555999999@s.whatsapp.net',
  };
  const denied = buildOutboundRequest(stranger, gate, config);
  assert.equal(denied.allowed, false);
  assert.ok(denied.reasons.includes('VESSEL_DRAFT_RECIPIENT_MISMATCH'));
});

test('SENT is terminal and cannot be sent again', () => {
  const config = enabledConfig();
  const gate = deliveryGate(config);
  let record = {...prepared(), state: 'QUEUED'};
  record = markSending(record, T0);
  record = applyDeliveryOutcome(record, {kind: 'sent', deliveryRef: 'bridge-ref-1'}, T0);
  assert.equal(record.state, 'SENT');
  assert.equal(record.deliveryRef, 'bridge-ref-1');
  const again = buildOutboundRequest(record, gate, config);
  assert.equal(again.allowed, false);
  assert.ok(again.reasons.includes('VESSEL_DRAFT_DELIVERY_TERMINAL'));
});

test('DELIVERY_UNKNOWN is terminal and never retried automatically', () => {
  let record = {...prepared(), state: 'QUEUED'};
  record = markSending(record, T0);
  record = applyDeliveryOutcome(record, {kind: 'unknown', error: 'socket timeout'}, T0);
  assert.equal(record.state, 'DELIVERY_UNKNOWN');
  assert.equal(isRetryDue(record, T0), false);
  assert.throws(() => requeueDelivery(record, T0), /VESSEL_DRAFT_RETRY_NOT_DUE/);
});

test('FAILED retries are bounded and only due after backoff', () => {
  let record = {...prepared(), state: 'QUEUED'};
  const config = enabledConfig();
  const gate = deliveryGate(config);
  for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
    record = markSending(record, T0);
    record = applyDeliveryOutcome(record, {kind: 'failed', error: 'bridge rejected'}, T0);
    if (attempt < MAX_DELIVERY_ATTEMPTS) {
      assert.equal(record.state, 'FAILED');
      assert.equal(record.attempts, attempt);
      assert.equal(retryDelayMs(attempt), 60_000 * 2 ** (attempt - 1));
      assert.equal(isRetryDue(record, T0), false, 'not due immediately');
      const dueAt = new Date(new Date(record.nextAttemptAt).getTime() + 1).toISOString();
      assert.equal(isRetryDue(record, dueAt), true);
      record = requeueDelivery(record, dueAt);
      assert.equal(record.state, 'QUEUED');
    } else {
      assert.equal(record.state, 'DEAD');
      assert.equal(record.nextAttemptAt, null);
      assert.equal(isRetryDue(record, dueAtAfter(record)), false);
    }
  }
  assert.equal(buildOutboundRequest(record, gate, config).allowed, false);
});

function dueAtAfter(record) {
  return new Date(new Date(record.updatedAt).getTime() + 10 * 60_000).toISOString();
}

test('delivery view model never claims a send and preserves the confirmation rule', () => {
  const config = deliveryGateFromEnv({});
  const gate = deliveryGate(config);
  const view = deliveryViewModel(prepared(), gate);
  assert.equal(view.mode, VESSEL_DRAFT_DELIVERY_MODE);
  assert.equal(view.sent, false);
  assert.equal(view.state, 'PREPARED');
  assert.equal(view.notSentReason, 'VESSEL_DRAFT_OUTBOUND_ENV_DISABLED');
  assert.equal(view.escortFieldsBlank, true);
  assert.equal(view.confirmationRule, CONFIRMATION_RULE);
});
