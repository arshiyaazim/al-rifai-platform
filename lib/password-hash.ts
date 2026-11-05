/**
 * The one place a credential is turned into a stored hash.
 *
 * Every caller — the login route, the password-change route, the installer and
 * the operational reset CLI — imports these functions, so a hash written by one
 * path always verifies in another. The parameter set and the encoded format
 * (`pbkdf2-sha256:<iterations>:<salt>:<key>`) are fixed here.
 *
 * No secret is stored, logged or returned: only the encoded string is.
 */
import {pbkdf2, randomBytes, timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {isAcceptablePassword, MAX_PASSWORD_BYTES} from './password-policy.ts';

const derive = promisify(pbkdf2);
const ITERATIONS = 600_000;
const SALT_BYTES = 16;
const KEY_BYTES = 32;
const HASH_RE = /^pbkdf2-sha256:600000:[a-f0-9]{32}:[a-f0-9]{64}$/;

async function deriveHash(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES).toString('hex');
  const key = await derive(password, salt, ITERATIONS, KEY_BYTES, 'sha256');
  return `pbkdf2-sha256:${ITERATIONS}:${salt}:${key.toString('hex')}`;
}

/** Hash a password chosen in a form. Enforces the shared length policy. */
export async function hashPassword(password: string): Promise<string> {
  if (!isAcceptablePassword(password)) throw new Error('PASSWORD_POLICY');
  return deriveHash(password);
}

/**
 * Hash a password supplied by the installer or an operator. The same algorithm
 * and format as hashPassword; the only difference is that the caller may have
 * its own validation path, so this checks the byte limit explicitly.
 */
export async function hashBootstrapPassword(password: string): Promise<string> {
  if (
    typeof password !== 'string' ||
    password.length < 8 ||
    Buffer.byteLength(password) > MAX_PASSWORD_BYTES
  ) {
    throw new Error('BOOTSTRAP_PASSWORD_POLICY');
  }
  return deriveHash(password);
}

/** Constant-time verification of a candidate password against a stored hash. */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  if (
    typeof password !== 'string' ||
    Buffer.byteLength(password) > MAX_PASSWORD_BYTES ||
    !HASH_RE.test(encoded)
  ) {
    return false;
  }
  const [, iterations, salt, expected] = encoded.split(':');
  const key = await derive(password, salt, Number(iterations), KEY_BYTES, 'sha256');
  return timingSafeEqual(key, Buffer.from(expected, 'hex'));
}
