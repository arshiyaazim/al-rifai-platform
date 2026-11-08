// WhatsApp Message Intelligence integration tests — disposable DB only.
//
// Proves the existing Message Data Table read model returns the mandatory
// identity, contact, conversation, media, call-trace and business columns from
// the canonical message row, without creating a second message table.
import assert from 'node:assert/strict';
import test, {after, before} from 'node:test';
import {createPool} from '../../db/postgres.mjs';
import {
  listCalls, listMessages, messageStats, setMessageIntelligence,
} from '../../lib/standalone/messages.ts';

const ACCOUNT = 'mi-test-account';
const DIRECT_CHAT = '8801711111111@s.whatsapp.net';
const GROUP_CHAT = '120363999999999999@g.us';
const ADMIN = '8801880446111@s.whatsapp.net';
const CLIENT = '8801711111111@s.whatsapp.net';
const OTHER_CLIENT = '8801722222222@s.whatsapp.net';
const T0 = '2026-11-08T10:00:00.000Z';

let owner;

async function clean() {
  await owner.query('DELETE FROM whatsapp_media WHERE account_id=$1', [ACCOUNT]);
  await owner.query('DELETE FROM whatsapp_message_intelligence WHERE account_id=$1', [ACCOUNT]);
  await owner.query('DELETE FROM whatsapp_calls WHERE account_id=$1', [ACCOUNT]);
  await owner.query('DELETE FROM whatsapp_messages WHERE account_id=$1', [ACCOUNT]);
  await owner.query('DELETE FROM whatsapp_chats WHERE account_id=$1', [ACCOUNT]);
  await owner.query('DELETE FROM identity_aliases WHERE account_id=$1', [ACCOUNT]);
  await owner.query("DELETE FROM escort_client_group_authorizations WHERE id='mi-ga'");
  await owner.query("DELETE FROM employees WHERE employee_mobile='+8801733333333'");
  await owner.query('DELETE FROM whatsapp_accounts WHERE id=$1', [ACCOUNT]);
}

before(async () => {
  owner = createPool({role: 'app', readOnly: false, applicationName: 'message-intelligence-test'});
  await clean();
  await owner.query(
    `INSERT INTO whatsapp_accounts (id,label,enabled,transport,socket_path,account_jid,admin_jids)
     VALUES ($1,'MI test',true,'SQLITE_STORE','/tmp/mi-test-messages.db',$2,$3::jsonb)`,
    [ACCOUNT, ADMIN, JSON.stringify([ADMIN])],
  );
  await owner.query(
    `INSERT INTO whatsapp_chats (account_id,chat_jid,label,purpose,authorized)
     VALUES ($1,$2,'Client Direct','ORDERS',true),($1,$3,'Escort Operations Group','ORDERS',true)`,
    [ACCOUNT, DIRECT_CHAT, GROUP_CHAT],
  );
  const identities = [
    [ADMIN, 'PN', 'EXACT', 'Admin Owner', null, ADMIN, ADMIN, {role: 'account'}],
    [CLIENT, 'PN', 'EXACT', 'Client Saved', 'Client Push', CLIENT, CLIENT,
      {saved_name: 'Client Saved', my_contact_name: 'Client Owner Contact', push_name: 'Client Push'}],
    [OTHER_CLIENT, 'LID', 'EXACT', 'Group Client', 'Group Push', CLIENT, CLIENT,
      {saved_name: 'Group Client', my_contact_name: 'Group Client Owner', push_name: 'Group Push'}],
  ];
  for (const [jid, kind, confidence, display, , canonical, person, metadata] of identities) {
    await owner.query(
      `INSERT INTO identity_aliases
         (account_id,jid,kind,confidence,display_name,name_source,canonical_jid,person_key,metadata)
       VALUES ($1,$2,$3,$4,$5,'CONTACT_STORE',$6,$7,$8::jsonb)`,
      [ACCOUNT, jid, kind, confidence, display, canonical, person, JSON.stringify(metadata)],
    );
  }
  await owner.query(
    `INSERT INTO employees (employee_mobile, preferred_name, duty_type, created_by)
     VALUES ('+8801733333333','Employee Person','escort','test') ON CONFLICT DO NOTHING`,
  );
  await owner.query(
    `INSERT INTO escort_client_group_authorizations
       (id,account_id,group_jid,participant_jid,client_contact_id,active)
     VALUES ('mi-ga',$1,$2,$3,'mi-client',true)
     ON CONFLICT (id) DO UPDATE SET active=true`,
    [ACCOUNT, GROUP_CHAT, OTHER_CLIENT],
  );
  await owner.query(
    `INSERT INTO whatsapp_messages
       (account_id,chat_jid,message_id,direction,sender_jid,source_timestamp,text_content,content_hash,
        classification,processing_status,chat_kind,chat_label,media_type,media_filename,media_sha256,media_length,raw_payload)
     VALUES
       ($1,$2,'mi-direct-1','INCOMING',$3,$4,'Payment test','hash1','CASH:REVIEW_CREATED','FAILED','DIRECT','Client Direct',NULL,NULL,NULL,NULL,'{}'),
       ($1,$5,'mi-group-1','INCOMING',$6,$4,'Photo caption','hash2','VESSEL:PROGRAM_DRAFT','COMPLETED','GROUP','Escort Operations Group','image','slip.jpg',repeat('a',64),1234,'{}'),
       ($1,$2,'mi-admin-1','OUTGOING',$7,$4,'Admin reply','hash3',NULL,'COMPLETED','DIRECT','Client Direct',NULL,NULL,NULL,NULL,'{}')`,
    [ACCOUNT, DIRECT_CHAT, CLIENT, T0, GROUP_CHAT, OTHER_CLIENT, ADMIN],
  );
  await owner.query(
    `INSERT INTO whatsapp_media
       (account_id,chat_jid,message_id,media_type,mime_type,filename,byte_length,sha256,storage_path,status)
     VALUES ($1,$2,'mi-group-1','image','image/jpeg','slip.jpg',1234,repeat('a',64),'mi/slip.jpg','STORED')`,
    [ACCOUNT, GROUP_CHAT],
  );
  await owner.query(
    `INSERT INTO whatsapp_calls
       (account_id,call_id,chat_jid,from_jid,source_timestamp,direction,call_type,is_group,status,duration_sec,reason)
     VALUES ($1,'mi-call-1',$2,$3,$4,'INCOMING','voice',false,'missed',0,'no answer')`,
    [ACCOUNT, DIRECT_CHAT, CLIENT, T0],
  );
});

after(async () => {
  await clean();
  await owner.end();
});

test('message view returns event time, identity, contact, group, media and call columns', async () => {
  const result = await listMessages({account: ACCOUNT, limit: 10});
  assert.equal(result.total, 3);
  const direct = result.items.find((item) => item.message_id === 'mi-direct-1');
  assert.ok(direct);
  assert.equal(direct.dhaka_date, '2026-11-08');
  assert.equal(direct.dhaka_time, '16:00:00');
  assert.equal(new Date(direct.source_timestamp).toISOString(), T0);
  assert.equal(direct.sender_mobile, '+8801711111111');
  assert.equal(direct.sender_country_code, '+880');
  assert.equal(direct.sender_saved_name, 'Client Saved');
  assert.equal(direct.my_contact_name, 'Client Owner Contact');
  assert.equal(direct.whatsapp_push_name, 'Client Push');
  assert.equal(direct.sender_display_name, 'Client Saved');
  assert.equal(direct.identity_confidence, 'EXACT');
  assert.equal(direct.identity_verification_status, 'VERIFIED');
  assert.equal(direct.business_domain, 'CASH');
  assert.equal(direct.media_status, 'NOT_APPLICABLE');
  assert.equal(direct.call_status, 'NOT_AVAILABLE');
  assert.equal(direct.review_status, 'REVIEW_REQUIRED');

  const group = result.items.find((item) => item.message_id === 'mi-group-1');
  assert.ok(group);
  assert.equal(group.chat_type, 'GROUP');
  assert.equal(group.group_name, 'Escort Operations Group');
  assert.equal(group.message_type, 'image');
  assert.equal(group.media_status, 'STORED');
  assert.equal(group.business_domain, 'VESSEL');
  assert.equal(group.identity_role, 'ESCORT_CLIENT');

  const admin = result.items.find((item) => item.message_id === 'mi-admin-1');
  assert.equal(admin.identity_role, 'OWNER');
  assert.equal(admin.direction, 'OUTGOING');
});

test('actual call events are available separately and are never fabricated into messages', async () => {
  const calls = await listCalls(ACCOUNT, DIRECT_CHAT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].call_id, 'mi-call-1');
  assert.equal(calls[0].status, 'missed');
  assert.equal(calls[0].direction, 'INCOMING');
  const stats = await messageStats();
  const stat = stats.find((entry) => entry.account === ACCOUNT);
  assert.equal(stat.calls, 1);
  assert.equal(stat.missedCalls, 1);
});

test('role/domain review is manual, audited and filterable', async () => {
  const saved = await setMessageIntelligence(
    {id: 'admin-reviewer', role: 'ADMIN'},
    {
      account: ACCOUNT,
      chat: DIRECT_CHAT,
      messageId: 'mi-direct-1',
      identityRole: 'ACCOUNTANT',
      businessDomain: 'PAYROLL',
      reviewStatus: 'CORRECTED',
      notes: 'Reviewed against the source message',
    },
  );
  assert.equal(saved.identity_role, 'ACCOUNTANT');
  assert.equal(saved.business_domain, 'PAYROLL');
  const byRole = await listMessages({account: ACCOUNT, role: 'ACCOUNTANT', limit: 10});
  assert.equal(byRole.total, 1);
  assert.equal(byRole.items[0].message_id, 'mi-direct-1');
  const byDomain = await listMessages({account: ACCOUNT, domain: 'PAYROLL', limit: 10});
  assert.equal(byDomain.total, 1);
  const audit = await owner.query(
    "SELECT action FROM audit_events WHERE entity='whatsapp_message' AND entity_id='mi-direct-1' AND action='WHATSAPP_MESSAGE_INTELLIGENCE_UPDATED'",
  );
  assert.ok(audit.rowCount >= 1);
});
