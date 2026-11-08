// Vessel Draft recipient resolution — isolated disposable database only.
//
// Proves the owner rule: one direct Admin conversation, never a client or
// release group, and never an invented identity. The reserved production shape
// is reproduced: a client sends the order into a group and the Admin's own LID
// appears as an OUTGOING sender in the same conversation.
import assert from 'node:assert/strict';
import test, {after, before, beforeEach} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {resolveDraftRecipient} from '../../lib/standalone/vessel-draft-recipient.ts';

const PN = '8801880446111@s.whatsapp.net';
const LID = '55000000000001@lid';
const STRANGER = '8801777000001@s.whatsapp.net';
const DIRECT = '8801777000099@s.whatsapp.net';
const SUFFIX = `vdd-recipient-${process.pid}`;
const GROUP_PARTICIPANT = '120363426895117701@g.us';
const GROUP_ORDER = '120363426895117702@g.us';
const GROUP_EMPTY = '120363426895117703@g.us';
const GROUP_FALLBACK = '120363426895117704@g.us';

const messageIds = [];
let owner;
let savedAccount;

async function insertMessage(id, {sender, chat, direction = 'INCOMING'}) {
  messageIds.push(id);
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
     VALUES ('wa-01',$1,$2,$3,$4,now(),'order placeholder',$5)
     ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE
       SET sender_jid=EXCLUDED.sender_jid, direction=EXCLUDED.direction`,
    [chat, id, direction, sender, `hash-${id}`],
  );
}

async function withAdmins(adminJids, accountJid, fn) {
  await owner.query(
    "UPDATE whatsapp_accounts SET admin_jids=$1::jsonb, account_jid=$2 WHERE id='wa-01'",
    [JSON.stringify(adminJids), accountJid],
  );
  try {
    return await fn();
  } finally {
    await owner.query(
      "UPDATE whatsapp_accounts SET admin_jids=$1::jsonb, account_jid=$2 WHERE id='wa-01'",
      [JSON.stringify(savedAccount.admin_jids), savedAccount.account_jid],
    );
  }
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'vessel-draft-recipient-test'});
  const account = await owner.query("SELECT admin_jids, account_jid FROM whatsapp_accounts WHERE id='wa-01'");
  assert.ok(Array.isArray(account.rows[0]?.admin_jids));
  savedAccount = account.rows[0];
});

beforeEach(async () => {
  if (messageIds.length) {
    await owner.query('DELETE FROM whatsapp_messages WHERE account_id=$1 AND message_id = ANY($2::text[])', [
      'wa-01', messageIds.splice(0),
    ]);
  }
});

after(async () => {
  await owner.query('DELETE FROM whatsapp_messages WHERE account_id=$1 AND message_id = ANY($2::text[])', [
    'wa-01', messageIds,
  ]).catch(() => undefined);
  await owner.end();
});

test('explicit Owner pin resolves verbatim and refuses a group', async () => {
  const pinned = await resolveDraftRecipient({
    programId: 'p',
    explicitRecipient: STRANGER,
  });
  assert.equal(pinned.status, 'RESOLVED');
  assert.equal(pinned.basis, 'EXPLICIT');
  assert.equal(pinned.recipientJid, STRANGER);

  const group = await resolveDraftRecipient({
    programId: 'p',
    explicitRecipient: GROUP_EMPTY,
  });
  assert.equal(group.status, 'RECIPIENT_NOT_APPROVED');
  assert.equal(group.reason, 'EXPLICIT_RECIPIENT_IS_GROUP');
});

test('the Admin participant in the original conversation is the recipient, not the client', async () => {
  await withAdmins([PN, '55000000000001', LID], PN, async () => {
    const client = `${SUFFIX}-client`;
    const admin = `${SUFFIX}-admin-out`;
    await insertMessage(client, {sender: '114109177684169', chat: GROUP_PARTICIPANT});
    await insertMessage(admin, {
      sender: '55000000000001', chat: GROUP_PARTICIPANT, direction: 'OUTGOING',
    });
    const result = await resolveDraftRecipient({
      programId: 'p',
      sourceMessageId: client,
      sourceChatJid: GROUP_PARTICIPANT,
    });
    assert.equal(result.status, 'RESOLVED');
    assert.equal(result.basis, 'SOURCE_CONVERSATION');
    assert.equal(result.recipientJid, LID, 'the Admin LID, never the client or the group');
  });
});

test('an authorised Admin who sent the original order is resolved', async () => {
  const id = `${SUFFIX}-admin-in`;
  await insertMessage(id, {sender: PN, chat: GROUP_ORDER});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: GROUP_ORDER,
  });
  assert.equal(result.status, 'RESOLVED');
  assert.equal(result.basis, 'SOURCE_CONVERSATION');
  assert.equal(result.recipientJid, PN, 'a group chat never becomes the recipient');
});

test('a non-admin order sender is refused rather than guessed', async () => {
  const id = `${SUFFIX}-stranger`;
  await insertMessage(id, {sender: STRANGER, chat: STRANGER});
  const result = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: id,
    sourceChatJid: STRANGER,
  });
  assert.equal(result.status, 'RECIPIENT_NOT_APPROVED');
  assert.equal(result.reason, 'SOURCE_SENDER_NOT_ADMIN');
});

test('a missing source message is never replaced by the source group', async () => {
  // Keep the reserved Admin list but use a chat with no messages.
  await withAdmins([PN], null, async () => {
    const result = await resolveDraftRecipient({
      programId: 'p',
      sourceMessageId: `${SUFFIX}-missing`,
      sourceChatJid: GROUP_FALLBACK,
    });
    assert.equal(result.status, 'SOURCE_CONVERSATION_NOT_FOUND');
    assert.equal(result.reason, 'SOURCE_MESSAGE_NOT_FOUND');
  });
});

test('a direct source chat may resolve only when it is an authorised Admin', async () => {
  await withAdmins([DIRECT], null, async () => {
    const direct = await resolveDraftRecipient({
      programId: 'p',
      sourceMessageId: null,
      sourceChatJid: DIRECT,
    });
    assert.equal(direct.status, 'RESOLVED');
    assert.equal(direct.recipientJid, DIRECT);
    assert.equal(direct.basis, 'SOURCE_CHAT');
  });

  const group = await resolveDraftRecipient({
    programId: 'p',
    sourceMessageId: null,
    sourceChatJid: GROUP_EMPTY,
  });
  assert.equal(group.status, 'SOURCE_CONVERSATION_NOT_FOUND');
  assert.equal(group.reason, 'SOURCE_CHAT_NOT_ADMIN');
});

test('an ambiguous Admin set is refused instead of choosing one', async () => {
  const otherAdmin = '8801777000088@s.whatsapp.net';
  await withAdmins([PN, otherAdmin], null, async () => {
    const chat = '120363426895117705@g.us';
    const client = `${SUFFIX}-amb-client`;
    await insertMessage(client, {sender: STRANGER, chat});
    await insertMessage(`${SUFFIX}-amb-1`, {sender: PN, chat, direction: 'OUTGOING'});
    await insertMessage(`${SUFFIX}-amb-2`, {sender: otherAdmin, chat, direction: 'OUTGOING'});
    const result = await resolveDraftRecipient({
      programId: 'p',
      sourceMessageId: client,
      sourceChatJid: chat,
    });
    assert.equal(result.status, 'RECIPIENT_NOT_APPROVED');
    assert.equal(result.reason, 'ADMIN_AMBIGUOUS');
  });
});
