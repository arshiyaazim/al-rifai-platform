/**
 * One password-length rule for every surface that sets a credential.
 *
 * It lives in its own module so the server routes, the hashing function and the
 * three client forms cannot drift apart. Owner direction (2026-11-03): the
 * minimum is 8 characters, applied to self-service changes, admin resets and
 * account creation alike.
 *
 * This file has no Node imports on purpose: it is bundled into client
 * components as well as imported by the server, so it uses TextEncoder rather
 * than Buffer.
 */
export const MIN_PASSWORD_LENGTH = 8;

/**
 * Upper bound on the stored input. The PBKDF2 derivation runs 600k iterations,
 * so an arbitrarily long body would be a cheap denial-of-service lever.
 */
export const MAX_PASSWORD_BYTES = 256;

/** True when a candidate password satisfies the length and byte-size limits. */
export function isAcceptablePassword(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length >= MIN_PASSWORD_LENGTH &&
    new TextEncoder().encode(value).length <= MAX_PASSWORD_BYTES
  );
}
