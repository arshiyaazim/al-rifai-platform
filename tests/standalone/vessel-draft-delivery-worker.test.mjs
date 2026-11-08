// Vessel Draft delivery worker + transport adapter tests.
// Isolated disposable DB only; the fake transport never opens a socket.
import assert from 'node:assert/strict';
import test, {after, before, beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {row} from '../../lib/standalone/db.ts';
import {
  deliveryTableAvailable,
  enqueueDraftForProgram,
} from '../../lib/standalone/vessel-draft-delivery-store.ts';
import {runVesselDraftDeliveryTick} from '../../lib/vessel-draft-delivery-worker.ts';
import {deliveryGate} from '../../lib/vessel-draft-delivery.ts';
import {sendVesselDraft, verifyVesselDraftSender} from '../../lib/vessel-draft-transport.ts';

const PROGRAM_ID = 'vdd-worker-test';
const RECIPIENT = 'worker-test-recipient@s.whatsapp.net';
const T0 = '2026-11-07T12:00:00.000Z';
const PROGRAM = {
  id: PROGRAM_ID,
  mother_vessel: 'VDD WORKER MV',
  lighter_vessel: 'VDD WORKER LT',
  master_mobile: '01711111111',
  destination: 'Chattogram',
  start_date: '2026-11-07',
  start_shift: 'D',
  source_message_id: 'vdd-worker-order-1',
  source_chat_jid: RECIPIENT,
};

let owner;

const config = {
  envEnabled: true,
  dbEnabled: true,
  ownerApprovedSender: 'approved-sender@s.whatsapp.net',
  ownerApprovedRecipient: RECIPIENT,
  transportConfigured: true,
  authorizedRecipientJids: [RECIPIENT],
};
const enabledGate = {config, gate: deliveryGate(config)};
const disabledGate = {
  config: {...config, envEnabled: false},
  gate: deliveryGate({...config, envEnabled: false}),
};
const paths = {socketPath: '/tmp/fake-mcp.sock', tokenFile: '/tmp/fake-token'};
// The worker verifies the bridge identity before every send. Tests never open a
// socket: they inject the approved identity result.
const verifiedSender = async () => ({ok: true, observed: config.ownerApprovedSender});
const validRecipient = async () => ({ok: true});

async function clean() {
  await owner.query('DELETE FROM vessel_draft_deliveries');
  await owner.query(
    `ALTER TABLE audit_events DISABLE TRIGGER audit_events_immutable;
     DELETE FROM audit_events WHERE entity = 'vessel_draft_delivery';
     ALTER TABLE audit_events ENABLE TRIGGER audit_events_immutable;`,
  );
}

async function seedSource() {
  await owner.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('phase3_business_chats:wa-01', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify([RECIPIENT])],
  );
  await owner.query(
    `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
     VALUES ('wa-01',$1,'test','ORDERS',true)
     ON CONFLICT (account_id, chat_jid) DO UPDATE SET purpose='ORDERS', authorized=true`,
    [RECIPIENT],
  );
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
     VALUES ('wa-01',$1,$2,'INCOMING',$1,now(),'order','hash-worker-order')
     ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE SET sender_jid=EXCLUDED.sender_jid`,
    [RECIPIENT, PROGRAM.source_message_id],
  );
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'vessel-draft-worker-test'});
  await clean();
  await owner.query('DELETE FROM programs WHERE id=$1', [PROGRAM_ID]);
  await owner.query(
    `INSERT INTO programs (id, mother_vessel, lighter_vessel, master_mobile, destination,
                           start_date, start_shift, state, source_channel, created_by,
                           source_message_id, source_chat_jid)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [PROGRAM.id, PROGRAM.mother_vessel, PROGRAM.lighter_vessel, PROGRAM.master_mobile,
      PROGRAM.destination, PROGRAM.start_date, PROGRAM.start_shift, 'DRAFT', 'WEB', 'system',
      PROGRAM.source_message_id, PROGRAM.source_chat_jid],
  );
  await seedSource();
});

beforeEach(async () => {
  await clean();
  await seedSource();
});

after(async () => {
  await clean();
  await owner.query('DELETE FROM programs WHERE id=$1', [PROGRAM_ID]);
  await owner.query("DELETE FROM app_settings WHERE key='phase3_business_chats:wa-01'");
  await owner.query('DELETE FROM whatsapp_chats WHERE chat_jid=$1', [RECIPIENT]);
  await owner.query("DELETE FROM whatsapp_messages WHERE account_id='wa-01' AND message_id=$1", [PROGRAM.source_message_id]);
  await owner.end();
});

test('worker claims a queued draft, sends once, persists SENT and audits', async () => {
  assert.equal(await deliveryTableAvailable(), true);
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  assert.equal(queued.status, 'QUEUED');
  const calls = [];
  const result = await runVesselDraftDeliveryTick({
    gate: enabledGate,
    paths,
    verifySender: verifiedSender,
    validateRecipient: validRecipient,
    transport: async (request, receivedPaths) => {
      calls.push({request, receivedPaths});
      return {kind: 'sent', deliveryRef: 'bridge-ref-1'};
    },
  });
  assert.deepEqual(
    {claimed: result.claimed, sent: result.sent, failed: result.failed, unknown: result.unknown},
    {claimed: 1, sent: 1, failed: 0, unknown: 0},
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].request.recipientJid, RECIPIENT);
  assert.equal(calls[0].request.accountId, 'wa-01');
  assert.match(calls[0].request.text, /^Mother Vessel: M\.V\. VDD WORKER MV/);
  assert.equal(calls[0].receivedPaths.socketPath, paths.socketPath);

  const saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'SENT');
  assert.equal(saved.delivery_ref, 'bridge-ref-1');
  assert.equal(saved.attempts, 1);
  const audit = await row(
    "SELECT count(*)::int AS n FROM audit_events WHERE entity='vessel_draft_delivery' AND entity_id=$1 AND action='VESSEL_DRAFT_DELIVERY_SENT'",
    [queued.record.id],
  );
  assert.equal(audit.n, 1);

  const repeat = await runVesselDraftDeliveryTick({gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient, transport: async () => {
    throw new Error('must not send');
  }});
  assert.equal(repeat.claimed, 0);
});

test('failed bridge result is retried only after backoff, then can succeed', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  const failed = await runVesselDraftDeliveryTick({
    gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient,
    transport: async () => ({kind: 'failed', error: 'BRIDGE_REJECTED'}),
  });
  assert.equal(failed.failed, 1);
  let saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'FAILED');
  assert.equal(saved.attempts, 1);
  assert.ok(saved.next_attempt_at);

  const tooEarly = await runVesselDraftDeliveryTick({gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient, transport: async () => {
    throw new Error('must not send before backoff');
  }});
  assert.equal(tooEarly.claimed, 0);

  await owner.query("UPDATE vessel_draft_deliveries SET next_attempt_at=now()-interval '1 minute' WHERE id=$1", [queued.record.id]);
  const retried = await runVesselDraftDeliveryTick({
    gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient,
    transport: async () => ({kind: 'sent', deliveryRef: 'retry-ref'}),
  });
  assert.equal(retried.claimed, 1);
  assert.equal(retried.sent, 1);
  saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'SENT');
  assert.equal(saved.attempts, 2);
});

test('transport ambiguity becomes terminal DELIVERY_UNKNOWN and is never resent', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  const unknown = await runVesselDraftDeliveryTick({
    gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient,
    transport: async () => ({kind: 'unknown', error: 'SOCKET_TIMEOUT'}),
  });
  assert.equal(unknown.unknown, 1);
  let saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'DELIVERY_UNKNOWN');
  const again = await runVesselDraftDeliveryTick({gate: enabledGate, paths, verifySender: verifiedSender,
    validateRecipient: validRecipient, transport: async () => {
    throw new Error('must never resend ambiguous');
  }});
  assert.equal(again.claimed, 0);
  saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'DELIVERY_UNKNOWN');
});

test('disabled gate claims nothing and leaves the queue intact', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  const result = await runVesselDraftDeliveryTick({
    gate: disabledGate, paths,
    verifySender: verifiedSender,
    validateRecipient: validRecipient,
    transport: async () => { throw new Error('must not send'); },
  });
  assert.equal(result.disabled, true);
  assert.equal(result.claimed, 0);
  const saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'QUEUED');
  assert.equal(saved.attempts, 0);
});

test('worker refuses to send when send-time recipient revalidation fails', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  let transportCalled = false;
  const result = await runVesselDraftDeliveryTick({
    gate: enabledGate,
    paths,
    validateRecipient: async () => ({ok: false, reason: 'SOURCE_CHAT_MISMATCH'}),
    verifySender: verifiedSender,
    transport: async () => {
      transportCalled = true;
      return {kind: 'sent', deliveryRef: 'must-not-exist'};
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(transportCalled, false, 'an invalid recipient may never send');
  const saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'FAILED');
  assert.match(saved.error, /VESSEL_DRAFT_RECIPIENT_INVALID/);
});

test('worker refuses to send when the bridge identity is not the approved sender', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  let transportCalled = false;
  const result = await runVesselDraftDeliveryTick({
    gate: enabledGate,
    paths,
    validateRecipient: validRecipient,
    verifySender: async () => ({
      ok: false,
      reason: 'VESSEL_DRAFT_SENDER_MISMATCH',
      observed: '8801999999999@s.whatsapp.net',
    }),
    transport: async () => {
      transportCalled = true;
      return {kind: 'sent', deliveryRef: 'must-not-exist'};
    },
  });
  assert.equal(result.failed, 1);
  assert.equal(result.sent, 0);
  assert.equal(transportCalled, false, 'a mismatched account may never send');
  const saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.equal(saved.state, 'FAILED');
  assert.match(saved.error, /SENDER_MISMATCH/);
});

test('worker refuses to send when the bridge identity cannot be read', async () => {
  const queued = await enqueueDraftForProgram(PROGRAM, config, T0);
  const result = await runVesselDraftDeliveryTick({
    gate: enabledGate,
    paths,
    validateRecipient: validRecipient,
    verifySender: async () => ({
      ok: false,
      reason: 'VESSEL_DRAFT_SENDER_IDENTITY_UNAVAILABLE:SOCKET_TIMEOUT',
      observed: null,
    }),
    transport: async () => { throw new Error('must not send'); },
  });
  assert.equal(result.failed, 1);
  const saved = await row('SELECT * FROM vessel_draft_deliveries WHERE id=$1', [queued.record.id]);
  assert.match(saved.error, /IDENTITY_UNAVAILABLE/);
});

test('sender adapter verifies the exact WA-01 identity and rejects a mismatch', async () => {
  const senderJid = '8801880446111@s.whatsapp.net';
  const matching = await verifyVesselDraftSender(
    senderJid,
    paths,
    async () => ({jid: '8801880446111:27@s.whatsapp.net'}),
  );
  assert.equal(matching.ok, true);
  const mismatch = await verifyVesselDraftSender(
    senderJid,
    paths,
    async () => ({jid: '8801999999999@s.whatsapp.net'}),
  );
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'VESSEL_DRAFT_SENDER_MISMATCH');
  const missing = await verifyVesselDraftSender(
    senderJid,
    paths,
    async () => ({}),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.reason, 'VESSEL_DRAFT_SENDER_IDENTITY_MISSING');
});

test('transport adapter maps success, rejection and thrown ambiguity', async () => {
  const request = {accountId: 'wa-01', recipientJid: RECIPIENT, text: 'x', idempotencyKey: 'k'};
  const ok = await sendVesselDraft(request, paths, async () => ({success: true, messageId: 'm-1'}));
  assert.deepEqual(ok, {kind: 'sent', deliveryRef: 'm-1'});
  const rejected = await sendVesselDraft(request, paths, async () => ({success: false, message: 'DENIED'}));
  assert.deepEqual(rejected, {kind: 'failed', error: 'DENIED'});
  const unknown = await sendVesselDraft(request, paths, async () => { throw new Error('TIMEOUT'); });
  assert.deepEqual(unknown, {kind: 'unknown', error: 'TIMEOUT'});
});