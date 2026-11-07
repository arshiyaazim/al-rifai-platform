#!/usr/bin/env node
// AL-RIFA'I — explicit Admin provisioning / reconciliation.
//
// Reads the intended bootstrap identity from .env:
//   ALRIFAI_BOOTSTRAP_ADMIN_USERNAME
//   ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD  (or _FILE)
//   ALRIFAI_BOOTSTRAP_ADMIN_NAME
//
// Dry-run/check is the default. `--apply` creates a missing Admin or verifies
// an existing password. `--reset-password` is required to overwrite an existing
// Admin password. This command is never run automatically at application
// startup, so a restart cannot silently reset a credential.
import {createHash} from 'node:crypto';
import {loadEnv, secret, setting} from '../../lib/env.mjs';
import {row} from '../../lib/standalone/db.ts';
import {recordAudit} from '../../lib/standalone/audit.ts';
import {hashBootstrapPassword, verifyPassword} from '../../lib/password-hash.ts';
import {normalizeUsername} from '../../lib/unified-auth-policy.ts';

loadEnv();

const flag = (name) => process.argv.includes(`--${name}`);
const APPLY = flag('apply');
const RESET = flag('reset-password');
const ACTOR = {id: 'system:provision-admin', role: 'ADMIN'};
const username = normalizeUsername(setting('ALRIFAI_BOOTSTRAP_ADMIN_USERNAME'));
const password = secret('ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD');
const displayName = setting('ALRIFAI_BOOTSTRAP_ADMIN_NAME') || username;
const adminId = (value) => createHash('sha256').update(`cash-user:${value.toLowerCase()}`).digest('hex');

async function main() {
  const passwordConfigured = Boolean(password);
  if (!username) {
    console.log(JSON.stringify({status: 'MISSING_USERNAME', variable: 'ALRIFAI_BOOTSTRAP_ADMIN_USERNAME'}, null, 2));
    process.exitCode = 1;
    return;
  }
  const existing = await row(
    `SELECT id, username, password_hash, role, active, must_change_password
       FROM cash_portal_users WHERE lower(username) = lower($1)`,
    [username],
  );
  const base = {
    username,
    password_configured: passwordConfigured,
    password_source: passwordConfigured ? 'env_or_secret_file' : 'missing',
    account_exists: Boolean(existing),
    role: existing?.role ?? null,
    active: existing?.active ?? null,
  };

  if (!APPLY) {
    const match = existing && passwordConfigured
      ? await verifyPassword(password, existing.password_hash)
      : null;
    console.log(JSON.stringify({...base, password_matches: match, apply: false}, null, 2));
    console.log('Check complete; no account or password was changed. Use --apply to provision.');
    return;
  }

  if (!passwordConfigured) {
    console.log(JSON.stringify({...base, status: 'MISSING_PASSWORD'}, null, 2));
    console.log('Set ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD or ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD_FILE securely, then re-run --apply.');
    process.exitCode = 1;
    return;
  }

  if (existing) {
    if (existing.role !== 'ADMIN') {
      console.log(JSON.stringify({...base, status: 'NOT_ADMIN_ACCOUNT'}, null, 2));
      process.exitCode = 1;
      return;
    }
    if (await verifyPassword(password, existing.password_hash)) {
      console.log(JSON.stringify({...base, status: 'ALREADY_MATCHES', changed: false}, null, 2));
      return;
    }
    if (!RESET) {
      console.log(JSON.stringify({...base, status: 'PASSWORD_MISMATCH_RESET_REQUIRED'}, null, 2));
      console.log('The account exists with a different password. Re-run with --reset-password only after approval.');
      process.exitCode = 1;
      return;
    }
    const hash = await hashBootstrapPassword(password);
    await row(
      `UPDATE cash_portal_users
          SET password_hash=$2, must_change_password=false,
              password_changed_at=now(), version=version+1
        WHERE id=$1`,
      [existing.id, hash],
    );
    await recordAudit({
      actor: ACTOR,
      action: 'ADMIN_PASSWORD_RESET',
      entity: 'cash_portal_user',
      entityId: existing.id,
      detail: {username, via: 'provision-admin', source: 'env_or_secret_file'},
      source: 'SYSTEM',
    });
    console.log(JSON.stringify({...base, status: 'PASSWORD_RESET', changed: true}, null, 2));
    return;
  }

  const id = adminId(username);
  const hash = await hashBootstrapPassword(password);
  await row(
    `INSERT INTO cash_portal_users
       (id, username, password_hash, role, display_name, must_change_password, active,
        created_by, capabilities)
     VALUES ($1,$2,$3,'ADMIN',$4,false,true,'provision-admin','["workspace.admin"]'::jsonb)`,
    [id, username, hash, String(displayName).slice(0, 150)],
  );
  await recordAudit({
    actor: ACTOR,
    action: 'ADMIN_PROVISIONED',
    entity: 'cash_portal_user',
    entityId: id,
    detail: {username, via: 'provision-admin', source: 'env_or_secret_file'},
    source: 'SYSTEM',
  });
  console.log(JSON.stringify({...base, status: 'ADMIN_CREATED', changed: true}, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'ADMIN_PROVISION_FAILED'}));
  process.exitCode = 1;
});
