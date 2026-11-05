// AL-RIFA'I — WhatsApp media crypto and naming helpers.
//
// Pure functions only: no filesystem, no network, no configuration. The sync
// worker uses them to turn the bridge's persisted media metadata back into the
// original bytes; the tests exercise them with a generated fixture.
//
// WhatsApp media encryption (standard, per-message):
//   key  = 32-byte media key stored with the message
//   info = media-type-specific HKDF label
//   HKDF-SHA256(ikm=key, salt=32 zero bytes, info=label, 112 bytes) =>
//     iv (16) | cipherKey (32) | macKey (32) | refKey (32)
//   file = AES-256-CBC(cipherKey, iv, plaintext) || HMAC-SHA256(macKey, iv||ciphertext)[0..10]
//
// Nothing secret is returned by a helper that could log it: callers receive the
// decrypted bytes or a stable error code.
import {createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, timingSafeEqual} from 'node:crypto';

const MEDIA_TYPES = {
  image: {label: 'WhatsApp Image Keys', mime: 'image/jpeg', extension: '.jpg'},
  video: {label: 'WhatsApp Video Keys', mime: 'video/mp4', extension: '.mp4'},
  audio: {label: 'WhatsApp Audio Keys', mime: 'audio/ogg', extension: '.ogg'},
  document: {label: 'WhatsApp Document Keys', mime: 'application/octet-stream', extension: '.bin'},
  sticker: {label: 'WhatsApp Image Keys', mime: 'image/webp', extension: '.webp'},
  ptv: {label: 'WhatsApp Video Keys', mime: 'video/mp4', extension: '.mp4'},
};

const DOCUMENT_MIME = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
  '.zip': 'application/zip',
  '.rar': 'application/vnd.rar',
  '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.amr': 'audio/amr',
};

/** Media types this pipeline can decrypt. Reactions are not media. */
export function mediaTypeInfo(type) {
  return MEDIA_TYPES[String(type ?? '').toLowerCase()] ?? null;
}

/** True when the bridge media_type carries downloadable content. */
export function isCapturableMedia(type) {
  return mediaTypeInfo(type) !== null;
}

function extensionOf(filename) {
  const match = /(\.[A-Za-z0-9]{1,8})$/.exec(String(filename ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

/**
 * MIME type for storage. Images/video/audio/sticker use the canonical type for
 * their WhatsApp category; documents prefer the filename extension and fall
 * back to the generic binary type.
 */
export function mimeFor(mediaType, filename) {
  const spec = mediaTypeInfo(mediaType);
  if (!spec) return 'application/octet-stream';
  if (String(mediaType).toLowerCase() === 'document') {
    return DOCUMENT_MIME[extensionOf(filename)] ?? spec.mime;
  }
  if (String(mediaType).toLowerCase() === 'audio') {
    const byName = DOCUMENT_MIME[extensionOf(filename)];
    if (byName && byName.startsWith('audio/')) return byName;
  }
  if (String(mediaType).toLowerCase() === 'image') {
    const ext = extensionOf(filename);
    if (ext === '.png') return 'image/png';
    if (ext === '.webp') return 'image/webp';
  }
  return spec.mime;
}

/**
 * Storage extension. Documents keep a safe original extension so a download
 * opens with the right application; everything else uses the canonical one.
 */
export function storageExtension(mediaType, filename) {
  const spec = mediaTypeInfo(mediaType);
  if (!spec) return '.bin';
  if (String(mediaType).toLowerCase() === 'document') {
    const ext = extensionOf(filename);
    if (/^\.[a-z0-9]{1,8}$/.test(ext)) return ext;
  }
  return spec.extension;
}

/**
 * Expand a media key into the four derived values. Exported so tests can build
 * a fixture with the same derivation the decryptor uses.
 */
export function expandMediaKey(mediaKey, mediaType) {
  const spec = mediaTypeInfo(mediaType);
  if (!spec) throw new Error('MEDIA_TYPE_UNSUPPORTED');
  const key = Buffer.from(mediaKey ?? []);
  if (key.length !== 32) throw new Error('MEDIA_KEY_INVALID');
  const expanded = Buffer.from(hkdfSync('sha256', key, Buffer.alloc(32), Buffer.from(spec.label), 112));
  return {
    spec,
    iv: expanded.subarray(0, 16),
    cipherKey: expanded.subarray(16, 48),
    macKey: expanded.subarray(48, 80),
    refKey: expanded.subarray(80, 112),
  };
}

/**
 * Decrypt one WhatsApp media payload. The trailing 10 bytes are the MAC over
 * `iv || ciphertext`; a mismatch means the payload is corrupt or the key is
 * wrong, and the caller must not store the result.
 */
export function decryptWhatsAppMedia(encrypted, mediaKey, mediaType) {
  const payload = Buffer.from(encrypted ?? []);
  if (payload.length <= 10) throw new Error('MEDIA_PAYLOAD_TOO_SHORT');
  const {iv, cipherKey, macKey} = expandMediaKey(mediaKey, mediaType);
  const ciphertext = payload.subarray(0, payload.length - 10);
  const receivedMac = payload.subarray(payload.length - 10);
  const expectedMac = createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);
  if (!timingSafeEqual(receivedMac, expectedMac)) throw new Error('MEDIA_MAC_INVALID');
  const decipher = createDecipheriv('aes-256-cbc', cipherKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/**
 * Encrypt a plaintext with the same scheme. Only the test fixture uses this;
 * production code never re-encrypts or rewrites WhatsApp media.
 */
export function encryptWhatsAppMedia(plaintext, mediaKey, mediaType) {
  const {iv, cipherKey, macKey} = expandMediaKey(mediaKey, mediaType);
  const cipher = createCipheriv('aes-256-cbc', cipherKey, iv);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
  const mac = createHmac('sha256', macKey)
    .update(Buffer.concat([iv, ciphertext]))
    .digest()
    .subarray(0, 10);
  return Buffer.concat([ciphertext, mac]);
}

export function sha256Hex(value) {
  return createHash('sha256').update(value ?? '').digest('hex');
}

/** Only a 64-hex digest may become a filename; anything else is refused. */
export function safeStorageName(sha256, extension) {
  const digest = String(sha256 ?? '');
  if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('MEDIA_SHA_INVALID');
  const ext = String(extension ?? '');
  if (!/^\.[a-z0-9]{1,8}$/.test(ext)) throw new Error('MEDIA_EXTENSION_INVALID');
  return `${digest}${ext}`;
}

/** Strip path components and control characters from a display filename. */
export function sanitizeFilename(filename) {
  const raw = String(filename ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!raw) return null;
  const base = raw.split(/[\\/]/).pop() ?? '';
  return base.slice(0, 255) || null;
}
