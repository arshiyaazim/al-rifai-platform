// Shared WhatsApp identity classification — pure rules, no database.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalPnJid,
  identityConfidence,
  jidKind,
  normalizeAccountJid,
  personKey,
  phoneFromJid,
} from '../../lib/whatsapp-identity.mjs';

test('classifies JIDs by suffix', () => {
  assert.equal(jidKind('8801700000000@s.whatsapp.net'), 'PN');
  assert.equal(jidKind('123456789012345@lid'), 'LID');
  assert.equal(jidKind('120363000000000000@g.us'), 'GROUP');
  assert.equal(jidKind('120363000000000000@newsletter'), 'OTHER');
  assert.equal(jidKind(''), 'OTHER');
});

test('a phone number comes only from a PN JID', () => {
  assert.equal(phoneFromJid('8801700000000@s.whatsapp.net'), '8801700000000');
  assert.equal(phoneFromJid('123456789012345@lid'), null);
  assert.equal(phoneFromJid('120363000000000000@g.us'), null);
  assert.equal(phoneFromJid('not-a-number@s.whatsapp.net'), null);
});

test('device-qualified and bare account identities normalise to a canonical PN', () => {
  assert.equal(canonicalPnJid('8801700000000:27@s.whatsapp.net'), '8801700000000@s.whatsapp.net');
  assert.equal(phoneFromJid('8801700000000:27@s.whatsapp.net'), '8801700000000');
  assert.equal(normalizeAccountJid('8801700000000'), '8801700000000@s.whatsapp.net');
  assert.equal(normalizeAccountJid('8801700000000:27@s.whatsapp.net'), '8801700000000@s.whatsapp.net');
  assert.equal(normalizeAccountJid('123456789012345@lid'), '123456789012345@lid');
  assert.equal(normalizeAccountJid(''), null);
});

test('identity confidence never upgrades an unresolved LID', () => {
  assert.equal(identityConfidence({kind: 'GROUP', displayName: null}), 'EXACT');
  assert.equal(identityConfidence({kind: 'PN', displayName: null}), 'EXACT');
  assert.equal(identityConfidence({kind: 'LID', canonicalJid: '8801700000000@s.whatsapp.net'}), 'EXACT');
  assert.equal(identityConfidence({kind: 'LID', displayName: 'Known name'}), 'VARIANT');
  assert.equal(identityConfidence({kind: 'LID', displayName: null}), 'UNRESOLVED');
  assert.equal(identityConfidence({kind: 'OTHER', displayName: null}), 'UNRESOLVED');
});

test('the person key prefers the canonical JID', () => {
  const canonical = '8801700000000@s.whatsapp.net';
  assert.equal(personKey(canonical, '123456789012345@lid'), canonical);
  assert.equal(personKey(null, '123456789012345@lid'), '123456789012345@lid');
  assert.equal(personKey(null, null), null);
});
