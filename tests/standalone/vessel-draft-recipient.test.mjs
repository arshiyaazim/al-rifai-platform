// Vessel Draft recipient resolution — isolated disposable database only.
//
// The delivery target is the SAME original authorised order-giving
// conversation. A direct client chat stays a direct client chat; an approved
// group stays that same group. An Admin JID is never a fallback.
import assert from 'node:assert/strict';
import test, {after, before, beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {resolveDraftRecipient} from '../../lib/standalone/vessel-draft-recipient.ts';

const DIRECT = '55000000000002@lid';
const DIRECT_SENDER = '55000000000002';
const GROUP = '120363426895117701@g.us';
const GROUP_OTHER = '120363426895117702@g.us';
const CASH_CHAT = '8801777000003@s.whatsapp.net';
const ADMIN_LID = '55000000000009@lid';
const SUFFIX = `vdd-recipient-${process.pid}`;
const messageIds = [];

let owner;

async function setSetting(value) {
  await owner.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ('phase3_business_chats:wa-01', $1::jsonb, now())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
    [JSON.stringify(value)],
  );
}

async function setChat(chatJid, {purpose = 'ORDERS', authorized = true} = {}) {
  await owner.query(
    `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
     VALUES ('wa-01',$1,'test',$2,$3)
     ON CONFLICT (account_id, chat_jid) DO UPDATE
       SET purpose=EXCLUDED.purpose, authorized=EXCLUDED.authorized`,
    [chatJid, purpose, authorized],
  );
}

async function authorizeParticipant(groupJid, participantJid, active = true) {
  await owner.query(
    `INSERT INTO escort_client_group_authorizations
       (id, account_id, group_jid, participant_jid, client_contact_id, active)
     VALUES ($1,'wa-01',$2,$3,'test-client',$4)
     ON CONFLICT (id) DO UPDATE SET active=EXCLUDED.active`,
    [`wga-${groupJid}-${participantJid}`, groupJid, participantJid, active],
  );
}

async function insertMessage(id, {sender, chat, direction = 'INCOMING'}) {
  messageIds.push({id, chat});
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
     VALUES ('wa-01',$1,$2,$3,$4,now(),'order placeholder',$5)
     ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE
       SET sender_jid=EXCLUDED.sender_jid, direction=EXCLUDED.direction`,
    [chat, id, direction, sender, `hash-${chat}-${id}`],
  );
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'vessel-draft-recipient-test'});
});

beforeEach(async () => {
  for (const entry of messageIds.splice(0)) {
    await owner.query('DELETE FROM whatsapp_messages WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3', [
      'wa-01', entry.chat, entry.id,
    ]);
  }
  await owner.query("DELETE FROM app_settings WHERE key='phase3_business_chats:wa-01'");
  await owner.query("DELETE FROM escort_client_group_authorizations WHERE group_jid LIKE '1203634268951177%'");
  await owner.query("DELETE FROM whatsapp_chats WHERE chat_jid IN ($1,$2,$3,$4)", [
    DIRECT, GROUP, GROUP_OTHER, CASH_CHAT,
  ]);
});

after(async () => {
  await owner.query("DELETE FROM app_settings WHERE key='phase3_business_chats:wa-01'");
  await owner.end();
});

test('a direct client chat resolves to that exact conversation, never the Admin', async () => {
  await setSetting([DIRECT]);
  await setChat(DIRECT, {purpose: 'ORDERS'});
  const id = `${SUFFIX}-direct`;
  await insertMessage(id, {sender: DIRECT_SENDER, chat: DIRECT});

  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: DIRECT,
  });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.recipientJid, DIRECT);
  assert.equal(result.basis, 'SOURCE_CONVERSATION');

  const pinned = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: DIRECT,
    explicitRecipient: DIRECT,
  });
  assert.equal(pinned.status, 'RESOLVED');
  assert.equal(pinned.basis, 'EXPLICIT_PIN_MATCH');

  const wrongPin = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: DIRECT,
    explicitRecipient: ADMIN_LID,
  });
  assert.equal(wrongPin.status, 'RECIPIENT_NOT_APPROVED');
  assert.equal(wrongPin.reason, 'EXPLICIT_RECIPIENT_MISMATCH');
});

test('an approved group order resolves to that same group, not the client or Admin', async () => {
  await setSetting([GROUP]);
  await setChat(GROUP, {purpose: 'ORDERS'});
  await authorizeParticipant(GROUP, '114109177684169');
  const id = `${SUFFIX}-group`;
  await insertMessage(id, {sender: '114109177684169', chat: GROUP});

  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: GROUP,
  });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.recipientJid, GROUP, 'the exact approved group');
  assert.notEqual(result.recipientJid, ADMIN_LID);
});

test('a group order from an unapproved participant is refused', async () => {
  await setSetting([GROUP]);
  await setChat(GROUP, {purpose: 'ORDERS'});
  const id = `${SUFFIX}-group-bad`;
  await insertMessage(id, {sender: '114109177684169', chat: GROUP});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: GROUP,
  });
  assert.equal(result.status, 'RECIPIENT_NOT_APPROVED');
  assert.equal(result.reason, 'GROUP_PARTICIPANT_NOT_AUTHORIZED');
});

test('a source conversation outside the business allowlist is refused', async () => {
  await setSetting([DIRECT]);
  await setChat(GROUP, {purpose: 'ORDERS'});
  await authorizeParticipant(GROUP, '114109177684169');
  const id = `${SUFFIX}-outside`;
  await insertMessage(id, {sender: '114109177684169', chat: GROUP});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: GROUP,
  });
  assert.equal(result.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(result.reason, 'SOURCE_CONVERSATION_NOT_IN_BUSINESS_SCOPE');
});

test('an unauthorised or non-ORDERS chat is refused', async () => {
  await setSetting([CASH_CHAT]);
  await setChat(CASH_CHAT, {purpose: 'CASH'});
  const id = `${SUFFIX}-cash`;
  await insertMessage(id, {sender: CASH_CHAT, chat: CASH_CHAT});
  const cash = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: CASH_CHAT,
  });
  assert.equal(cash.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(cash.reason, 'SOURCE_CONVERSATION_NOT_ORDERS');

  await setChat(CASH_CHAT, {purpose: 'ORDERS', authorized: false});
  const disabled = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: CASH_CHAT,
  });
  assert.equal(disabled.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(disabled.reason, 'SOURCE_CONVERSATION_NOT_AUTHORIZED');
});

test('a program/source-chat mismatch blocks instead of alias-guessing', async () => {
  await setSetting([DIRECT, GROUP_OTHER]);
  await setChat(DIRECT, {purpose: 'ORDERS'});
  const id = `${SUFFIX}-mismatch`;
  await insertMessage(id, {sender: DIRECT_SENDER, chat: DIRECT});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: GROUP_OTHER,
  });
  assert.equal(result.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(result.reason, 'SOURCE_CHAT_MISMATCH');
});

test('a message found in two chats is ambiguous and is refused', async () => {
  await setSetting([DIRECT, GROUP_OTHER]);
  await setChat(DIRECT, {purpose: 'ORDERS'});
  await setChat(GROUP_OTHER, {purpose: 'ORDERS'});
  const id = `${SUFFIX}-ambiguous`;
  await insertMessage(id, {sender: DIRECT_SENDER, chat: DIRECT});
  await insertMessage(id, {sender: '114109177684169', chat: GROUP_OTHER});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: DIRECT,
  });
  assert.equal(result.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(result.reason, 'SOURCE_CONVERSATION_AMBIGUOUS');
});

test('a missing source message or missing source id blocks delivery', async () => {
  await setSetting([DIRECT]);
  await setChat(DIRECT, {purpose: 'ORDERS'});
  const missing = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: `${SUFFIX}-missing`,
    sourceChatJid: DIRECT,
  });
  assert.equal(missing.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(missing.reason, 'SOURCE_MESSAGE_NOT_FOUND');

  const noId = await resolveDraftRecipient({
    programId: 'p',
    sourceChatJid: DIRECT,
  });
  assert.equal(noId.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(noId.reason, 'SOURCE_MESSAGE_REQUIRED');
});

test('a direct chat whose sender is not the chat identity is refused', async () => {
  await setSetting([DIRECT]);
  await setChat(DIRECT, {purpose: 'ORDERS'});
  const id = `${SUFFIX}-direct-sender`;
  await insertMessage(id, {sender: ADMIN_LID, chat: DIRECT});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: DIRECT,
  });
  assert.equal(result.status, 'RECIPIENT_NOT_APPROVED');
  assert.equal(result.reason, 'DIRECT_SENDER_CHAT_MISMATCH');
});
