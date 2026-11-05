// WhatsApp media crypto and naming — deterministic fixture, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {
  decryptWhatsAppMedia,
  encryptWhatsAppMedia,
  isCapturableMedia,
  mimeFor,
  safeStorageName,
  sanitizeFilename,
  sha256Hex,
  storageExtension,
} from '../../lib/whatsapp-media.mjs';

test('decrypts a payload produced by the WhatsApp media scheme', () => {
  const key = randomBytes(32);
  const plaintext = Buffer.from('AL-RIFAI media fixture \u00e0\u00e9\u00e8', 'utf8');
  const encrypted = encryptWhatsAppMedia(plaintext, key, 'image');
  const decrypted = decryptWhatsAppMedia(encrypted, key, 'image');
  assert.deepEqual(decrypted, plaintext);
  assert.equal(sha256Hex(decrypted), sha256Hex(plaintext));
});

test('supports every capturable media type', () => {
  for (const type of ['image', 'video', 'audio', 'document', 'sticker']) {
    const key = randomBytes(32);
    const plaintext = randomBytes(512);
    const encrypted = encryptWhatsAppMedia(plaintext, key, type);
    assert.deepEqual(decryptWhatsAppMedia(encrypted, key, type), plaintext, type);
    assert.equal(isCapturableMedia(type), true, type);
  }
});

test('rejects a tampered payload and a wrong key', () => {
  const key = randomBytes(32);
  const plaintext = randomBytes(256);
  const encrypted = encryptWhatsAppMedia(plaintext, key, 'image');
  const tampered = Buffer.from(encrypted);
  tampered[0] ^= 0xff;
  assert.throws(() => decryptWhatsAppMedia(tampered, key, 'image'), /MEDIA_MAC_INVALID/);
  assert.throws(() => decryptWhatsAppMedia(encrypted, randomBytes(32), 'image'), /MEDIA_MAC_INVALID/);
});

test('rejects unsupported media and malformed keys', () => {
  assert.equal(isCapturableMedia('reaction'), false);
  assert.throws(() => decryptWhatsAppMedia(Buffer.alloc(32), randomBytes(32), 'reaction'), /MEDIA_TYPE_UNSUPPORTED/);
  assert.throws(() => decryptWhatsAppMedia(Buffer.alloc(32), Buffer.alloc(16), 'image'), /MEDIA_KEY_INVALID/);
});

test('derives MIME type and storage extension without inventing data', () => {
  assert.equal(mimeFor('image', 'photo.jpg'), 'image/jpeg');
  assert.equal(mimeFor('image', 'photo.png'), 'image/png');
  assert.equal(mimeFor('video', 'clip.mp4'), 'video/mp4');
  assert.equal(mimeFor('audio', 'voice.ogg'), 'audio/ogg');
  assert.equal(mimeFor('audio', 'song.mp3'), 'audio/mpeg');
  assert.equal(mimeFor('document', 'invoice.pdf'), 'application/pdf');
  assert.equal(mimeFor('document', 'unknown.bin'), 'application/octet-stream');
  assert.equal(storageExtension('image', 'photo.jpg'), '.jpg');
  assert.equal(storageExtension('document', 'invoice.pdf'), '.pdf');
  assert.equal(storageExtension('document', 'no-extension'), '.bin');
});

test('only a 64-hex digest becomes a filename', () => {
  const digest = 'a'.repeat(64);
  assert.equal(safeStorageName(digest, '.jpg'), `${digest}.jpg`);
  assert.throws(() => safeStorageName('not-a-digest', '.jpg'), /MEDIA_SHA_INVALID/);
  assert.throws(() => safeStorageName(digest, '../x'), /MEDIA_EXTENSION_INVALID/);
});

test('sanitises a display filename', () => {
  assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd');
  assert.equal(sanitizeFilename('report\u0000.pdf'), 'report.pdf');
  assert.equal(sanitizeFilename('   '), null);
});
