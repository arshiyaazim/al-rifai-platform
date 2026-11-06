// AL-RIFA'I — Phase 3 Live Router cutover safety tests.
//
// These tests are synthetic and run only against the disposable PostgreSQL
// database prepared by scripts/standalone/install.mjs. They verify that the
// Live Router is default-disabled, requires an explicit per-account watermark
// and business-chat allowlist, and never touches historical messages, while a
// separately authorized historical backfill remains independent.
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {row} from '../../lib/standalone/db.ts';
import {routePendingMessages} from '../../lib/message-router.ts';

const admin = {id: 'a'.repeat(64), role: 'ADMIN'};
const CASH_CHAT = '8801844836824@s.whatsapp.net';
const ORDER_CHAT = '120363000000000001@g.us';
const ADMIN_JID = '8801880446111@s.whatsapp.net';
const CLIENT_JID = '8801722222222@s.whatsapp.net';
const CASH_TEXT = 'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay';
const VESSEL_TEXT = 'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)';
const BUSINESS_CHATS = [CASH_CHAT, ORDER_CHAT];
let nextRowid = 1;

const setSetting = async (key, value) => {
  await row(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1,$2::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
};

async function ensureAccount(id = 'wa-01') {
  await row(
    `INSERT INTO whatsapp_accounts (id, label, enabled, transport, socket_path, account_jid, admin_jids)
     VALUES ($1,$2,true,'SQLITE_STORE',$3,NULL,$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, `Cutover ${id}`, `/tmp/cutover-${id}.sock`, JSON.stringify([ADMIN_JID])],
  );
  await row(
    `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
     VALUES ($1,$2,$2,'CASH',true),($1,$3,$3,'ORDERS',true)
     ON CONFLICT (account_id, chat_jid) DO UPDATE
       SET purpose = EXCLUDED.purpose, authorized = true`,
    [id, CASH_CHAT, ORDER_CHAT],
  );
  await row(
    `INSERT INTO whatsapp_sync_state (account_id, source_path, last_rowid)
     VALUES ($1,'/tmp/cutover-${id}.db',0)
     ON CONFLICT (account_id) DO NOTHING`,
    [id],
  );
  await row(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1,'0'::jsonb,now()),($2,$3::jsonb,now())
     ON CONFLICT (key) DO NOTHING`,
    [`phase3_cutover_rowid:${id}`, `phase3_business_chats:${id}`, JSON.stringify(BUSINESS_CHATS)],
  );
  await row(
    `INSERT INTO escort_client_group_authorizations
       (id, account_id, group_jid, participant_jid, client_contact_id, active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (id) DO UPDATE SET active = true`,
    [`ga-${id}-${CLIENT_JID}`, id, ORDER_CHAT, CLIENT_JID, `client-${id}`],
  );
}

async function stage(accountId, chatJid, messageId, direction, senderJid, text, options = {}) {
  const {
    status = 'PENDING',
    sourceRowid = nextRowid++,
    sourceTimestamp = null,
  } = options;
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content,
        content_hash, processing_status, source_rowid)
     VALUES ($1,$2,$3,$4,$5,coalesce($6::timestamptz,now()),$7,
             encode(sha256(convert_to($7,'UTF8')),'hex'),$8,$9)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO UPDATE
       SET direction = EXCLUDED.direction,
           sender_jid = EXCLUDED.sender_jid,
           source_timestamp = EXCLUDED.source_timestamp,
           text_content = EXCLUDED.text_content,
           content_hash = EXCLUDED.content_hash,
           processing_status = EXCLUDED.processing_status,
           source_rowid = EXCLUDED.source_rowid,
           retry_count = 0,
           last_error = NULL,
           last_processed_at = NULL,
           processed_at = NULL,
           classification = NULL`,
    [accountId, chatJid, messageId, direction, senderJid, sourceTimestamp, text, status, sourceRowid],
  );
}

const message = async (messageId) =>
  row("SELECT processing_status, classification, source_rowid FROM whatsapp_messages WHERE message_id = $1", [messageId]);
const count = async (table) => (await row(`SELECT count(*)::int AS n FROM ${table}`)).n;

beforeEach(async () => {
  nextRowid = 1;
  const owner = createPool({role: 'app', readOnly: false, applicationName: 'alrifai-cutover-test-reset'});
  try {
    await owner.query(`TRUNCATE TABLE
      audit_events, cash_instructions, cash_postings, ledger_entries,
      cash_submission_reviews, cash_submissions, review_decisions, review_items,
      attendance, identity_aliases, program_pay, program_source_messages,
      program_assignments, program_events, programs, employees,
      whatsapp_media, whatsapp_messages, whatsapp_chats, whatsapp_sync_state,
      whatsapp_accounts, whatsapp_import_runs, escort_client_group_authorizations,
      app_settings
      RESTART IDENTITY`);
  } finally {
    await owner.end();
  }
  await setSetting('phase3_router_enabled', true);
  await setSetting('phase3_cutover_rowid:wa-01', 0);
  await setSetting('phase3_cutover_rowid:wa-02', 0);
  await setSetting('phase3_business_chats:wa-01', BUSINESS_CHATS);
  await setSetting('phase3_business_chats:wa-02', BUSINESS_CHATS);
});

// 1. Router disabled by default / explicitly disabled.
test('cutover: disabled router performs no claim or business write', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_router_enabled', false);
  await stage('wa-01', CASH_CHAT, 'cut-disabled-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.disabled, true);
  assert.equal(result.processed, 0);
  assert.equal(await count('cash_instructions'), 0);
  assert.equal((await message('cut-disabled-1')).processing_status, 'PENDING');
});

// 2. Missing / invalid watermark fails closed.
test('cutover: missing or invalid watermark rejects processing', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 'not-a-number');
  await stage('wa-01', CASH_CHAT, 'cut-nowater-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.disabled, true);
  assert.match(result.reason, /CUTOVER_WATERMARK_MISSING/);
  assert.equal(await count('cash_instructions'), 0);
  assert.equal((await message('cut-nowater-1')).processing_status, 'PENDING');
});

// 3. Historical PENDING below watermark stays PENDING.
test('cutover: historical PENDING message is not processed', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-hist-pending-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 50});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.disabled, false);
  assert.equal(result.processed, 0);
  assert.equal(await count('cash_instructions'), 0);
  assert.equal((await message('cut-hist-pending-1')).processing_status, 'PENDING');
});

// 4. Historical FAILED below watermark stays FAILED.
test('cutover: historical FAILED message is excluded from retry', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-hist-failed-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'FAILED', sourceRowid: 50});
  await row("UPDATE whatsapp_messages SET retry_count = 1, last_processed_at = now() - interval '20 minutes' WHERE message_id = 'cut-hist-failed-1'");

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.processed, 0);
  assert.equal((await message('cut-hist-failed-1')).processing_status, 'FAILED');
});

// 5. Historical stale PROCESSING below watermark stays untouched.
test('cutover: historical stale PROCESSING message is excluded', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-hist-processing-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'PROCESSING', sourceRowid: 50});
  await row("UPDATE whatsapp_messages SET last_processed_at = now() - interval '40 minutes' WHERE message_id = 'cut-hist-processing-1'");

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.processed, 0);
  assert.equal((await message('cut-hist-processing-1')).processing_status, 'PROCESSING');
});

// 6. New message above watermark is eligible.
test('cutover: new message above watermark is processed', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-new-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.disabled, false);
  assert.equal(result.instructions, 1);
  assert.equal((await message('cut-new-1')).processing_status, 'COMPLETED');
  assert.equal(await count('cash_instructions'), 1);
});

// 7. Delayed WhatsApp timestamp with a new source_rowid is eligible.
test('cutover: delayed timestamp with new source_rowid is eligible', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-delayed-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {
    sourceRowid: 150,
    sourceTimestamp: '2026-10-01T00:00:00Z',
  });

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  assert.equal((await message('cut-delayed-1')).processing_status, 'COMPLETED');
});

// 8. Same WhatsApp message replay above watermark is idempotent.
test('cutover: same message replay above watermark does not duplicate', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-replay-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});
  await routePendingMessages(admin, 10);
  await stage('wa-01', CASH_CHAT, 'cut-replay-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});
  await routePendingMessages(admin, 10);

  assert.equal(await count('cash_instructions'), 1);
});

// 9. Concurrent router workers cannot double-process.
test('cutover: concurrent workers process an eligible message once', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-concurrent-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});
  await Promise.all([routePendingMessages(admin, 10), routePendingMessages(admin, 10)]);

  assert.equal(await count('cash_instructions'), 1);
  assert.equal((await message('cut-concurrent-1')).processing_status, 'COMPLETED');
});

// 10. Crash/retry recovery above watermark works.
test('cutover: stale PROCESSING above watermark is recovered', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-crash-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'PROCESSING', sourceRowid: 150});
  await row("UPDATE whatsapp_messages SET last_processed_at = now() - interval '40 minutes' WHERE message_id = 'cut-crash-1'");

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  assert.equal((await message('cut-crash-1')).processing_status, 'COMPLETED');
});

// 11. Per-account watermarks are independent.
test('cutover: per-account watermark isolation', async () => {
  await ensureAccount('wa-01');
  await ensureAccount('wa-02');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await setSetting('phase3_cutover_rowid:wa-02', 50);
  await stage('wa-01', CASH_CHAT, 'cut-iso-wa01-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 75});
  await stage('wa-02', ORDER_CHAT, 'cut-iso-wa02-1', 'INCOMING', CLIENT_JID, VESSEL_TEXT, {sourceRowid: 75});

  const result = await routePendingMessages(admin, 10);
  assert.equal((await message('cut-iso-wa01-1')).processing_status, 'PENDING');
  assert.equal((await message('cut-iso-wa02-1')).processing_status, 'COMPLETED');
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage.find((m) => m.messageId === 'cut-iso-wa02-1')?.classification, 'VESSEL_WA02_NOT_AUTHORIZED');
});

// 12. WA-02 remains excluded from business processing.
test('cutover: WA-02 above watermark is still rejected', async () => {
  await ensureAccount('wa-02');
  await setSetting('phase3_cutover_rowid:wa-02', 0);
  await stage('wa-02', ORDER_CHAT, 'cut-wa02-1', 'INCOMING', CLIENT_JID, VESSEL_TEXT, {sourceRowid: 100});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage[0]?.classification, 'VESSEL_WA02_NOT_AUTHORIZED');
  assert.equal(await count('programs'), 0);
});

// 13. Unauthorized chats are not claimed (capture != business authorization).
test('cutover: chat outside the business allowlist is not claimed', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', '999999999999@s.whatsapp.net', 'cut-unauth-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.processed, 0);
  assert.equal(await count('cash_instructions'), 0);
  assert.equal((await message('cut-unauth-1')).processing_status, 'PENDING');
});

// 14. Cash and Vessel domains do not cross.
test('cutover: cash/vessel domain separation is preserved', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', ORDER_CHAT, 'cut-sep-cash-in-orders-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});
  await stage('wa-01', CASH_CHAT, 'cut-sep-vessel-in-cash-1', 'INCOMING', CLIENT_JID, VESSEL_TEXT, {sourceRowid: 151});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.programs, 0);
  assert.equal(await count('cash_instructions'), 0);
  assert.equal(await count('programs'), 0);
});

// 15. Historical processing_status values remain unchanged below watermark.
test('cutover: historical statuses are preserved unchanged', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-status-pending-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'PENDING', sourceRowid: 50});
  await stage('wa-01', CASH_CHAT, 'cut-status-failed-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'FAILED', sourceRowid: 51});
  await stage('wa-01', CASH_CHAT, 'cut-status-processing-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {status: 'PROCESSING', sourceRowid: 52});
  await row("UPDATE whatsapp_messages SET retry_count = 1, last_processed_at = now() - interval '40 minutes' WHERE message_id IN ('cut-status-failed-1','cut-status-processing-1')");

  await routePendingMessages(admin, 10);
  assert.equal((await message('cut-status-pending-1')).processing_status, 'PENDING');
  assert.equal((await message('cut-status-failed-1')).processing_status, 'FAILED');
  assert.equal((await message('cut-status-processing-1')).processing_status, 'PROCESSING');
});

// 16. Historical backfill independence: the row remains and is not reclassified.
test('cutover: historical message remains available for a separate backfill', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-backfill-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 50});

  await routePendingMessages(admin, 10);
  const historical = await message('cut-backfill-1');
  assert.equal(historical.processing_status, 'PENDING');
  assert.equal(historical.source_rowid, '50');
  assert.equal(await count('cash_instructions'), 0);
});

// 17. A message inserted after watermark capture is eligible.
test('cutover: message inserted after watermark capture is eligible', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-after-capture-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 101});

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  assert.equal((await message('cut-after-capture-1')).processing_status, 'COMPLETED');
});

// 18. Restart does not move the watermark or reopen history.
test('cutover: restart keeps the watermark and history closed', async () => {
  await ensureAccount('wa-01');
  await setSetting('phase3_cutover_rowid:wa-01', 100);
  await stage('wa-01', CASH_CHAT, 'cut-restart-hist-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 50});
  await stage('wa-01', CASH_CHAT, 'cut-restart-new-1', 'OUTGOING', ADMIN_JID, CASH_TEXT, {sourceRowid: 150});
  await routePendingMessages(admin, 10);

  const watermark = await row("SELECT value FROM app_settings WHERE key = 'phase3_cutover_rowid:wa-01'");
  assert.equal(String(watermark.value), '100');
  assert.equal((await message('cut-restart-hist-1')).processing_status, 'PENDING');
  assert.equal((await message('cut-restart-new-1')).processing_status, 'COMPLETED');
  await routePendingMessages(admin, 10);
  assert.equal((await message('cut-restart-hist-1')).processing_status, 'PENDING');
  assert.equal(await count('cash_instructions'), 1);
});
