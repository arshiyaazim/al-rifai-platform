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
  revalidateQueuedRecipient,
  runtimeDeliveryGate,
} from '../../lib/standalone/vessel-draft-delivery-store.ts';
import {row} from '../../lib/standalone/db.ts';

const COMPLETE_PROGRAM = 'vdd-test-complete';
const GROUP_PROGRAM = 'vdd-test-group';
const INCOMPLETE_PROGRAM = 'vdd-test-incomplete';
const SOURCE_CHAT = '8801777000099@s.whatsapp.net';
const GROUP_CHAT = '120363426895117799@g.us';
const OUTSIDE_CHAT = '8801777000098@s.whatsapp.net';
const GROUP_SENDER = '114109177684169';
const T0 = '2026-11-07T12:00:00.000Z';

const testConfig = () => ({
  envEnabled: false,
  dbEnabled: false,
  ownerApprovedSender: null,
  ownerApprovedRecipient: SOURCE_CHAT,
  transportConfigured: false,
  authorizedRecipientJids: [SOURCE_CHAT, GROUP_CHAT],
});

let owner;

async function cleanAudit() {
  await owner.query(
    `ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
     DELETE FROM audit_events WHERE entity = 'vessel_draft_delivery';
     ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;`,
  );
}

async function insertMessage(id, chat, sender) {
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
     VALUES ('wa-01',$1,$2,'INCOMING',$3,now(),'order',$4)
     ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE SET sender_jid=EXCLUDED.sender_jid`,
    [chat, id, sender, `hash-${chat}-${id}`],
  );
}

async function seedAuthorization() {
  await owner.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('phase3_business_chats:wa-01', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify([SOURCE_CHAT, GROUP_CHAT])],
  );
  for (const chat of [SOURCE_CHAT, GROUP_CHAT]) {
    await owner.query(
      `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
       VALUES ('wa-01',$1,'test','ORDERS',true)
       ON CONFLICT (account_id, chat_jid) DO UPDATE SET purpose='ORDERS', authorized=true`,
      [chat],
    );
  }
  await owner.query(
    `INSERT INTO escort_client_group_authorizations
       (id, account_id, group_jid, participant_jid, client_contact_id, active)
     VALUES ('wga-vdd-store','wa-01',$1,$2,'test-client',true)
     ON CONFLICT (id) DO UPDATE SET active=true`,
    [GROUP_CHAT, GROUP_SENDER],
  );
  await insertMessage('vdd-test-order-1', SOURCE_CHAT, SOURCE_CHAT);
  await insertMessage('vdd-test-order-group', GROUP_CHAT, GROUP_SENDER);
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'vessel-draft-delivery-test'});
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query('DELETE FROM program_pay WHERE program_id IN ($1,$2,$3)', [
    COMPLETE_PROGRAM, GROUP_PROGRAM, INCOMPLETE_PROGRAM,
  ]);
  await owner.query('DELETE FROM programs WHERE id IN ($1,$2,$3)', [
    COMPLETE_PROGRAM, GROUP_PROGRAM, INCOMPLETE_PROGRAM,
  ]);
  const insertProgram = (id, masterMobile, lighterVessel, messageId, chat) => owner.query(
    `INSERT INTO programs (id, mother_vessel, lighter_vessel, master_mobile, destination,
                           start_date, start_shift, state, source_channel, created_by,
                           source_message_id, source_chat_jid, event_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$6::date)`,
    [id, 'VDD TEST MV', lighterVessel, masterMobile, 'Chattogram',
      '2026-11-07', 'D', 'DRAFT', 'WEB', 'system', messageId, chat],
  );
  await insertProgram(COMPLETE_PROGRAM, '01711111111', 'VDD TEST LT', 'vdd-test-order-1', SOURCE_CHAT);
  await insertProgram(GROUP_PROGRAM, '01722222222', 'VDD TEST LT GROUP', 'vdd-test-order-group', GROUP_CHAT);
  await insertProgram(INCOMPLETE_PROGRAM, null, 'VDD TEST LT 2', 'vdd-test-order-2', SOURCE_CHAT);
});

beforeEach(async () => {
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query("DELETE FROM whatsapp_messages WHERE account_id='wa-01' AND message_id LIKE 'vdd-test-order%'");
  await seedAuthorization();
  await cleanAudit();
});

after(async () => {
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query("DELETE FROM whatsapp_messages WHERE account_id='wa-01' AND message_id LIKE 'vdd-test-order%'");
  await owner.query("DELETE FROM app_settings WHERE key='phase3_business_chats:wa-01'");
  await owner.query("DELETE FROM whatsapp_chats WHERE chat_jid IN ($1,$2,$3)", [SOURCE_CHAT, GROUP_CHAT, OUTSIDE_CHAT]);
  await owner.query("DELETE FROM escort_client_group_authorizations WHERE id='wga-vdd-store'");
  await owner.query('DELETE FROM program_pay WHERE program_id IN ($1,$2,$3)', [
    COMPLETE_PROGRAM, GROUP_PROGRAM, INCOMPLETE_PROGRAM,
  ]);
  await owner.query('DELETE FROM programs WHERE id IN ($1,$2,$3)', [
    COMPLETE_PROGRAM, GROUP_PROGRAM, INCOMPLETE_PROGRAM,
  ]);
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
  source_chat_jid: SOURCE_CHAT,
});

const groupProgram = () => ({
  id: GROUP_PROGRAM,
  mother_vessel: 'VDD TEST MV',
  lighter_vessel: 'VDD TEST LT GROUP',
  master_mobile: '01722222222',
  destination: 'Chattogram',
  start_date: '2026-11-07',
  start_shift: 'D',
  source_message_id: 'vdd-test-order-group',
  source_chat_jid: GROUP_CHAT,
});

test('migration 010 table is present and runtime gate stays disabled', async () => {
  assert.equal(await deliveryTableAvailable(), true);
  const {config, gate} = await runtimeDeliveryGate();
  assert.equal(gate.enabled, false);
  assert.equal(gate.mode, 'MANUAL_COPY_ONLY');
  assert.equal(config.ownerApprovedRecipient, null);
  assert.equal(config.ownerApprovedSender, null);
  assert.equal(config.transportConfigured, false);
  assert.ok(config.authorizedRecipientJids.includes(SOURCE_CHAT));
  assert.ok(gate.reasons.length >= 4);
});

test('the direct source conversation is the recipient, never an Admin fallback', async () => {
  const result = await enqueueDraftForProgram(completeProgram(), {
    ...testConfig(),
    ownerApprovedRecipient: null,
  }, T0);
  assert.equal(result.status, 'QUEUED');
  assert.equal(result.record.recipientJid, SOURCE_CHAT);
  const audit = await owner.query(
    "SELECT detail FROM audit_events WHERE entity='vessel_draft_delivery' AND action='VESSEL_DRAFT_DELIVERY_QUEUED' ORDER BY at DESC LIMIT 1",
  );
  assert.equal(audit.rows[0].detail.recipientBasis, 'SOURCE_CONVERSATION');
});

test('an approved group source conversation is the recipient', async () => {
  const result = await enqueueDraftForProgram(groupProgram(), {
    ...testConfig(),
    ownerApprovedRecipient: null,
  }, T0);
  assert.equal(result.status, 'QUEUED');
  assert.equal(result.record.recipientJid, GROUP_CHAT);
});

test('a source conversation outside the business allowlist is blocked', async () => {
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
     VALUES ('wa-01',$1,'vdd-test-order-outside','INCOMING',$1,now(),'order','hash-outside')
     ON CONFLICT (account_id, chat_jid, message_id) DO NOTHING`,
    [OUTSIDE_CHAT],
  );
  const result = await enqueueDraftForProgram({
    ...completeProgram(),
    source_message_id: 'vdd-test-order-outside',
    source_chat_jid: OUTSIDE_CHAT,
  }, {
    ...testConfig(),
    ownerApprovedRecipient: null,
  }, T0);
  assert.equal(result.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(result.reason, 'SOURCE_CONVERSATION_NOT_IN_BUSINESS_SCOPE');
  const count = await row('SELECT count(*)::int AS n FROM vessel_draft_deliveries');
  assert.equal(count.n, 0);
});

test('complete draft creates exactly one durable QUEUED record with an audit trail', async () => {
  const result = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  assert.equal(result.status, 'QUEUED');
  assert.match(result.record.id, /^vdd_[a-f0-9]{64}$/);
  assert.equal(result.record.state, 'QUEUED');
  assert.equal(result.record.accountId, 'wa-01');
  assert.equal(result.record.recipientJid, SOURCE_CHAT);
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
    source_chat_jid: SOURCE_CHAT,
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
  assert.equal(status[0].recipient_jid, SOURCE_CHAT);
  assert.equal(status[0].source_message_id, 'vdd-test-order-1');
  const request = await prepareDeliveryRequest(record.id);
  assert.equal(request.allowed, false);
  assert.ok(request.reasons.includes('VESSEL_DRAFT_OUTBOUND_ENV_DISABLED'));
});

test('send-time revalidation refuses a record that no longer matches the source chat', async () => {
  const {record} = await enqueueDraftForProgram(completeProgram(), testConfig(), T0);
  const config = testConfig();
  const valid = await revalidateQueuedRecipient(record, config);
  assert.equal(valid.ok, true);

  const tampered = {...record, recipientJid: GROUP_CHAT};
  const invalid = await revalidateQueuedRecipient(tampered, config);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.reason, 'RECORD_RECIPIENT_MISMATCH');
});
