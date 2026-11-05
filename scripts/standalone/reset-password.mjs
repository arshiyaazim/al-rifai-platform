#!/usr/bin/env node
// AL-RIFA'I — operational password reset (Super Admin recovery).
//
// Resets one existing account's password without ever storing or printing a
// plaintext password. The new password is read from the terminal (hidden) or
// from standard input, hashed with the same PBKDF2 policy the web forms use,
// and every existing session of that account is revoked.
//
//   pnpm admin:reset --username Admin
//   printf '%s\n' "$NEW_PASSWORD" | node --experimental-strip-types \
//     scripts/standalone/reset-password.mjs --username Admin --stdin
//
// The account must already exist: this command never creates one, so a typo
// cannot mint a new administrator. Configuration comes from the single `.env`
// at the project root. No password is written to a log, file or audit row.
import {createHash, randomUUID} from 'node:crypto';
import pg from 'pg';
import {loadEnv, secret, setting} from '../../lib/env.mjs';
import {hashPassword} from '../../lib/password-hash.ts';
import {MIN_PASSWORD_LENGTH} from '../../lib/password-policy.ts';

loadEnv();

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const fail = (code, message) => {
  console.error(JSON.stringify({status: 'FAILED', code, message}));
  process.exit(code === 'USER_NOT_FOUND' ? 2 : 1);
};

function askHidden(prompt) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    const stdout = process.stdout;
    stdout.write(prompt);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const finish = (error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      stdout.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk) => {
      for (const char of chunk) {
        if (char === '\r' || char === '\n' || char === '\u0004') return finish();
        if (char === '\u0003') return finish(new Error('CANCELLED'));
        if (char === '\u007f' || char === '\b') {
          value = value.slice(0, -1);
          continue;
        }
        if (char >= ' ') value += char;
      }
    };
    stdin.on('data', onData);
  });
}

async function readPipedPassword() {
  let text = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) text += chunk;
  return text.split(/\r?\n/)[0] ?? '';
}

async function main() {
  const username = (arg('username') ?? setting('ALRIFAI_RESET_USERNAME')).trim();
  if (!username) fail('USERNAME_REQUIRED', 'pass --username <account>');

  let password;
  try {
    if (flag('stdin') || !process.stdin.isTTY) {
      password = await readPipedPassword();
    } else {
      password = await askHidden(`New password for ${username}: `);
      const confirm = await askHidden('Repeat the new password: ');
      if (password !== confirm) fail('PASSWORD_MISMATCH', 'the two entries differ');
    }
  } catch (error) {
    fail('CANCELLED', String(error?.message ?? error));
  }
  if (!password) fail('PASSWORD_REQUIRED', 'no password was supplied');
  if (password.length < MIN_PASSWORD_LENGTH) {
    fail('PASSWORD_TOO_SHORT', `minimum length is ${MIN_PASSWORD_LENGTH}`);
  }

  const client = new pg.Client({
    host: setting('PGHOST'),
    port: Number(setting('PGPORT') || 5432),
    database: setting('PGDATABASE'),
    user: setting('PGUSER'),
    password: secret('PGPASSWORD'),
    application_name: 'al-rifai-password-reset',
  });
  try {
    await client.connect();
  } catch {
    fail('DATABASE_UNREACHABLE', 'check PGHOST / PGDATABASE / PGUSER in .env');
  }

  try {
    const found = await client.query(
      'SELECT id, username, role FROM cash_portal_users WHERE lower(username) = lower($1)',
      [username],
    );
    const account = found.rows[0];
    if (!account) fail('USER_NOT_FOUND', `no account named ${username}`);

    const hash = await hashPassword(password);
    // One transaction: the hash, the session revocation and the audit row are
    // all-or-nothing, so a failure can never leave a half-applied reset.
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE cash_portal_users
          SET password_hash = $2,
              must_change_password = false,
              active = true,
              password_changed_at = now(),
              version = version + 1
        WHERE id = $1`,
      [account.id, hash],
    );
    if (updated.rowCount !== 1) {
      await client.query('ROLLBACK');
      fail('UPDATE_FAILED', 'the account was not updated');
    }

    const revoked = flag('keep-sessions')
      ? {rowCount: 0}
      : await client.query('DELETE FROM cash_portal_sessions WHERE user_id = $1', [account.id]);

    await client.query(
      `INSERT INTO cash_portal_audit (id, actor_id, target_id, action, details)
       VALUES ($1,$2,$3,$4,$5::jsonb)`,
      [
        // The audit table requires a 64-hex identifier.
        createHash('sha256').update(`password-reset:${randomUUID()}`).digest('hex'),
        'operator:cli:reset-password',
        account.id,
        'PASSWORD_RESET',
        JSON.stringify({sessionsRevoked: revoked.rowCount ?? 0, channel: 'CLI'}),
      ],
    );

    await client.query('COMMIT');

    // Only non-secret facts are reported.
    console.log(JSON.stringify({
      status: 'ok',
      username: account.username,
      role: account.role,
      user_id: createHash('sha256').update(account.id).digest('hex').slice(0, 12),
      sessions_revoked: revoked.rowCount ?? 0,
      must_change_password: false,
    }, null, 2));
  } finally {
    await client.end().catch(() => undefined);
  }
}

main().catch((error) => {
  // Never include a password, hash or connection string in the failure output.
  console.error(JSON.stringify({status: 'FAILED', code: 'RESET_FAILED', message: String(error?.message ?? error).slice(0, 200)}));
  process.exit(1);
});
