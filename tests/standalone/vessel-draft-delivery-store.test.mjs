// Durable WA-01 Vessel Draft delivery store — integration tests.
// Runs against the disposable DB prepared by scripts/standalone/install.mjs /
// migrate.mjs (migration 010 applied). No WhatsApp transport is called, no
// message is sent, and every fixture is removed afterwards.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import test, {after, before, beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {
  applyDeliveryOutcomeToStore,
  claimDueDeliveries,
  deliveryAuditTrail,
  deliveryStatusForPrograms,
  deliveryTableAvailable,
  enqueueDraftForProgram,
  prepareDeliveryRequest,
  recoverStuckDeliveries,
  runtimeDeliveryGate,
} from '../../lib/standalone/vessel-draft-delivery-store.ts';
import {row} from '../../lib/standalone/db.ts';

const COMPLETE_PROGRAM = 'vdd-test-complete';
const INCOMPLETE_PROGRAM = 'vdd-test-incomplete';
const RECIPIENT = 'test-recipient@s.whatsapp.net';
const T0 = '2026-11-07T12:00:00.000Z';

const testConfig = () => ({
  envEnabled: false,
  dbEnabled: false,
  ownerApprovedSender: null,
  ownerApprovedRecipient: RECIPIENT,
  transportConfigured: false,
});

let owner;

async function cleanAudit() {
  await owner.query(
    `ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
     DELETE FROM audit_events WHERE entity = 'vessel_draft_delivery';
     ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;`,
  );
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'vessel-draft-delivery-test'});
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query('DELETE FROM program_pay WHERE program_id IN ($1,$2)', [COMPLETE_PROGRAM, INCOMPLETE_PROGRAM]);
  await owner.query('DELETE FROM programs WHERE id IN ($1,$2)', [COMPLETE_PROGRAM, INCOMPLETE_PROGRAM]);
  const insertProgram = (id, masterMobile, lighterVessel, messageId) => owner.query(
    `INSERT INTO programs (id, mother_vessel, lighter_vessel, master_mobile, destination,
                           start_date, start_shift, state, source_channel, created_by, source_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [id, 'VDD TEST MV', lighterVessel, masterMobile, 'Chattogram',
      '2026-11-07', 'D', 'DRAFT', 'WEB', 'system', messageId],
  );
  await insertProgram(COMPLETE_PROGRAM, '01711111111', 'VDD TEST LT', 'vdd-test-order-1');
  await insertProgram(INCOMPLETE_PROGRAM, null, 'VDD TEST LT 2', 'vdd-test-order-2');
});

beforeEach(async () => {
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await cleanAudit();
});

after(async () => {
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query('DELETE FROM program_pay WHERE program_id IN ($1,$2)', [COMPLETE_PROGRAM, INCOMPLETE_PROGRAM]);
  await owner.query('DELETE FROM programs WHERE id IN ($1,$2)', [COMPLETE_PROGRAM, INCOMPLETE_PROGRAM]);
  await cleanAudit();
  await owner.end();
});

const completeProgram = () => ({
  id: COMPLETE_PROGRAM,
  mother_vessel: 'VDD TEST MV',
  lighter_vessel: 'VDD TEST LT',
  master_mobile: '01711111111',
  destination: 'Chattogram',
  start_date: '2026-11-07',
  start_shift: 'D',
  source_message_id: 'vdd-test-order-1',
});

test('migration 010 table is present and runtime gate stays disabled', async () => {
  assert.equal(await deliveryTableAvailable(), true);
  const {config, gate} = await runtimeDeliveryGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.mode, 'MANUAL_COPY_ONLY');
  assert.equal(config.ownerApprovedRecipient, null);
  assert.equal(config.ownerApprovedSender, null);
  assert.equal(config.transportConfigured, false);
  assert.ok(gate.reasons.length >= 4);
});

test('complete draft creates exactly one durable QUEUED record with an audit trail', async () => {
  const result = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  assert.equal(result.status, 'QUEUED');
  assert.match(result.record.id, /^vdd_[a-f0-9]{64}$/);
  assert.equal(result.record.state, 'QUEUED');
  assert.equal(result.record.accountId, 'wa-01');
  assert.equal(result.record.recipientJid, RECIPIENT);
  assert.match(result.record.text, /^Mother Vessel: M\.V\. VDD TEST MV/);
  const stored = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [result.record.id]);
  assert.ok(stored);
  assert.equal(stored.state, 'QUEUED');
  assert.equal(stored.content_hash, createHash('sha256').update(result.record.text).digest('hex'));
  const audit = await deliveryAuditTrail(result.record.id);
  assert.ok(audit.some((entry) => entry.action === 'VESSEL_DRAFT_DELIVERY_QUEUED'));
});

test('an unchanged draft is deduplicated (no second send)', async () => {
  const first = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  const second = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  assert.equal(first.status, 'QUEUED');
  assert.equal(second.status, 'DUPLICATE');
  assert.equal(second.record.id, first.record.id);
  const count = await row('SELECT count(*)::int AS n FROM vessel_draft_deliveries');
  assert.equal(count.n, 1);
  const audit = await deliveryAuditTrail(first.record.id);
  assert.ok(audit.some((entry) => entry.action === 'VESSEL_DRAFT_DELIVERY_DUPLICATE_SUPPRESSED'));
});

test('incomplete draft fields are blocked, never queued', async () => {
  const program = {
    id: INCOMPLETE_PROGRAM,
    mother_vessel: 'VDD TEST MV',
    lighter_vessel: 'VDD TEST LT 2',
    master_mobile: null,
    start_date: '2026-11-07',
    start_shift: 'D',
    source_message_id: 'vdd-test-order-2',
  };
  const result = await enqueueDraftForProgram(program, testConfig(), T0);
  assert.equal(result.status, 'BLOCKED');
  assert.ok(result.gaps.includes('MISSING_MASTER_MOBILE'));
  const count = await row('SELECT count(*)::int AS n FROM vessel_draft_deliveries WHERE program_id=$1', [INCOMPLETE_PROGRAM]);
  assert.equal(count.n, 0);
  const audit = await owner.query("SELECT action FROM audit_events WHERE entity='vessel_draft_delivery' AND entity_id=$1", [INCOMPLETE_PROGRAM]);
  assert.ok(audit.rows.some((entry) => entry.action === 'VESSEL_DRAFT_DELIVERY_BLOCKED'));
});

test('claim is transaction-safe and never claims the same row twice', async () => {
  const {record} = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  const first = await claimDueDeliveries(10, T0);
  assert.equal(first.length, 1);
  assert.equal(first[0].id, record.id);
  assert.equal(first[0].state, 'SENDING');
  assert.equal(first[0].attempts, 1);
  assert.ok(first[0].lease_until);
  const second = await claimDueDeliveries(10, T0);
  assert.equal(second.length, 0, 'a SENDING row must not be claimed again');
});

test('FAILED retries only after backoff; DELIVERY_UNKNOWN is terminal', async () => {
  const {record} = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  await claimDueDeliveries(10, T0);
  const failed = await applyDeliveryOutcomeToStore(record.id, {kind: 'failed', error: 'bridge rejected'}, T0);
  assert.equal(failed.state, 'FAILED');
  assert.ok(failed.next_attempt_at);
  const tooEarly = await claimDueDeliveries(10, T0);
  assert.equal(tooEarly.length, 0, 'backoff must be respected');
  const later = new Date(new Date(failed.next_attempt_at).getTime() + 1).toISOString();
  const retry = await claimDueDeliveries(10, later);
  assert.equal(retry.length, 1);
  assert.equal(retry[0].attempts, 2);
  const unknown = await applyDeliveryOutcomeToStore(record.id, {kind: 'unknown', error: 'socket timeout'}, later);
  assert.equal(unknown.state, 'DELIVERY_UNKNOWN');
  const afterUnknown = await claimDueDeliveries(10, new Date(Date.parse(later) + 10 * 60_000).toISOString());
  assert.equal(afterUnknown.length, 0, 'ambiguous delivery is never retried');
});

test('worker restart recovery marks abandoned leases DELIVERY_UNKNOWN', async () => {
  const {record} = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  await claimDueDeliveries(10, T0);
  const later = new Date(Date.parse(T0) + 10 * 60_000).toISOString();
  const recovered = await recoverStuckDeliveries(later);
  assert.equal(recovered, 1);
  const stored = await row('SELECT state, error, lease_until FROM vessel_draft_deliveries WHERE id=$1', [record.id]);
  assert.equal(stored.state, 'DELIVERY_UNKNOWN');
  assert.equal(stored.error, 'WORKER_RESTART');
  assert.equal(stored.lease_until, null);
  const again = await claimDueDeliveries(10, later);
  assert.equal(again.length, 0);
});

test('Admin status is visible and outbound request is denied while gate is off', async () => {
  const {record} = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  const status = await deliveryStatusForPrograms([COMPLETE_PROGRAM]);
  assert.equal(status.length, 1);
  assert.equal(status[0].state, 'QUEUED');
  const request = await prepareDeliveryRequest(record.id);
  assert.equal(request.allowed, false);
  assert.ok(request.reasons.includes('VESSEL_DRAFT_OUTBOUND_ENV_DISABLED'));
});
