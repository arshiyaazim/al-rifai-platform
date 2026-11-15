// AES-256-GCM encryption for secrets stored in PostgreSQL (API keys).
//
// The master key lives only in the environment (`AI_KEY_ENCRYPTION_KEY`,
// base64-encoded 32 bytes). Stored values carry a version prefix so plaintext
// legacy rows remain readable and new rows are unambiguously encrypted.
//
// This module is server-only: it reads process.env and uses node:crypto.

import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';

const PREFIX = 'enc:v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

function masterKey(): Buffer {
  const raw = (process.env.AI_KEY_ENCRYPTION_KEY ?? '').trim();
  if (!raw) throw new Error('AI_KEY_ENCRYPTION_KEY_MISSING');
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('AI_KEY_ENCRYPTION_KEY_INVALID');
  return key;
}

/** Encrypt a secret. Returns `enc:v1:<base64(iv|tag|ciphertext)>`. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/**
 * Decrypt a stored secret. Plaintext (legacy) values are returned unchanged so
 * existing rows keep working until they are re-saved.
 */
export function decryptSecret(stored: string | null | undefined): string {
  const value = String(stored ?? '');
  if (!isEncrypted(value)) return value;
  const body = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (body.length <= IV_BYTES + TAG_BYTES) throw new Error('AI_KEY_CIPHERTEXT_INVALID');
  const iv = body.subarray(0, IV_BYTES);
  const tag = body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = body.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', masterKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/** Decrypt when possible; never throw during a read-only listing. */
export function safeDecryptSecret(stored: string | null | undefined): string {
  try {
    return decryptSecret(stored);
  } catch {
    return '';
  }
}
