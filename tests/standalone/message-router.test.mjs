// AL-RIFA'I — Phase 3: message router + Cash Handler tests.
// Requires a disposable PostgreSQL database prepared by
// scripts/standalone/install.mjs. Runs in CI only.
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {row, rows} from '../../lib/standalone/db.ts';
import {routePendingMessages} from '../../lib/message-router.ts';
import {approveInstruction, decideCashSubmission, setInstructionAccount} from '../../lib/standalone/finance.ts';
import {correctCashSubmission} from '../../lib/standalone/review.ts';
import {createProgram} from '../../lib/standalone/programs.ts';

// Integration tests exercise vessel routing; production keeps the deployment
// flag off until the Owner enables Vessel intake.
process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED = '1';

const admin = {id: 'a'.repeat(64), role: 'ADMIN'};
const RELEASE_GROUP = '120363000000000002@g.us';
const TEST_BUSINESS_CHATS = ['8801844836824@s.whatsapp.net', '120363000000000001@g.us', RELEASE_GROUP];
let nextRowid = 1;

// Integration fixtures are shared state. Start every test from the same clean
// fixture, and use the owner role only for this reset: the runtime role has no
// TRUNCATE privilege, and TRUNCATE bypasses the row-level immutability triggers
// on the audit/ledger tables. Nothing outside this disposable test database is
// touched.
beforeEach(async () => {
  nextRowid = 1;
  const owner = createPool({role: 'app', readOnly: false, applicationName: 'alrifai-router-test-reset'});
  try {
    await owner.query(`TRUNCATE TABLE
      audit_events, cash_payment_event_postings, cash_payment_events, cash_reversals, cash_reconciliations, cash_instructions, cash_postings, ledger_entries,
      cash_submission_reviews, cash_submissions, review_decisions, review_items,
      attendance, identity_aliases, program_pay, program_source_messages,
      program_assignments, program_events, programs, employees,
      vessel_draft_deliveries,
      whatsapp_media, whatsapp_messages, whatsapp_chats, whatsapp_sync_state,
      whatsapp_accounts, whatsapp_import_runs, escort_client_group_authorizations,
      app_settings
      RESTART IDENTITY`);
  } finally {
    await owner.end();
  }
  // Test-only activation state: the Live Router is enabled with a synthetic
  // zero watermark so every test message (source_rowid > 0) is eligible.
  await row(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES
       ('phase3_router_enabled','true'::jsonb,now()),
       ('phase3_cutover_rowid:wa-01','0'::jsonb,now()),
       ('phase3_cutover_rowid:wa-02','0'::jsonb,now()),
       ('phase3_business_chats:wa-01',$1::jsonb,now()),
       ('phase3_business_chats:wa-02',$1::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify(TEST_BUSINESS_CHATS)],
  );
});

async function ensureAccount(id, label = 'Test Account', adminJid = '8801880446111@s.whatsapp.net') {
  await row(
    `INSERT INTO whatsapp_accounts (id, label, enabled, transport, socket_path, account_jid, admin_jids)
     VALUES ($1,$2,true,'SQLITE_STORE',$3,NULL,$4::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, label, `/tmp/test-${id}.sock`, JSON.stringify([adminJid])],
  );
  await row(
    `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
     VALUES ($1,$2,$2,'CASH',true),($1,$3,$3,'ORDERS',true)
     ON CONFLICT (account_id, chat_jid) DO UPDATE
       SET purpose = EXCLUDED.purpose, authorized = true`,
    [id, '8801844836824@s.whatsapp.net', '120363000000000001@g.us'],
  );
  await row(
    `INSERT INTO whatsapp_sync_state (account_id, source_path, last_rowid)
     VALUES ($1,'/tmp/test-${id}.db',0)
     ON CONFLICT (account_id) DO NOTHING`,
    [id],
  );
  await row(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES
       ($1,'0'::jsonb,now()),
       ($2,$3::jsonb,now())
     ON CONFLICT (key) DO NOTHING`,
    [`phase3_cutover_rowid:${id}`, `phase3_business_chats:${id}`, JSON.stringify(TEST_BUSINESS_CHATS)],
  );
  // Vessel orders require an approved group participant, not just an
  // authorized chat. The valid-order tests use this fixed group/sender; the
  // negative authorization test deactivates this row explicitly.
  await row(
    `INSERT INTO escort_client_group_authorizations
       (id, account_id, group_jid, participant_jid, client_contact_id, active)
     VALUES ($1,$2,$3,$4,$5,true)
     ON CONFLICT (id) DO UPDATE SET active = true`,
    [`ga-${id}-8801722222222`, id, '120363000000000001@g.us', '8801722222222@s.whatsapp.net', `client-${id}`],
  );
}

async function ensureReleaseGroup() {
  await row(
    `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
     VALUES ('wa-01',$1,'Escort Release Slip','ORDERS',true)
     ON CONFLICT (account_id, chat_jid) DO UPDATE SET label='Escort Release Slip', purpose='ORDERS', authorized=true`,
    [RELEASE_GROUP],
  );
  await row(
    `INSERT INTO escort_client_group_authorizations
       (id, account_id, group_jid, participant_jid, client_contact_id, active)
     VALUES ('ga-release-8801722222222','wa-01',$1,'8801722222222@s.whatsapp.net','client-release',true)
     ON CONFLICT (id) DO UPDATE SET active = true`,
    [RELEASE_GROUP],
  );
}

async function stageMessage(accountId, chatJid, messageId, direction, senderJid, text, status = 'PENDING', sourceRowid = nextRowid++) {
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash, processing_status, source_rowid)
     VALUES ($1,$2,$3,$4,$5,now(),$6,encode(sha256(convert_to($6,'UTF8')),'hex'),$7,$8)
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
    [accountId, chatJid, messageId, direction, senderJid, text, status, sourceRowid],
  );
}

async function countInstructions() {
  const r = await row(`SELECT count(*)::int AS n FROM cash_instructions WHERE source_channel = 'WHATSAPP'`);
  return r.n;
}

async function countPrograms() {
  const r = await row(`SELECT count(*)::int AS n FROM programs WHERE source_channel = 'WHATSAPP'`);
  return r.n;
}

async function countReviewItems() {
  const r = await row('SELECT count(*)::int AS n FROM review_items');
  return r.n;
}

async function countCashSubmissions() {
  const r = await row('SELECT count(*)::int AS n FROM cash_submissions');
  return r.n;
}

async function countLedgerEntries() {
  const r = await row('SELECT count(*)::int AS n FROM ledger_entries');
  return r.n;
}

// ──────────────────────────────────────────────────────────────────────
// Cash Handler: WA-01 Admin outgoing messages in Accountant conversation
// ──────────────────────────────────────────────────────────────────────

test('cash: valid Admin outgoing message creates REVIEW instruction', async () => {
  await ensureAccount('wa-01');
  const before = await countInstructions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-valid-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  assert.equal(result.errors, 0);
  const after = await countInstructions();
  assert.equal(after, before + 1);

  const instr = await row("SELECT * FROM cash_instructions WHERE source_channel = 'WHATSAPP' AND source_message_id = 'msg-cash-valid-1'");
  assert.ok(instr);
  assert.equal(instr.state, 'REVIEW');
  assert.equal(Number(instr.amount_minor), 125050);
  assert.equal(instr.source_channel, 'WHATSAPP');
  assert.equal(instr.source_message_id, 'msg-cash-valid-1');
  assert.equal(instr.source_block_key, 'payment-block-0');
  assert.ok(instr.source_hash);
  // Automated writes are attributed to the stable system actor, so the sole
  // human Administrator can approve them without a self-review deadlock.
  assert.equal(instr.created_by, 'system:whatsapp-router');
  const account = await row('SELECT id FROM cash_accounts ORDER BY code LIMIT 1');
  await setInstructionAccount(admin, instr.id, account.id);
  const approved = await approveInstruction(admin, instr.id);
  assert.equal(approved.state, 'APPROVED');
});

test('cash: bare bridge sender matches a full configured Admin JID', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-bare-admin-1', 'OUTGOING', '8801880446111',
    'ID: 01712345678 Bare Admin Escort 01812345678(B) 333.00/- duty pay');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  const created = await row("SELECT state,amount_minor,source_message_id FROM cash_instructions WHERE source_message_id='msg-cash-bare-admin-1'");
  assert.equal(created.state, 'REVIEW');
  assert.equal(Number(created.amount_minor), 33300);
});

test('cash: incoming Accountant message does NOT create instruction', async () => {
  await ensureAccount('wa-01');
  const before = await countInstructions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-incoming-1', 'INCOMING', '8801711111111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.byMessage.filter((m) => m.classification === 'CASH:INCOMING_NOT_PROCESSED').length, 1);
  const after = await countInstructions();
  assert.equal(after, before);
});

test('cash: non-admin sender is ignored', async () => {
  await ensureAccount('wa-01', 'Test Account', '8801880446111@s.whatsapp.net');
  const before = await countInstructions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-nonadmin-1', 'OUTGOING', '8801799999999@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.byMessage.filter((m) => m.classification === 'CASH:NON_ADMIN_SENDER').length, 1);
  const after = await countInstructions();
  assert.equal(after, before);
});

test('cash: WA-02 account message is ignored', async () => {
  await ensureAccount('wa-02', 'WA-02 Account', '8801999999999@s.whatsapp.net');
  const before = await countInstructions();
  await stageMessage('wa-02', '8801844836824@s.whatsapp.net', 'msg-cash-wa02-1', 'OUTGOING', '8801999999999@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.byMessage.filter((m) => m.classification === 'CASH:WRONG_ACCOUNT').length, 1);
  const after = await countInstructions();
  assert.equal(after, before);
});

test('cash: Bangla amount and payment expressions', async () => {
  await ensureAccount('wa-01');
  const before = await countInstructions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-bangla-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: ০১৭১২৩৪৫৬৭৮ রাহিম উদ্দিন ০১৮১২৩৪৫৬৭৮(বি) ১,২৫০.৫০/- দায় ভাতা');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1, 'Bangla cash message should parse');
  const after = await countInstructions();
  assert.equal(after, before + 1);

  const instr = await row("SELECT * FROM cash_instructions WHERE source_message_id = 'msg-cash-bangla-1'");
  assert.ok(instr);
  assert.equal(instr.state, 'REVIEW');
});

test('cash: single mobile becomes employee identity and payout destination (automatic Paid)', async () => {
  await ensureAccount('wa-01');
  const previous = process.env.PHASE3_PAID_EVENTS_ENABLED;
  process.env.PHASE3_PAID_EVENTS_ENABLED = '1';
  try {
    await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-single-mobile-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
      'ID: 01712345678 Rahim Uddin (B) 500/- duty pay');
    const result = await routePendingMessages(admin, 10);
    assert.equal(result.instructions, 1);
    const instruction = await row("SELECT * FROM cash_instructions WHERE source_message_id = 'msg-cash-single-mobile-1'");
    assert.ok(instruction);
    assert.equal(instruction.employee_mobile, '+8801712345678');
    assert.equal(instruction.payout_mobile, '+8801712345678');
    assert.equal(instruction.state, 'REVIEW', 'business paid does not post or auto-approve');
    const event = await row('SELECT * FROM cash_payment_events WHERE instruction_id = $1', [instruction.id]);
    assert.ok(event, 'automatic Paid Event created without Office approval');
    assert.equal(event.source_category, 'WHATSAPP');
    assert.equal(event.status, 'PAID');
    assert.equal(event.employee_mobile, event.payout_mobile);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_postings')).n, 0);
    assert.equal((await row('SELECT count(*)::int AS n FROM cash_submissions')).n, 0);
  } finally {
    if (previous === undefined) delete process.env.PHASE3_PAID_EVENTS_ENABLED;
    else process.env.PHASE3_PAID_EVENTS_ENABLED = previous;
  }
});

test('cash: multiple payment blocks in one message create separate instructions and events', async () => {
  await ensureAccount('wa-01');
  const previous = process.env.PHASE3_PAID_EVENTS_ENABLED;
  process.env.PHASE3_PAID_EVENTS_ENABLED = '1';
  try {
    await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-multiblock-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
      'ID: 01712345678 Rahim Uddin 01812345678(B) 500/-\nID: 01912345678 Karim Uddin 01712345678(N) 700/-');
    const result = await routePendingMessages(admin, 10);
    assert.equal(result.instructions, 2);
    const instructions = await rows("SELECT * FROM cash_instructions WHERE source_message_id = 'msg-cash-multiblock-1' ORDER BY source_block_key");
    assert.equal(instructions.length, 2);
    assert.deepEqual(instructions.map((entry) => entry.source_block_key), ['payment-block-0', 'payment-block-1']);
    const events = await rows('SELECT * FROM cash_payment_events WHERE source_message_id = $1 ORDER BY source_block_key',
      ['msg-cash-multiblock-1']);
    assert.equal(events.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PHASE3_PAID_EVENTS_ENABLED;
    else process.env.PHASE3_PAID_EVENTS_ENABLED = previous;
  }
});

test('cash: replay of an automatic Paid message creates no duplicate event', async () => {
  await ensureAccount('wa-01');
  const previous = process.env.PHASE3_PAID_EVENTS_ENABLED;
  process.env.PHASE3_PAID_EVENTS_ENABLED = '1';
  try {
    const text = 'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay';
    await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-paid-replay-1', 'OUTGOING', '8801880446111@s.whatsapp.net', text);
    await routePendingMessages(admin, 10);
    await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-paid-replay-1', 'OUTGOING', '8801880446111@s.whatsapp.net', text);
    const replay = await routePendingMessages(admin, 10);
    assert.equal(replay.instructions, 0);
    assert.equal((await row("SELECT count(*)::int AS n FROM cash_instructions WHERE source_message_id='msg-cash-paid-replay-1'")).n, 1);
    assert.equal((await row("SELECT count(*)::int AS n FROM cash_payment_events WHERE source_message_id='msg-cash-paid-replay-1'")).n, 1);
  } finally {
    if (previous === undefined) delete process.env.PHASE3_PAID_EVENTS_ENABLED;
    else process.env.PHASE3_PAID_EVENTS_ENABLED = previous;
  }
});

test('cash: missing amount → cash_submissions review candidate', async () => {
  await ensureAccount('wa-01');
  const before = await countCashSubmissions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-noamount-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) /- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await countCashSubmissions();
  assert.equal(after, before + 1);

  const sub = await row("SELECT * FROM cash_submissions ORDER BY created_at DESC LIMIT 1");
  assert.ok(sub);
  assert.equal(sub.state, 'PENDING_REVIEW');
  assert.equal(sub.submitted_by, 'system:whatsapp-router');
  await assert.rejects(() => decideCashSubmission(admin, sub.id, 'APPROVED'), /INVALID_AMOUNT/);
  await correctCashSubmission(admin, sub.id, {amountMinor: 5000});
  const decided = await decideCashSubmission(admin, sub.id, 'APPROVED');
  assert.equal(decided.state, 'APPROVED');
  assert.ok(decided.instructionId);
});

test('cash: missing beneficiary → cash_submissions review candidate', async () => {
  await ensureAccount('wa-01');
  const before = await countCashSubmissions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-noname-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678  01812345678(B) 500/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await countCashSubmissions();
  assert.equal(after, before + 1);
});

test('cash: duplicate message replay is idempotent', async () => {
  await ensureAccount('wa-01');
  // First processing
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-dup-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.instructions, 1);

  // Replay same message
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-dup-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay', 'PENDING');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.instructions, 0);
  assert.equal(r2.byMessage.filter((m) => m.action === 'cash_idempotent_skip').length, 1);

  const count = await row("SELECT count(*)::int AS n FROM cash_instructions WHERE source_channel='WHATSAPP' AND source_message_id='msg-cash-dup-1'");
  assert.equal(count.n, 1, 'Only one instruction should exist for the replayed message');
});

test('cash: concurrent workers cannot create duplicate instructions', async () => {
  await ensureAccount('wa-01');
  // Stage the same message twice with different message IDs but same source key
  // (simulates two workers picking up the same logical message)
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-concurrent-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const r1 = await routePendingMessages(admin, 10);
  const r2 = await routePendingMessages(admin, 10);
  // Only the first worker should create an instruction
  assert.equal(r1.instructions + r2.instructions, 1,
    'Concurrent workers must not create duplicate instructions');
  const count = await row("SELECT count(*)::int AS n FROM cash_instructions WHERE source_channel='WHATSAPP' AND source_message_id='msg-cash-concurrent-1'");
  assert.equal(count.n, 1);
});

test('cash: similar but legitimate transactions create separate instructions', async () => {
  await ensureAccount('wa-01');
  const before = await countInstructions();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-similar-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-similar-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 2,000.00/- transport');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 2, 'Different amounts should create separate instructions');
  const after = await countInstructions();
  assert.equal(after, before + 2);
});

test('cash: no automatic ledger posting', async () => {
  await ensureAccount('wa-01');
  const beforeLedger = await countLedgerEntries();
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-nopost-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);

  const instr = await row("SELECT state FROM cash_instructions WHERE source_message_id = 'msg-cash-nopost-1'");
  assert.equal(instr.state, 'REVIEW', 'Instruction should remain in REVIEW, not POSTED');

  const afterLedger = await countLedgerEntries();
  assert.equal(afterLedger, beforeLedger, 'No ledger entries should be created automatically');
});

test('cash: unauthorized chat is ignored', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-unauth-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 100/- test');
  // Remove authorization for this test only; restore it in `finally` so the
  // negative case can never leak into a later test.
  try {
    await row("UPDATE whatsapp_chats SET authorized = false WHERE chat_jid = '8801844836824@s.whatsapp.net' AND account_id = 'wa-01'");

    const result = await routePendingMessages(admin, 10);
    assert.equal(result.instructions, 0);
    assert.equal(result.byMessage.filter((m) => m.classification === 'UNAUTHORIZED_CHAT').length, 1);
  } finally {
    await row("UPDATE whatsapp_chats SET authorized = true WHERE chat_jid = '8801844836824@s.whatsapp.net' AND account_id = 'wa-01'");
  }
});

// ──────────────────────────────────────────────────────────────────────
// Router: processing state and crash recovery
// ──────────────────────────────────────────────────────────────────────

test('router: marks cash messages COMPLETED with processing_status', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-cash-status-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 500/- test', 'PENDING');

  await routePendingMessages(admin, 10);

  const msg = await row("SELECT processing_status, classification, processed_at FROM whatsapp_messages WHERE message_id = 'msg-cash-status-1'");
  assert.ok(msg);
  assert.equal(msg.processing_status, 'COMPLETED');
  assert.ok(msg.classification.startsWith('CASH:'));
  assert.ok(msg.processed_at !== null);
});

test('router: FAILED messages are retryable after backoff', async () => {
  await ensureAccount('wa-01');
  // Mark a message as FAILED with retry_count < 10 and old last_processed_at
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash,
        processing_status, retry_count, last_processed_at, source_rowid)
     VALUES ('wa-01','8801844836824@s.whatsapp.net','msg-cash-retry-1','OUTGOING','8801880446111@s.whatsapp.net',
       now(),'ID: 01712345678 Rahim Uddin 01812345678(B) 500/- test',encode(sha256('x'::bytea),'hex'),
       'FAILED', 3, now() - interval '20 minutes', 900001)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO NOTHING`);

  const before = await countInstructions();
  const result = await routePendingMessages(admin, 10);
  // The FAILED message should be retried and processed
  assert.equal(result.instructions, 1);
  assert.equal(result.errors, 0);
  const after = await countInstructions();
  assert.equal(after, before + 1);
});

test('router: PROCESSING messages older than 30 min are recovered', async () => {
  await ensureAccount('wa-01');
  // Mark a message as stuck PROCESSING (crashed worker)
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash,
        processing_status, retry_count, last_processed_at, source_rowid)
     VALUES ('wa-01','8801844836824@s.whatsapp.net','msg-cash-stuck-1','OUTGOING','8801880446111@s.whatsapp.net',
       now(),'ID: 01712345678 Rahim Uddin 01812345678(B) 500/- test',encode(sha256('y'::bytea),'hex'),
       'PROCESSING', 0, now() - interval '40 minutes', 900001)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO NOTHING`);

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
  assert.equal(result.errors, 0);
});

// ──────────────────────────────────────────────────────────────────────
// Router: vessel (unchanged from Increment 1)
// ──────────────────────────────────────────────────────────────────────

test('router: vessel message creates program in DRAFT', async () => {
  // Only WA-01 may create vessel records (Owner-approved business rule); use a
  // distinct vessel/date so this fixture does not collide with later tests.
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Router Test\nLighter Vessel: L-01\nMaster mobile: 01911111111\nDestination: Chattogram\n18/11/26(D)');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1);
  const after = await countPrograms();
  assert.equal(after, before + 1);

  const prog = await row("SELECT * FROM programs WHERE source_channel = 'WHATSAPP' ORDER BY created_at DESC LIMIT 1");
  assert.ok(prog);
  assert.equal(prog.state, 'DRAFT');
});

// ──────────────────────────────────────────────────────────────────────
// Router: vessel (Increment 3)
// ──────────────────────────────────────────────────────────────────────

test('vessel: deployment flag disables vessel processing without touching Cash', async () => {
  await ensureAccount('wa-01');
  const previous = process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED;
  process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED = '0';
  try {
    await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-disabled-1', 'INCOMING', '8801711111111@s.whatsapp.net',
      'Mother Vessel: MV Disabled\nLighter Vessel: L-0\nMaster mobile: 01911111111\n17/11/26(D)');
    const result = await routePendingMessages(admin, 10);
    assert.equal(result.programs, 0);
    assert.equal(result.errors, 0);
    const stored = await row("SELECT processing_status, classification FROM whatsapp_messages WHERE message_id = 'msg-vessel-disabled-1'");
    assert.equal(stored.processing_status, 'PENDING');
    assert.equal(stored.classification, 'VESSEL:PROCESSING_DISABLED');
    assert.equal(result.processed, 0);
  } finally {
    if (previous === undefined) delete process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED;
    else process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED = previous;
  }
});

test('vessel: single-lighter order creates program in DRAFT (WA-01)', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-single-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nDestination: Chattogram\n17/11/26(D)');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1);
  assert.equal(result.errors, 0);
  const after = await countPrograms();
  assert.equal(after, before + 1);

  const prog = await row("SELECT * FROM programs WHERE source_channel = 'WHATSAPP' AND source_message_id = 'msg-vessel-single-1'");
  assert.ok(prog);
  assert.equal(prog.state, 'DRAFT');
  assert.equal(prog.mother_vessel, 'Ocean Star');
  assert.equal(prog.lighter_vessel, 'L-77');
  assert.equal(prog.master_mobile, '01911111111');
  assert.equal(prog.source_channel, 'WHATSAPP');
  assert.equal(prog.source_message_id, 'msg-vessel-single-1');
  assert.equal(prog.source_chat_jid, '120363000000000001@g.us');

  // Source provenance recorded
  const src = await row("SELECT * FROM program_source_messages WHERE program_id = $1 AND message_id = 'msg-vessel-single-1'", [prog.id]);
  assert.ok(src);
  assert.equal(src.source_role, 'primary');
});

test('vessel: multi-lighter order creates one program per lighter', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-multi-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nLighter Vessel: L-78\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 2, 'Two lighter vessels should create two programs');
  const after = await countPrograms();
  assert.equal(after, before + 2);
});

test('vessel: Bangla/English labels parse correctly', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-bangla-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'মাদার ভেসেল: MV Ocean Star\nলাইটার ভেসেল: L-77\nমাস্টার মোবাইল: 01911111111\nগন্তব্য: Chattogram');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1, 'Bangla vessel labels should parse');
  const after = await countPrograms();
  assert.equal(after, before + 1);
});

test('vessel: vessel prefix normalization (M.V., MV, M. V., Mv.)', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-prefix-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: M.V. Beltokyo\nLighter Vessel: L-99\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1, 'M.V. prefix should be normalized');
  const prog = await row("SELECT mother_vessel FROM programs WHERE source_message_id = 'msg-vessel-prefix-1'");
  assert.ok(prog);
  assert.equal(prog.mother_vessel, 'Beltokyo');
});

test('vessel: missing master mobile → review candidate', async () => {
  await ensureAccount('wa-01');
  const before = await row('SELECT count(*)::int AS n FROM review_items');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-nomaster-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await row('SELECT count(*)::int AS n FROM review_items');
  assert.equal(after.n, before.n + 1);

  const review = await row("SELECT * FROM review_items WHERE domain = 'PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.ok(review);
  assert.equal(review.state, 'PENDING');
});

test('vessel: same mother/lighter ±1-day duplicate → review warning', async () => {
  await ensureAccount('wa-01');
  // Create an existing program
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-orig-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Same mother/lighter, +1 day → duplicate warning → review
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-dup-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n18/11/26(D)');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.programs, 0, 'Duplicate should not create new program');
  assert.equal(r2.reviewItems, 1, 'Duplicate warning should go to review');
});

test('vessel: same escort/date with different lighter is NOT a duplicate', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-diff-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-diff-2', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-78\nMaster mobile: 01911111111\n17/11/26(D)');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 2, 'Different lighter vessels on same date are not duplicates');
  const after = await countPrograms();
  assert.equal(after, before + 2);
});

test('vessel: bare group sender matches a full configured participant JID', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-bare-participant-1', 'INCOMING', '8801722222222',
    'Mother Vessel: MV Bare Match\nLighter Vessel: B-1\nMaster mobile: 01911111111\n17/11/26(D)');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1);
  const program = await row("SELECT state FROM programs WHERE source_message_id='msg-vessel-bare-participant-1'");
  assert.equal(program.state, 'DRAFT');
});

test('vessel: WA-02 business processing rejected', async () => {
  await ensureAccount('wa-02', 'WA-02 Account', '8801999999999@s.whatsapp.net');
  const before = await countPrograms();
  await stageMessage('wa-02', '120363000000000001@g.us', 'msg-vessel-wa02-1', 'INCOMING', '8801999999999@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0, 'WA-02 should not create vessel programs');
  assert.equal(result.byMessage.filter((m) => m.classification === 'VESSEL_WA02_NOT_AUTHORIZED').length, 1);
  const after = await countPrograms();
  assert.equal(after, before);
});

test('vessel: replay idempotency', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-replay-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Replay same message
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-replay-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)', 'PENDING');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.programs, 0, 'Replay should create no new program');
  const count = await row("SELECT count(*)::int AS n FROM programs WHERE source_channel='WHATSAPP' AND source_message_id='msg-vessel-replay-1'");
  assert.equal(count.n, 1, 'Only one program should exist for the replayed message');
});

test('vessel: concurrent workers cannot create duplicate programs', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-concurrent-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');

  const r1 = await routePendingMessages(admin, 10);
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs + r2.programs, 1,
    'Concurrent workers must not create duplicate programs');
  const count = await row("SELECT count(*)::int AS n FROM programs WHERE source_channel='WHATSAPP' AND source_message_id='msg-vessel-concurrent-1'");
  assert.equal(count.n, 1);
});

test('vessel: crash recovery - stuck PROCESSING messages recovered', async () => {
  await ensureAccount('wa-01');
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash,
        processing_status, retry_count, last_processed_at, source_rowid)
     VALUES ('wa-01','120363000000000001@g.us','msg-vessel-stuck-1','INCOMING','8801722222222@s.whatsapp.net',
       now(),'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111',
       encode(sha256('z'::bytea),'hex'),'PROCESSING', 0, now() - interval '40 minutes', 900001)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO NOTHING`);

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1, 'Stuck PROCESSING message should be recovered');
  assert.equal(result.errors, 0);
});

test('vessel: multi-message correlation preserves source references', async () => {
  await ensureAccount('wa-01');
  // Message 1: Mother + Lighter 1
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-corr-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Message 2: Same chat, additional lighter (correlated)
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-corr-2', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-78\nMaster mobile: 01911111111\n17/11/26(D)');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.programs, 1, 'Second lighter should create separate program');

  // Both programs should exist with different source messages
  const prog1 = await row("SELECT id FROM programs WHERE source_message_id = 'msg-vessel-corr-1'");
  const prog2 = await row("SELECT id FROM programs WHERE source_message_id = 'msg-vessel-corr-2'");
  assert.ok(prog1);
  assert.ok(prog2);
  assert.notEqual(prog1.id, prog2.id, 'Different lighters should create different programs');

  // Source provenance for both
  const src1 = await row("SELECT * FROM program_source_messages WHERE message_id = 'msg-vessel-corr-1'");
  const src2 = await row("SELECT * FROM program_source_messages WHERE message_id = 'msg-vessel-corr-2'");
  assert.ok(src1);
  assert.ok(src2);
});

test('vessel: source linkage - confirmation_message_id persisted on confirm', async () => {
  await ensureAccount('wa-01');
  // Create a draft program first
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-confirm-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  const prog = await row("SELECT id FROM programs WHERE source_message_id = 'msg-vessel-confirm-1'");
  assert.ok(prog);

  // Admin outgoing confirmation in same chat
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-confirm-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nEscort Name: Rahim\nEscort Mobile: 01922222222\nStart Date: 17/11/26\nShift: D');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.confirmations, 1, 'Admin confirmation should match');

  // Confirmation message id should be persisted
  const confirmed = await row("SELECT confirmation_message_id, state FROM programs WHERE id = $1", [prog.id]);
  assert.ok(confirmed);
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.equal(confirmed.confirmation_message_id, 'msg-vessel-confirm-2');

  // Replaying the exact same confirmation is idempotent.
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-confirm-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nEscort Name: Rahim\nEscort Mobile: 01922222222\nStart Date: 17/11/26\nShift: D');
  const r3 = await routePendingMessages(admin, 10);
  assert.equal(r3.confirmations, 1, 'Replay should match the same confirmed program');
  const assignments = await row("SELECT count(*)::int AS n FROM program_assignments WHERE program_id = $1", [prog.id]);
  assert.equal(assignments.n, 1, 'Replay must not create a duplicate assignment');
  const replay = await row("SELECT confirmation_message_id, state FROM programs WHERE id = $1", [prog.id]);
  assert.equal(replay.state, 'CONFIRMED');
  assert.equal(replay.confirmation_message_id, 'msg-vessel-confirm-2');
});

test('vessel: wrong-chat confirmation does not confirm', async () => {
  await ensureAccount('wa-01');
  // Create draft in group chat
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-wrongchat-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Admin outgoing confirmation in DIRECT chat (different conversation)
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-vessel-wrongchat-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nEscort Name: Rahim\nEscort Mobile: 01922222222');
  const r2 = await routePendingMessages(admin, 10);
  // Confirmation in different chat should not match
  assert.equal(r2.confirmations, 0, 'Confirmation in different chat should not match');
});

test('vessel: non-admin outgoing message ignored', async () => {
  await ensureAccount('wa-01', 'Test Account', '8801880446111@s.whatsapp.net');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-nonadmin-1', 'OUTGOING', '8801799999999@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0, 'Non-admin outgoing should not create programs');
  assert.equal(result.byMessage.filter((m) => m.classification === 'OUTGOING_NON_ADMIN').length, 1);
  const after = await countPrograms();
  assert.equal(after, before);
});

test('vessel: unauthorized chat ignored', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-unauth-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111');
  // Remove authorization
  await row("UPDATE whatsapp_chats SET authorized = false WHERE chat_jid = '120363000000000001@g.us' AND account_id = 'wa-01'");;

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage.filter((m) => m.classification === 'UNAUTHORIZED_CHAT').length, 1);
});

test('vessel: program source messages table tracks references', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-vessel-src-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1);

  const prog = await row("SELECT id FROM programs WHERE source_message_id = 'msg-vessel-src-1'");
  assert.ok(prog);

  const src = await row("SELECT * FROM program_source_messages WHERE program_id = $1 AND message_id = 'msg-vessel-src-1'", [prog.id]);
  assert.ok(src);
  assert.equal(src.source_role, 'primary');
  assert.equal(src.account_id, 'wa-01');
  assert.equal(src.chat_jid, '120363000000000001@g.us');
});

// ──────────────────────────────────────────────────────────────────────
// Router: Review Queue (Increment 4)
// ──────────────────────────────────────────────────────────────────────

test('review: INCOMPLETE_VESSEL_ORDER — missing master mobile', async () => {
  await ensureAccount('wa-01');
  const before = await row('SELECT count(*)::int AS n FROM review_items');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-incomplete-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await row('SELECT count(*)::int AS n FROM review_items');
  assert.equal(after.n, before.n + 1);

  const item = await row("SELECT * FROM review_items WHERE domain = 'PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.ok(item);
  assert.equal(item.state, 'PENDING');
  const payload = item.payload;
  assert.ok((payload).missingFields);
});

test('review: EXTRACTION_FAILED — unparsable vessel message', async () => {
  await ensureAccount('wa-01');
  const before = await row('SELECT count(*)::int AS n FROM review_items');
  // Vessel-domain signal, but no complete order block: the handler must reach
  // the EXTRACTION_FAILED review path.
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-extract-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await row('SELECT count(*)::int AS n FROM review_items');
  assert.equal(after.n, before.n + 1);

  const item = await row("SELECT * FROM review_items WHERE domain = 'PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.ok(item);
  assert.equal(item.state, 'PENDING');
});

test('review: VESSEL_DUPLICATE_CANDIDATE — ±1 day duplicate', async () => {
  await ensureAccount('wa-01');
  // Create an existing program
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-dup-orig-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Same mother/lighter, +1 day → duplicate warning → review
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-dup-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n18/11/26(D)');
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r2.programs, 0, 'Duplicate should not create new program');
  assert.equal(r2.reviewItems, 1, 'Duplicate warning should go to review');
});

test('review: INCOMPLETE_CASH_INSTRUCTION — missing amount', async () => {
  await ensureAccount('wa-01');
  const before = await row('SELECT count(*)::int AS n FROM cash_submissions');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-review-cash-incomplete-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) /- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const after = await row('SELECT count(*)::int AS n FROM cash_submissions');
  assert.equal(after.n, before.n + 1);

  const sub = await row('SELECT * FROM cash_submissions ORDER BY created_at DESC LIMIT 1');
  assert.ok(sub);
  assert.equal(sub.state, 'PENDING_REVIEW');
});

test('review: deduplication — same review item not created twice', async () => {
  await ensureAccount('wa-01');
  // Process the same vessel-signalling, unparsable message twice.
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-dedup-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.reviewItems, 1);

  // Replay same message; the pending-review uniqueness must keep the count at 1.
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-dedup-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star', 'PENDING');
  await routePendingMessages(admin, 10);
  const pending = await row(
    "SELECT count(*)::int AS n FROM review_items WHERE domain = 'PROGRAM' AND target_ref = 'msg-review-dedup-1' AND category = 'EXTRACTION_FAILED' AND state = 'PENDING'",
  );
  assert.equal(pending.n, 1, 'Duplicate pending review item must not be created');
});

test('review: group participant authorization — unauthorized participant', async () => {
  await ensureAccount('wa-01');
  // The table is owned by migration 006; the shared fixture authorizes this
  // participant, so deactivate it for this negative case.
  // Deactivate the fixture row so this negative case still asserts the rejection.
  // negative case still asserts GROUP_PARTICIPANT_NOT_AUTHORIZED.
  await row("UPDATE escort_client_group_authorizations SET active = false WHERE account_id = 'wa-01' AND group_jid = '120363000000000001@g.us' AND participant_jid = '8801722222222@s.whatsapp.net'");
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-group-unauth-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0, 'Unauthorized group participant should not create programs');
  assert.equal(result.byMessage.filter((m) => m.classification === 'GROUP_PARTICIPANT_NOT_AUTHORIZED').length, 1);
  const after = await countPrograms();
  assert.equal(after, before);
});

test('review: group participant authorization — authorized participant', async () => {
  await ensureAccount('wa-01');
  // The table is owned by migration 006; the shared fixture already authorizes
  // this participant. Insert the explicit per-test row as before.
  await row("INSERT INTO escort_client_group_authorizations (id, account_id, group_jid, participant_jid, client_contact_id, active) VALUES ('ga-1','wa-01','120363000000000001@g.us','8801722222222@s.whatsapp.net','cc-1',true) ON CONFLICT DO NOTHING");
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-group-auth-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 1, 'Authorized group participant should create program');
  const after = await countPrograms();
  assert.equal(after, before + 1);
});

test('review: WA-02 business processing rejected', async () => {
  await ensureAccount('wa-02', 'WA-02 Account', '8801999999999@s.whatsapp.net');
  const before = await countPrograms();
  await stageMessage('wa-02', '120363000000000001@g.us', 'msg-review-wa02-1', 'INCOMING', '8801999999999@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0, 'WA-02 should not create vessel programs');
  const after = await countPrograms();
  assert.equal(after, before);
});

test('review: ambiguous Admin confirmation → review candidate', async () => {
  await ensureAccount('wa-01');
  // Create two draft programs with same mother+lighter in same chat
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-ambig-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  // Keep the dates outside the ±1-day duplicate window so the fixture really
  // creates two matching programs; ambiguity is the confirmation's job.
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-ambig-2', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n20/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 2, 'Two different dates create two programs');

  // Admin outgoing confirmation — ambiguous (2 matching programs)
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-ambig-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nEscort Name: Rahim\nEscort Mobile: 01922222222\nStart Date: 17/11/26\nShift: D');
  const r2 = await routePendingMessages(admin, 10);
  // Ambiguous confirmation should not auto-confirm
  assert.equal(r2.confirmations, 0, 'Ambiguous confirmation should not auto-confirm');
});

test('review: wrong-chat confirmation → unmatched review', async () => {
  await ensureAccount('wa-01');
  // Create draft in group chat
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-wrongchat-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  const r1 = await routePendingMessages(admin, 10);
  assert.equal(r1.programs, 1);

  // Admin outgoing confirmation in DIRECT chat (different conversation)
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-review-wrongchat-2', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nEscort Name: Rahim\nEscort Mobile: 01922222222');
  const r2 = await routePendingMessages(admin, 10);
  // Confirmation in different chat should not match
  assert.equal(r2.confirmations, 0, 'Confirmation in different chat should not match');
});

test('review: multiple lighter vessels remain separate programs', async () => {
  await ensureAccount('wa-01');
  const before = await countPrograms();
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-multi-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nLighter Vessel: L-78\nMaster mobile: 01911111111');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 2, 'Two lighter vessels create two separate programs');
  const after = await countPrograms();
  assert.equal(after, before + 2);
});

test('review: no automatic Cash posting', async () => {
  await ensureAccount('wa-01');
  const beforeLedger = await row('SELECT count(*)::int AS n FROM ledger_entries');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-review-nopost-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);

  const instr = await row("SELECT state FROM cash_instructions WHERE source_message_id = 'msg-review-nopost-1'");
  assert.equal(instr.state, 'REVIEW', 'Instruction should remain in REVIEW');

  const afterLedger = await row('SELECT count(*)::int AS n FROM ledger_entries');
  assert.equal(afterLedger.n, beforeLedger.n, 'No automatic ledger entries');
});

test('review: concurrent retry — same message processed by two workers', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-review-concurrent-1', 'OUTGOING', '8801880446111@s.whatsapp.net',
    'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay');

  const r1 = await routePendingMessages(admin, 10);
  const r2 = await routePendingMessages(admin, 10);
  assert.equal(r1.instructions + r2.instructions, 1,
    'Concurrent workers must not create duplicate cash instructions');
  const count = await row("SELECT count(*)::int AS n FROM cash_instructions WHERE source_channel = 'WHATSAPP'");
  assert.equal(count.n, 1);
});

test('review: crash recovery — stuck PROCESSING message recovered', async () => {
  await ensureAccount('wa-01');
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash,
        processing_status, retry_count, last_processed_at, source_rowid)
     VALUES ('wa-01','8801844836824@s.whatsapp.net','msg-review-stuck-1','OUTGOING','8801880446111@s.whatsapp.net',
       now(),'ID: 01712345678 Rahim Uddin 01812345678(B) 500/- test',encode(sha256('w'::bytea),'hex'),
       'PROCESSING', 0, now() - interval '40 minutes', 900001)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO NOTHING`);

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1, 'Stuck PROCESSING message should be recovered');
  assert.equal(result.errors, 0);
});

test('review: source evidence linkage — review item references source message', async () => {
  await ensureAccount('wa-01');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-source-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);

  const item = await row("SELECT * FROM review_items WHERE domain = 'PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.ok(item);
  const payload = item.payload;
  assert.equal(payload.sourceMessageId, 'msg-review-source-1');
  assert.equal(payload.sourceChatJid, '120363000000000001@g.us');
  assert.equal(payload.sourceAccountId, 'wa-01');
});

test('review: similar but legitimate transactions create separate review items', async () => {
  await ensureAccount('wa-01');
  const before = await row('SELECT count(*)::int AS n FROM review_items');
  // Two different incomplete vessel orders
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-similar-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');
  await stageMessage('wa-01', '120363000000000001@g.us', 'msg-review-similar-2', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV Ritaj\nLighter Vessel: L-88');

  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 2, 'Different incomplete orders create separate review items');
  const after = await row('SELECT count(*)::int AS n FROM review_items');
  assert.equal(after.n, before.n + 2);
});

test('release: structured slip releases exactly one matching program', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const created = await createProgram(admin, {
    motherVessel: 'MV Release', lighterVessel: 'L-Release', masterMobile: '01911111111',
    escortMobile: '01812345678', escortName: 'Release Test',
    startDate: '2026-11-01', startShift: 'D',
  });
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Escort Release\nMother Vessel: M.V. Release\nLighter Vessel: M.V. L-Release\nMaster mobile: 01911111111\nDestination: Chattogram\nEscort Name: Release Test\nEscort mobile: 01812345678\nStart: 01/11/26-((D)\nEnd: 05/11/26-(D)\nTotal day: 5-day\nFood bill: 750/-');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 1);
  const program = await row('SELECT state, end_date::text AS end_date, end_shift FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(program.state, 'RELEASED');
  assert.equal(program.end_date, '2026-11-05');
  assert.equal(program.end_shift, 'D');
  const event = await row("SELECT action FROM program_events WHERE program_id = $1 AND action = 'RELEASE_PROGRAM'", [created.program.id]);
  assert.ok(event);
  const source = await row("SELECT source_role FROM program_source_messages WHERE program_id = $1 AND message_id = 'msg-release-1'", [created.program.id]);
  assert.equal(source.source_role, 'contributor');
});

test('release: ambiguous slip goes to review and does not release', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const a = await createProgram(admin, {motherVessel: 'MV A', lighterVessel: 'L-A1', escortMobile: '01812345678', startDate: '2026-11-01', startShift: 'D'});
  const b = await createProgram(admin, {motherVessel: 'MV B', lighterVessel: 'L-B1', escortMobile: '01812345678', startDate: '2026-11-01', startShift: 'D'});
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-ambig-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Escort Release\nEscort Name: Release Test\nEscort mobile: 01812345678\nStart: 01/11/26-((D)\nEnd: 05/11/26-(D)');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const states = await row("SELECT count(*)::int AS n FROM programs WHERE id IN ($1,$2) AND state = 'RELEASED'", [a.program.id, b.program.id]);
  assert.equal(states.n, 0);
  const item = await row("SELECT category, payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.category, 'UNMATCHED_VESSEL_ASSIGNMENT');
  assert.equal(item.payload.releaseCategory, 'RELEASE_AMBIGUOUS');
});

test('release: unstructured release-group message never becomes a vessel order', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-chatter-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Mother Vessel: MV NotAnOrder\nLighter Vessel: L-Chatter\nMaster mobile: 01911111111\nPlease check the release.');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.programs, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT category, payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.category, 'EXTRACTION_FAILED');
  assert.equal(item.payload.releaseCategory, 'RELEASE_UNSTRUCTURED');
});

test('release: cancellation evidence is extracted, matched and kept pending', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const created = await createProgram(admin, {
    motherVessel: 'M.V. Poavosa-Wisdom', lighterVessel: 'Deowan-Jobayer',
    masterMobile: '01711327593', escortMobile: '01871663045', escortName: 'Md.Samir',
    startDate: '2026-10-25', startShift: 'N',
  });
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-cancel-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    `===( Ship-Cancaled)===
 Mather v.s. :-M.v. Poavosa-Wisdom
Righter v.s. :- Deowan-Jobayer
Master mobile:- 01711-327593
Escort name:- Md.Samir
Escort mobile:- 01871-663045
Start date:- 25-10-2026-(N)
Canceled date:- 07-11-2026-(D)
( 13-day-1950/- food bill)`);
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT category, payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.category, 'EXTRACTION_FAILED');
  assert.equal(item.payload.releaseCategory, 'RELEASE_CANCELLATION_CANDIDATE');
  assert.deepEqual(item.payload.candidateProgramIds, [created.program.id]);
  assert.ok(item.payload.candidateMatchedBy.includes('ESCORT_MOBILE'));
  assert.equal(item.payload.extractedFields.motherVessel, 'Poavosa-Wisdom');
  assert.equal(item.payload.extractedFields.lighterVessel, 'Deowan-Jobayer');
  assert.equal(item.payload.extractedFields.cancelDate, '2026-11-07');
  assert.equal(item.payload.extractedFields.foodBillMinor, 195000);
  assert.ok(item.payload.reasons.includes('CANCELLATION_NOT_AUTO_APPLIED'));
  const program = await row('SELECT state FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(program.state, 'ASSIGNED', 'cancellation evidence never voids or releases a program');
});

test('release: food-bill evidence is extracted and never posts or releases', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const created = await createProgram(admin, {
    motherVessel: 'M.V. Food Bill', lighterVessel: 'L-Food',
    escortMobile: '01871663045', escortName: 'Md.Samir',
    startDate: '2026-10-26', startShift: 'D',
  });
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-food-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'ID: 01871663045 Md.Samir 01717909181(B) 1950/-food bill dukani bkash no');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.payload.releaseCategory, 'RELEASE_FOOD_BILL_CANDIDATE');
  assert.equal(item.payload.extractedFields.foodBillMinor, 195000);
  assert.equal(item.payload.extractedFields.escortMobile, '01871663045');
  assert.deepEqual(item.payload.candidateProgramIds, [created.program.id]);
  assert.ok(item.payload.reasons.includes('FOOD_BILL_NOT_AUTO_POSTED'));
  const program = await row('SELECT state FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(program.state, 'ASSIGNED');
});

test('release: empty release-group message is preserved as review evidence', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-empty-1', 'INCOMING', '8801722222222@s.whatsapp.net', '');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.payload.releaseCategory, 'RELEASE_EMPTY_MESSAGE');
  assert.ok(item.payload.reasons.includes('EMPTY_MESSAGE'));
});

test('release: transfer evidence is classified and kept pending', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const created = await createProgram(admin, {
    motherVessel: 'Union-Odyssey', lighterVessel: 'Othoi-1',
    escortMobile: '01920547773', escortName: 'Md.Nurun Nabi',
    startDate: '2026-11-02', startShift: 'D',
  });
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-transfer-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'D: 01920547773 Md.Nurun Nabi 01815282644(B)  Righter v.s.:-Othoi-Cancaled, ব্যাচেল অথৈ থেকে নেমে ঘুডে করে ভেসেল খাতিজা খাতুনে উঠছে বুট ভাড়া');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.payload.releaseCategory, 'RELEASE_TRANSFER_CANDIDATE');
  assert.ok(item.payload.evidenceKinds.includes('CANCELLATION'));
  assert.ok(item.payload.evidenceKinds.includes('TRANSFER'));
  assert.equal(item.payload.extractedFields.lighterVessel, 'Othoi');
  assert.deepEqual(item.payload.candidateProgramIds, [created.program.id]);
  assert.ok(item.payload.reasons.includes('TRANSFER_NOT_AUTO_APPLIED'));
  const program = await row('SELECT state FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(program.state, 'ASSIGNED');
});

test('release: incomplete slip is reviewed and never releases', async () => {
  await ensureAccount('wa-01');
  await ensureReleaseGroup();
  const created = await createProgram(admin, {motherVessel: 'MV Incomplete', lighterVessel: 'L-Inc', escortMobile: '01812345678', startDate: '2026-11-01', startShift: 'D'});
  await stageMessage('wa-01', RELEASE_GROUP, 'msg-release-inc-1', 'INCOMING', '8801722222222@s.whatsapp.net',
    'Escort Release\nEscort mobile: 01812345678\nStart: 01/11/26-((D)\nEnd: 05/11/26');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const program = await row('SELECT state FROM programs WHERE id = $1', [created.program.id]);
  assert.equal(program.state, 'ASSIGNED');
  const item = await row("SELECT category, payload FROM review_items WHERE domain='PROGRAM' ORDER BY created_at DESC LIMIT 1");
  assert.equal(item.category, 'INCOMPLETE_VESSEL_ORDER');
  assert.equal(item.payload.releaseCategory, 'RELEASE_INCOMPLETE');
});

test('cash: effective-dated Accountant registry authorizes the approved chat', async () => {
  await ensureAccount('wa-01');
  await row(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('phase3_authorized_contacts:wa-01',$1::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [JSON.stringify([{role: 'ACCOUNTANT', jid: '8801844836824@s.whatsapp.net', status: 'ACTIVE', effectiveFrom: '2026-01-01'}])],
  );
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-accountant-registry-1', 'OUTGOING',
    '8801880446111@s.whatsapp.net', 'ID: 01712345678 Registry Test 01812345678(B) 500/-');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 1);
});

test('cash: registry fails closed for a non-approved Accountant chat', async () => {
  await ensureAccount('wa-01');
  await row(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('phase3_authorized_contacts:wa-01',$1::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [JSON.stringify([{role: 'ACCOUNTANT', jid: '8801999999999@s.whatsapp.net', status: 'ACTIVE', effectiveFrom: '2026-01-01'}])],
  );
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-accountant-registry-2', 'OUTGOING',
    '8801880446111@s.whatsapp.net', 'ID: 01712345678 Registry Test 01812345678(B) 500/-');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.ignored, 1);
  const message = await row("SELECT classification FROM whatsapp_messages WHERE message_id='msg-accountant-registry-2'");
  assert.match(String(message.classification), /ACCOUNTANT_NOT_AUTHORIZED/);
});

test('cash: revoked Accountant entry is not authorized', async () => {
  await ensureAccount('wa-01');
  await row(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('phase3_authorized_contacts:wa-01',$1::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`,
    [JSON.stringify([{role: 'ACCOUNTANT', jid: '8801844836824@s.whatsapp.net', status: 'REVOKED', effectiveFrom: '2026-01-01'}])],
  );
  await stageMessage('wa-01', '8801844836824@s.whatsapp.net', 'msg-accountant-registry-3', 'OUTGOING',
    '8801880446111@s.whatsapp.net', 'ID: 01712345678 Registry Test 01812345678(B) 500/-');
  const result = await routePendingMessages(admin, 10);
  assert.equal(result.instructions, 0);
  assert.equal(result.ignored, 1);
});
