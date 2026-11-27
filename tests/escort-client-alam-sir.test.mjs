import test from 'node:test';
import assert from 'node:assert/strict';
import {OWNER_ESCORT_CLIENTS, scopePhoneAliases} from '../lib/escort-register.mjs';
import {ORDER_INTAKE_JIDS} from '../lib/message-router.ts';

test('the fourth escort client is registered with the Owner-provided identity', () => {
  const client = OWNER_ESCORT_CLIENTS.find((entry) => entry.id === 'escort-client-alam-sir-wa01');
  assert.ok(client);
  assert.equal(client.accountId, 'wa-01');
  assert.equal(client.displayName, 'Escort Alam Sir');
  assert.equal(client.phone, '+8801923008877');
});

test('the PN and LID direct chats are both order-intake', () => {
  assert.equal(ORDER_INTAKE_JIDS.has('8801923008877@s.whatsapp.net'), true);
  assert.equal(ORDER_INTAKE_JIDS.has('94107162673310@lid'), true);
});

test('the LID alias resolves to the same client phone', () => {
  const aliases = scopePhoneAliases([{
    canonical_chat_jid: '8801923008877@s.whatsapp.net',
    alias_chat_jids: ['94107162673310@lid'],
  }]);
  assert.equal(aliases['94107162673310'], '+8801923008877');
});
