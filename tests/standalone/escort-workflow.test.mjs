// AL-RIFA'I — End-to-end Escort order → Admin confirmation → Vessel Register →
// Escort Release workflow tests. Disposable PostgreSQL database only.
//
// Every identity/chat value in this file is a synthetic test fixture. Nothing
// here contains a production mobile number or chat identifier.
import assert from 'node:assert/strict';
import test, {beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {row, rows} from '../../lib/standalone/db.ts';
import {routePendingMessages} from '../../lib/message-router.ts';
import {countPrograms, createProgram, getProgram, listPrograms, updateProgram} from '../../lib/standalone/programs.ts';
import {getMessageEvidence} from '../../lib/standalone/messages.ts';

process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED = '1';

const admin = {id: 'a'.repeat(64), role: 'ADMIN'};
const ADMIN_JID = '8801880000000@s.whatsapp.net';

// Synthetic fixture identities.
const CLIENT_PN_CHAT = '8801700000011@s.whatsapp.net';
const CLIENT_PN = '8801700000011';
const CLIENT_LID_CHAT = '900000000000011@lid';
const CLIENT_LID = '900000000000011';
const CLIENT_LID_PN = '8801700000012@s.whatsapp.net';
const UNVERIFIED_CHAT = '8801700000013@s.whatsapp.net';
const CASH_CHAT = '8801700000014@s.whatsapp.net';
const SUPPORT_GROUP = '120363000000000011@g.us';
const RELEASE_GROUP = '120363000000000012@g.us';
const OTHER_GROUP = '120363000000000013@g.us';
const UNKNOWN_GROUP = '120363000000000014@g.us';
const ALL_CHATS = [
  CLIENT_PN_CHAT, CLIENT_LID_CHAT, UNVERIFIED_CHAT, CASH_CHAT,
  SUPPORT_GROUP, RELEASE_GROUP, OTHER_GROUP, UNKNOWN_GROUP,
];

let nextRowid = 1;

async function reset() {
  nextRowid = 1;
  const owner = createPool({role: 'app', readOnly: false, applicationName: 'escort-workflow-reset'});
  try {
    await owner.query(`TRUNCATE TABLE
      audit_events, cash_transaction_adjustments, cash_payment_event_postings, cash_payment_events, cash_reversals,
      cash_reconciliations, cash_instructions, cash_postings, ledger_entries,
      cash_submission_reviews, cash_submissions, attendance, review_decisions, review_items,
      identity_aliases, program_pay, program_source_messages,
      program_assignments, program_events, programs, employees,
      vessel_draft_deliveries, whatsapp_message_intelligence, whatsapp_calls,
      whatsapp_media, whatsapp_messages, whatsapp_chats, whatsapp_sync_state,
      whatsapp_accounts, escort_client_group_authorizations, app_settings
      RESTART IDENTITY`);
  } finally {
    await owner.end();
  }
}

beforeEach(async () => {
  await reset();
  await row(
    `INSERT INTO whatsapp_accounts (id, label, enabled, transport, socket_path, account_jid, admin_jids)
     VALUES ('wa-01','WA-01',true,'SQLITE_STORE','/tmp/escort-wa01.db',$1,$2::jsonb),
            ('wa-02','WA-02',true,'SQLITE_STORE','/tmp/escort-wa02.db',$3,$4::jsonb)`,
    [ADMIN_JID, JSON.stringify([ADMIN_JID]), '8801950000000@s.whatsapp.net', JSON.stringify([ADMIN_JID])],
  );
  const chats = [
    [CLIENT_PN_CHAT, 'Verified Client A', 'ORDERS', 'ORDER_INTAKE'],
    [CLIENT_LID_CHAT, 'Verified Client B (LID)', 'ORDERS', 'ORDER_INTAKE'],
    [UNVERIFIED_CHAT, 'Unverified direct chat', 'ORDERS', 'ORDER_INTAKE'],
    [CASH_CHAT, 'Accountant', 'CASH', 'CASH_ONLY'],
    [SUPPORT_GROUP, 'Escort Support Group', 'ORDERS', 'SUPPORT_ONLY'],
    [RELEASE_GROUP, 'Escort Release Slip', 'ORDERS', 'RELEASE_ONLY'],
    [OTHER_GROUP, 'Al-Aqsa Escort Program Group', 'ORDERS', 'OTHER_APPROVED'],
    [UNKNOWN_GROUP, 'Unclassified group', 'ORDERS', 'REVIEW_REQUIRED'],
  ];
  for (const account of ['wa-01', 'wa-02']) {
    for (const [chat, label, purpose, role] of chats) {
      await row(
        `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized, source_role)
         VALUES ($1,$2,$3,$4,true,$5)`,
        [account, chat, label, purpose, role],
      );
    }
  }
  // Verified identities: PN chat → itself; LID chat → its verified PN link.
  await row(
    `INSERT INTO identity_aliases
       (account_id, jid, kind, confidence, display_name, name_source, canonical_jid, person_key, metadata)
     VALUES
       ('wa-01',$1,'PN','EXACT','Verified Client A','CONTACT_STORE',$1,$1,'{}'::jsonb),
       ('wa-01',$2,'OTHER','EXACT','Verified Client A','CONTACT_STORE',$1,$1,'{}'::jsonb),
       ('wa-01',$3,'LID','EXACT','Verified Client B','CONTACT_STORE',$4,$4,'{}'::jsonb),
       ('wa-01',$5,'OTHER','EXACT','Verified Client B','CONTACT_STORE',$4,$4,'{}'::jsonb),
       ('wa-01',$4,'PN','EXACT','Verified Client B','CONTACT_STORE',$4,$4,'{}'::jsonb)`,
    [CLIENT_PN_CHAT, CLIENT_PN, CLIENT_LID_CHAT, CLIENT_LID_PN, CLIENT_LID],
  );
  // Release group participants (verified identity links).
  for (const participant of [CLIENT_PN, CLIENT_LID]) {
    await row(
      `INSERT INTO escort_client_group_authorizations
         (id, account_id, group_jid, participant_jid, client_contact_id, active)
       VALUES ($1,'wa-01',$2,$3,$3,true)`,
      [`ga-release-${participant}`, RELEASE_GROUP, participant],
    );
  }
  for (const account of ['wa-01', 'wa-02']) {
    await row(
      `INSERT INTO whatsapp_sync_state (account_id, source_path, last_rowid)
       VALUES ($1,$2,0)`,
      [account, `/tmp/escort-${account}.db`],
    );
  }
  for (const [key, value] of [
    ['phase3_router_enabled', 'true'],
    ['phase3_cutover_rowid:wa-01', '0'],
    ['phase3_cutover_rowid:wa-02', '0'],
    ['phase3_business_chats:wa-01', JSON.stringify(ALL_CHATS)],
    ['phase3_business_chats:wa-02', JSON.stringify(ALL_CHATS)],
  ]) {
    await row(
      `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2::jsonb,now())`,
      [key, value],
    );
  }
});

async function stage(accountId, chatJid, messageId, direction, senderJid, text) {
  await row(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash, processing_status, source_rowid)
     VALUES ($1,$2,$3,$4,$5,now(),$6,encode(sha256(convert_to($6,'UTF8')),'hex'),'PENDING',$7)
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO UPDATE
       SET direction=EXCLUDED.direction, sender_jid=EXCLUDED.sender_jid,
           source_timestamp=EXCLUDED.source_timestamp, text_content=EXCLUDED.text_content,
           content_hash=EXCLUDED.content_hash, processing_status='PENDING',
           source_rowid=EXCLUDED.source_rowid, retry_count=0, last_error=NULL,
           last_processed_at=NULL, processed_at=NULL, classification=NULL`,
    [accountId, chatJid, messageId, direction, senderJid, text, nextRowid++],
  );
}

async function route() {
  return routePendingMessages(admin, 50);
}

const ORDER = 'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nDestination: Chattogram\n17/11/26(D)';

function programBySource(messageId) {
  return row('SELECT * FROM programs WHERE source_message_id = $1', [messageId]);
}

// ────────────────────────────────────────────────────────────────────────────
// A. Order intake
// ────────────────────────────────────────────────────────────────────────────

test('order: verified direct client PN chat creates one DRAFT', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-pn-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 1);
  const program = await programBySource('o-pn-1');
  assert.equal(program.state, 'DRAFT');
  assert.equal(program.mother_vessel, 'Ocean Star');
  assert.equal(program.lighter_vessel, 'L-77');
  assert.equal(program.source_chat_jid, CLIENT_PN_CHAT);
  assert.equal(result.byMessage[0].classification, 'VESSEL:PROGRAM_DRAFT');
});

test('order: verified LID chat resolves to the same canonical person', async () => {
  await stage('wa-01', CLIENT_LID_CHAT, 'o-lid-1', 'INCOMING', CLIENT_LID, ORDER);
  const result = await route();
  assert.equal(result.programs, 1, 'A verified LID↔PN alias must authorize intake');
  const program = await programBySource('o-lid-1');
  assert.equal(program.state, 'DRAFT');
  assert.equal(program.source_chat_jid, CLIENT_LID_CHAT);
});

test('order: unverified direct chat creates no draft', async () => {
  await stage('wa-01', UNVERIFIED_CHAT, 'o-unverified-1', 'INCOMING', '8801700000013', ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.match(result.byMessage[0].classification, /ESCORT_CLIENT_/);
  assert.equal(await programBySource('o-unverified-1'), null);
});

test('order: WA-02 never creates a WA-01 business draft', async () => {
  await stage('wa-02', CLIENT_PN_CHAT, 'o-wa02-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage[0].classification, 'VESSEL_WA02_NOT_AUTHORIZED');
});

test('order: Support group with complete order fields creates no draft', async () => {
  await stage('wa-01', SUPPORT_GROUP, 'o-support-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage[0].classification, 'SUPPORT_GROUP_NO_ORDER_DRAFT');
});

test('order: Release group with complete order fields creates no draft', async () => {
  await stage('wa-01', RELEASE_GROUP, 'o-release-group-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.ok(['VESSEL:RELEASE_UNSTRUCTURED', 'VESSEL:RELEASE_CANCELLATION_CANDIDATE'].includes(result.byMessage[0].classification)
    || result.byMessage[0].classification.startsWith('VESSEL:RELEASE_'));
  assert.equal(await programBySource('o-release-group-1'), null);
});

test('order: other approved group creates no draft', async () => {
  await stage('wa-01', OTHER_GROUP, 'o-other-group-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage[0].classification, 'OTHER_APPROVED_GROUP_CONTEXT_ONLY');
});

test('order: unresolved group role blocks draft creation', async () => {
  await stage('wa-01', UNKNOWN_GROUP, 'o-unknown-group-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.byMessage[0].classification, 'SOURCE_ROLE_REVIEW_REQUIRED');
});

test('order: incomplete order becomes a review candidate, never a draft', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-incomplete-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT * FROM review_items WHERE target_ref='o-incomplete-1'");
  assert.equal(item.category, 'INCOMPLETE_VESSEL_ORDER');
  assert.deepEqual(item.payload.missingFields, ['MISSING_MASTER_MOBILE']);
});

test('order: multiple lighters produce one draft per lighter', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-multi-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nLighter Vessel: L-78\nMaster mobile: 01911111111');
  const result = await route();
  assert.equal(result.programs, 2);
  const programs = await rows("SELECT lighter_vessel FROM programs WHERE source_message_id='o-multi-1' ORDER BY lighter_vessel");
  assert.deepEqual(programs.map((entry) => entry.lighter_vessel), ['L-77', 'L-78']);
});

test('order: multi-message fragments merge only inside the same client conversation', async () => {
  // First fragment: no Master Mobile → review candidate.
  await stage('wa-01', CLIENT_PN_CHAT, 'o-merge-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');
  const first = await route();
  assert.equal(first.reviewItems, 1);
  // Second fragment in the same conversation completes the order.
  await stage('wa-01', CLIENT_PN_CHAT, 'o-merge-2', 'INCOMING', CLIENT_PN,
    'Lighter Vessel: L-77\nMaster mobile: 01911111111');
  const second = await route();
  assert.equal(second.programs, 1, 'Complementary fragments must produce one Draft');
  const program = await programBySource('o-merge-2');
  assert.equal(program.state, 'DRAFT');
  assert.equal(program.master_mobile, '01911111111');
  const prior = await row("SELECT state FROM review_items WHERE target_ref='o-merge-1'");
  assert.equal(prior.state, 'WITHDRAWN');
  const sources = await rows('SELECT message_id FROM program_source_messages WHERE program_id=$1 ORDER BY message_id', [program.id]);
  assert.deepEqual(sources.map((entry) => entry.message_id), ['o-merge-1', 'o-merge-2']);
});

test('order: a fragment in another client conversation is never merged', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-merge-other-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77');
  await route();
  await stage('wa-01', CLIENT_LID_CHAT, 'o-merge-other-2', 'INCOMING', CLIENT_LID,
    'Lighter Vessel: L-77\nMaster mobile: 01911111111');
  const result = await route();
  assert.equal(result.programs, 0, 'Different authorized clients must not be merged');
  assert.equal(result.reviewItems, 1);
});

test('order: replayed order is idempotent', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-replay-1', 'INCOMING', CLIENT_PN, ORDER);
  assert.equal((await route()).programs, 1);
  await stage('wa-01', CLIENT_PN_CHAT, 'o-replay-1', 'INCOMING', CLIENT_PN, ORDER);
  const replay = await route();
  assert.equal(replay.programs, 0);
  assert.equal((await row("SELECT count(*)::int AS n FROM programs WHERE source_message_id='o-replay-1'")).n, 1);
});

test('order: same escort/date with a different lighter is a separate register row', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-diff-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  await stage('wa-01', CLIENT_PN_CHAT, 'o-diff-2', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-78\nMaster mobile: 01911111111\n17/11/26(D)');
  const result = await route();
  assert.equal(result.programs, 2);
});

test('order: same mother/lighter/start date ±1 day is a potential duplicate', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-dup-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n17/11/26(D)');
  assert.equal((await route()).programs, 1);
  await stage('wa-01', CLIENT_PN_CHAT, 'o-dup-2', 'INCOMING', CLIENT_PN,
    'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\n18/11/26(D)');
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT category FROM review_items WHERE target_ref='o-dup-2'");
  assert.equal(item.category, 'VESSEL_DUPLICATE_CANDIDATE');
});

test('order: client-supplied Escort assignment is reviewed, never drafted', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'o-client-assign-1', 'INCOMING', CLIENT_PN,
    `${ORDER}\nEscort Name: Client Choice\nEscort Mobile: 01712345678`);
  const result = await route();
  assert.equal(result.programs, 0);
  assert.equal(result.reviewItems, 1);
  assert.equal(result.byMessage[0].classification, 'VESSEL:REVIEW_SUBMITTED:CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN');
});

// ────────────────────────────────────────────────────────────────────────────
// B. Admin confirmation
// ────────────────────────────────────────────────────────────────────────────

const CONFIRM = 'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster Mobile: 01911111111\nEscort Name: Rahim\nEscort Mobile: 01922222222\nStart Date: 17/11/26\nShift: D';

async function draft() {
  await stage('wa-01', CLIENT_PN_CHAT, 'c-order-1', 'INCOMING', CLIENT_PN, ORDER);
  const result = await route();
  assert.equal(result.programs, 1);
  return programBySource('c-order-1');
}

test('confirmation: verified Admin outgoing reply in the original client chat confirms', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 1);
  const saved = await row('SELECT *, start_date::text AS start_date_text FROM programs WHERE id=$1', [program.id]);
  assert.equal(saved.state, 'CONFIRMED');
  assert.equal(saved.confirmation_message_id, 'c-confirm-1');
  assert.equal(saved.confirmation_chat_jid, CLIENT_PN_CHAT);
  assert.equal(saved.confirmation_sender_jid, ADMIN_JID);
  assert.equal(saved.confirmation_account_id, 'wa-01');
  assert.ok(saved.confirmation_timestamp);
  assert.equal(saved.escort_mobile, '+8801922222222');
  assert.equal(saved.start_date_text, '2026-11-17');

  const detail = await getProgram(program.id);
  assert.equal(detail.program.confirmation_sender_jid, ADMIN_JID);
  assert.equal(detail.program.confirmation_account_id, 'wa-01');
  assert.ok(detail.program.confirmation_timestamp);
  const evidence = await getMessageEvidence('wa-01', CLIENT_PN_CHAT, 'c-confirm-1');
  assert.match(String(evidence?.text_content), /Escort Name: Rahim/);
});

test('confirmation: spelling variant of the vessel name still matches (unique candidate)', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-variant-1', 'OUTGOING', ADMIN_JID,
    'Mother Vessel: M.V. OCEAN-STAR\nLighter Vessel: M.V. L-77\nMaster Mobile: 01911111111\nEscort Name: Rahim\nEscort Mobile: 01922222222\nStart Date: 17/11/26\nShift: D');
  const result = await route();
  assert.equal(result.confirmations, 1);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'CONFIRMED');
});

test('confirmation: same Admin replying to a different client is rejected', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_LID_CHAT, 'c-confirm-other-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: Admin reply in the Support group is rejected', async () => {
  const program = await draft();
  await stage('wa-01', SUPPORT_GROUP, 'c-confirm-support-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: Admin reply in the Release group is context only', async () => {
  const program = await draft();
  await stage('wa-01', RELEASE_GROUP, 'c-confirm-release-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal(result.byMessage[0].classification, 'RELEASE_GROUP_OUTGOING_CONTEXT');
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: WA-02 outgoing message is rejected', async () => {
  const program = await draft();
  await stage('wa-02', CLIENT_PN_CHAT, 'c-confirm-wa02-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: incoming client message with completed text is not a confirmation', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-incoming-1', 'INCOMING', CLIENT_PN, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: unverified sender claiming Admin is rejected', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-unverified-1', 'OUTGOING', '8801799999999', CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal(result.byMessage[0].classification, 'OUTGOING_NON_ADMIN');
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'DRAFT');
});

test('confirmation: Admin reply without an original Draft does not silently confirm', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-nodraft-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const result = await route();
  assert.equal(result.confirmations, 0);
  assert.equal(result.byMessage[0].classification, 'CONFIRMATION_UNMATCHED');
  assert.equal(result.reviewItems, 1);
});

test('confirmation: exact replay is idempotent and keeps provenance', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-replay-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  assert.equal((await route()).confirmations, 1);
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-replay-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  const replay = await route();
  assert.equal(replay.confirmations, 1);
  assert.equal((await row('SELECT count(*)::int AS n FROM program_assignments WHERE program_id=$1', [program.id])).n, 1);
  const saved = await row('SELECT state, confirmation_message_id FROM programs WHERE id=$1', [program.id]);
  assert.equal(saved.state, 'CONFIRMED');
  assert.equal(saved.confirmation_message_id, 'c-confirm-replay-1');
});

test('confirmation: a different Admin confirmation for an already confirmed Draft goes to review', async () => {
  const program = await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-a', 'OUTGOING', ADMIN_JID, CONFIRM);
  assert.equal((await route()).confirmations, 1);
  await stage('wa-01', CLIENT_PN_CHAT, 'c-confirm-b', 'OUTGOING', ADMIN_JID, CONFIRM);
  const second = await route();
  assert.equal(second.confirmations, 0);
  assert.equal(second.byMessage[0].classification, 'CONFIRMATION_ALREADY_CONFIRMED');
  assert.equal((await row('SELECT confirmation_message_id FROM programs WHERE id=$1', [program.id])).confirmation_message_id, 'c-confirm-a');
});

// ────────────────────────────────────────────────────────────────────────────
// C. Vessel Register duplicate / naming
// ────────────────────────────────────────────────────────────────────────────

test('register: name formatting variation does not duplicate the row', async () => {
  await stage('wa-01', CLIENT_PN_CHAT, 'r-variant-1', 'INCOMING', CLIENT_PN,
    'Mother Vessel: M.V. Union-Odyssey\nLighter Vessel: M.V. Banglar-Modhumoti-1\nMaster mobile: 01911111111\n17/11/26(D)');
  assert.equal((await route()).programs, 1);
  await stage('wa-01', CLIENT_PN_CHAT, 'r-variant-2', 'INCOMING', CLIENT_PN,
    'Mother Vessel: M.V. Union Odyssey\nLighter Vessel: Banglar Modhumoti 1\nMaster mobile: 01911111111\n17/11/26(D)');
  const second = await route();
  // Normalized vessel identity treats both spellings as the same vessel on the
  // same date: no second row; the replay is recorded as a duplicate.
  assert.equal(second.programs, 0);
  assert.match(second.byMessage[0].classification, /^VESSEL:DUPLICATE_PROGRAM:|^VESSEL:NO_VALID_BLOCK$|^DUPLICATE_PROGRAM:/);
  assert.equal((await row("SELECT count(*)::int AS n FROM programs WHERE start_date='2026-11-17'")).n, 1);
});



test('manual vessel program stores Master Name and MANUAL source type', async () => {
  const created = await createProgram(admin, {
    motherVessel: 'MV Manual', lighterVessel: 'L-MANUAL', masterName: 'Master A',
    masterMobile: '01911111111', startDate: '2026-12-01', startShift: 'D',
  }, {channel: 'WEB', sourceType: 'MANUAL'});
  assert.equal(created.program.master_name, 'Master A');
  assert.equal(created.program.source_type, 'MANUAL');
  assert.equal(created.program.state, 'DRAFT');
  const updated = await updateProgram(admin, created.program.id, {masterName: 'Master B'});
  assert.equal(updated.program.master_name, 'Master B');
});

test('register list paginates and exposes the updated timestamp', async () => {
  for (const [index, lighter] of ['P-1', 'P-2', 'P-3'].entries()) {
    await createProgram(admin, {
      motherVessel: 'MV Page', lighterVessel: lighter, masterMobile: '01911111111',
      startDate: `2026-12-0${index + 1}`, startShift: 'D',
    });
  }
  const first = await listPrograms({q: 'MV Page', limit: 2, offset: 0});
  const second = await listPrograms({q: 'MV Page', limit: 2, offset: 2});
  assert.equal(first.length, 2);
  assert.equal(second.length, 1);
  assert.equal(await countPrograms({q: 'MV Page'}), 3);
  assert.ok(first[0].updated_at, 'updated timestamp is exposed for the list');
  assert.notEqual(first[0].id, second[0].id);
});

test('register: unconfirmed Draft is not a confirmed program', async () => {
  const program = await draft();
  assert.equal(program.state, 'DRAFT');
  assert.equal(program.confirmation_message_id, null);
});

// ────────────────────────────────────────────────────────────────────────────
// D. Release
// ────────────────────────────────────────────────────────────────────────────

async function createDuty(overrides = {}) {
  const created = await createProgram(admin, {
    motherVessel: 'MV Release', lighterVessel: 'L-Release', masterMobile: '01911111111',
    escortMobile: '01812345678', escortName: 'Release Test',
    startDate: '2026-11-01', startShift: 'N',
    ...overrides,
  });
  return created.program;
}

const RELEASE = 'Escort Release\nMother Vessel: M.V. Release\nLighter Vessel: M.V. L-Release\nMaster mobile: 01911111111\nDestination: Chattogram\nEscort Name: Release Test\nEscort mobile: 01812345678\nStart: 01/11/26-((N)\nEnd: 05/11/26-(D)\nTotal day: 5-day\nFood bill: 750/-';

test('release: structured slip updates the exact existing program', async () => {
  const program = await createDuty();
  await stage('wa-01', RELEASE_GROUP, 'rel-1', 'INCOMING', CLIENT_PN, RELEASE);
  const result = await route();
  assert.equal(result.releases, 1);
  const saved = await row("SELECT state, end_date::text AS end_date, end_shift, start_date::text AS start_date, start_shift, release_message_id, release_chat_jid, release_sender_jid, release_account_id, release_timestamp FROM programs WHERE id=$1", [program.id]);
  assert.equal(saved.state, 'RELEASED');
  assert.equal(saved.end_date, '2026-11-05');
  assert.equal(saved.end_shift, 'D');
  assert.equal(saved.release_message_id, 'rel-1');
  assert.equal(saved.release_chat_jid, RELEASE_GROUP);
  assert.equal(saved.release_sender_jid, CLIENT_PN);
  assert.equal(saved.release_account_id, 'wa-01');
  assert.ok(saved.release_timestamp);
  // Start Date / Start Shift are preserved, never overwritten by release.
  assert.equal(saved.start_date, '2026-11-01');
  assert.equal(saved.start_shift, 'N');
  assert.equal(await programBySource('rel-1'), null, 'Release never creates a program');
});

test('release: replay is idempotent and creates no duplicate release event', async () => {
  const program = await createDuty();
  await stage('wa-01', RELEASE_GROUP, 'rel-replay-1', 'INCOMING', CLIENT_PN, RELEASE);
  assert.equal((await route()).releases, 1);
  const before = await row('SELECT revision FROM programs WHERE id=$1', [program.id]);
  await stage('wa-01', RELEASE_GROUP, 'rel-replay-1', 'INCOMING', CLIENT_PN, RELEASE);
  const replay = await route();
  assert.equal(replay.releases, 0);
  assert.equal(replay.byMessage[0].classification, 'VESSEL:RELEASE_ALREADY_APPLIED');
  const after = await row('SELECT revision FROM programs WHERE id=$1', [program.id]);
  assert.equal(after.revision, before.revision);
  assert.equal((await row("SELECT count(*)::int AS n FROM program_events WHERE program_id=$1 AND action='RELEASE_PROGRAM'", [program.id])).n, 1);
});

test('release: conflicting second release goes to review and preserves prior values', async () => {
  const program = await createDuty();
  await stage('wa-01', RELEASE_GROUP, 'rel-conflict-1', 'INCOMING', CLIENT_PN, RELEASE);
  assert.equal((await route()).releases, 1);
  await stage('wa-01', RELEASE_GROUP, 'rel-conflict-2', 'INCOMING', CLIENT_PN,
    RELEASE.replace('End: 05/11/26-(D)', 'End: 06/11/26-(N)'));
  const conflict = await route();
  assert.equal(conflict.releases, 0);
  assert.equal(conflict.reviewItems, 1);
  const saved = await row("SELECT end_date::text AS end_date, end_shift FROM programs WHERE id=$1", [program.id]);
  assert.equal(saved.end_date, '2026-11-05');
  assert.equal(saved.end_shift, 'D');
  const item = await row("SELECT payload FROM review_items WHERE target_ref='rel-conflict-2'");
  assert.equal(item.payload.releaseCategory, 'RELEASE_CONFLICT_EXISTING_RELEASE');
});

test('release: ambiguous active duties go to review and release nothing', async () => {
  const a = await createDuty({lighterVessel: 'L-A1'});
  const b = await createDuty({lighterVessel: 'L-B1'});
  await stage('wa-01', RELEASE_GROUP, 'rel-ambig-1', 'INCOMING', CLIENT_PN,
    'Escort Release\nEscort Name: Release Test\nEscort mobile: 01812345678\nStart: 01/11/26-((N)\nEnd: 05/11/26-(D)');
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  assert.equal((await row("SELECT count(*)::int AS n FROM programs WHERE id IN ($1,$2) AND state='RELEASED'", [a.id, b.id])).n, 0);
});

test('release: already completed duty is reported, never re-released', async () => {
  const program = await createDuty();
  await row("UPDATE programs SET state='COMPLETED', end_date='2026-11-05', end_shift='D' WHERE id=$1", [program.id]);
  await stage('wa-01', RELEASE_GROUP, 'rel-completed-1', 'INCOMING', CLIENT_PN, RELEASE);
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  const item = await row("SELECT payload FROM review_items WHERE target_ref='rel-completed-1'");
  assert.equal(item.payload.releaseCategory, 'RELEASE_PROGRAM_ALREADY_COMPLETED');
});

test('release: incomplete slip is reviewed and never releases', async () => {
  const program = await createDuty();
  await stage('wa-01', RELEASE_GROUP, 'rel-incomplete-1', 'INCOMING', CLIENT_PN,
    'Escort Release\nEscort Name: Release Test\nEscort mobile: 01812345678\nStart: 01/11/26-((N)');
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.reviewItems, 1);
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'ASSIGNED');
});

test('release: release slip in the Support group never updates a program', async () => {
  const program = await createDuty();
  await stage('wa-01', SUPPORT_GROUP, 'rel-support-1', 'INCOMING', CLIENT_PN, RELEASE);
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.byMessage[0].classification, 'SUPPORT_GROUP_NO_ORDER_DRAFT');
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'ASSIGNED');
});

test('release: unapproved group never updates a program', async () => {
  const program = await createDuty();
  await stage('wa-01', OTHER_GROUP, 'rel-other-1', 'INCOMING', CLIENT_PN, RELEASE);
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.byMessage[0].classification, 'OTHER_APPROVED_GROUP_CONTEXT_ONLY');
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'ASSIGNED');
});

test('release: unknown release-group sender is rejected', async () => {
  const program = await createDuty();
  await stage('wa-01', RELEASE_GROUP, 'rel-unknown-sender-1', 'INCOMING', '8801799999999', RELEASE);
  const result = await route();
  assert.equal(result.releases, 0);
  assert.equal(result.byMessage[0].classification, 'VESSEL:GROUP_PARTICIPANT_NOT_AUTHORIZED');
  assert.equal((await row('SELECT state FROM programs WHERE id=$1', [program.id])).state, 'ASSIGNED');
});

// ────────────────────────────────────────────────────────────────────────────
// E. Regression / security
// ────────────────────────────────────────────────────────────────────────────

test('regression: workflow never writes Cash / Ledger', async () => {
  await draft();
  await stage('wa-01', CLIENT_PN_CHAT, 'c-reg-1', 'OUTGOING', ADMIN_JID, CONFIRM);
  await route();
  assert.equal((await row('SELECT count(*)::int AS n FROM ledger_entries')).n, 0);
  assert.equal((await row('SELECT count(*)::int AS n FROM cash_postings')).n, 0);
  assert.equal((await row('SELECT count(*)::int AS n FROM cash_instructions')).n, 0);
});

test('regression: WA-02 remains identity-only for business processing', async () => {
  await stage('wa-02', CASH_CHAT, 'reg-wa02-cash-1', 'OUTGOING', ADMIN_JID,
    'ID: 01712345678 Rahim Uddin 01812345678(B) 500/- duty pay');
  const result = await route();
  assert.equal(result.instructions, 0);
  assert.equal(result.byMessage[0].classification, 'CASH:WRONG_ACCOUNT');
});
