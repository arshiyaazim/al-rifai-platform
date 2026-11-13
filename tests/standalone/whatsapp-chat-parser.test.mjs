import assert from 'node:assert/strict';
import test from 'node:test';
import {parseWhatsAppChat} from '../../lib/whatsapp-chat-parser.ts';

test('12-hour envelope + multiline body', () => {
  const parsed = parseWhatsAppChat('[11/10/26, 2:30:15 PM] Hridoy: BELTOKYO\nSANAM-2\n01752775656');
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].timestamp, '2026-10-11T14:30:15+06:00');
  assert.equal(parsed.messages[0].sender, 'Hridoy');
  assert.equal(parsed.messages[0].body, 'BELTOKYO\nSANAM-2\n01752775656');
});

test('24-hour envelope', () => {
  const parsed = parseWhatsAppChat('[10/11/2026, 14:30:15] Rezaul: MV AFRICAN ISABELLA');
  assert.equal(parsed.messages[0].timestamp, '2026-11-10T14:30:15+06:00');
  assert.equal(parsed.messages[0].sender, 'Rezaul');
});

test('system and media lines are skipped, not imported', () => {
  const parsed = parseWhatsAppChat([
    '[11/10/26, 2:40:00 PM] Hridoy: <Media omitted>',
    '[11/10/26, 2:41:00 PM] Hridoy: Messages and calls are end-to-end encrypted.',
    '[11/10/26, 2:42:00 PM] Hridoy: real order',
  ].join('\n'));
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0].body, 'real order');
  assert.equal(parsed.skipped, 2);
});

test('Bengali digits are normalised', () => {
  const parsed = parseWhatsAppChat('[১১/১০/২৬, ২:৩০:১৫ PM] Hridoy: BELTOKYO');
  assert.equal(parsed.messages[0].timestamp, '2026-10-11T14:30:15+06:00');
});
