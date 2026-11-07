#!/usr/bin/env node
// AL-RIFA'I — provision the two non-Admin application users from .env.
//
//   ALRIFAI_APP_USER_1_USERNAME / _PASSWORD or _PASSWORD_FILE / _NAME
//   ALRIFAI_APP_USER_2_USERNAME / _PASSWORD or _PASSWORD_FILE / _NAME
//
// Role is always USER. The CLI never creates an Admin, never resets a password
// without --reset-password, and never prints a password or hash.
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
const ACTOR = {id: 'system:provision-users', role: 'ADMIN'};
const adminId = (value) => createHash('sha256').update(`cash-user:${value.toLowerCase()}`).digest('hex');

const users = [1, 2].map((index) => ({
  index,
  username: normalizeUsername(setting(`ALRIFAI_APP_USER_${index}_USERNAME`)),
  password: secret(`ALRIFAI_APP_USER_${index}_PASSWORD`),
  displayName: setting(`ALRIFAI_APP_USER_${index}_NAME`) || setting(`ALRIFAI_APP_USER_${index}_USERNAME`),
  role: 'USER',
}));

async function inspect(user) {
  if (!user.username) return {index: user.index, status: 'MISSING_USERNAME', variable: `ALRIFAI_APP_USER_${user.index}_USERNAME`};
  const existing = await row(
    `SELECT id, username, password_hash, role, active FROM cash_portal_users WHERE lower(username)=lower($1)`,
    [user.username],
  );
  return {
    index: user.index,
    username: user.username,
    password_configured: Boolean(user.password),
    account_exists: Boolean(existing),
    role: existing?.role ?? null,
    active: existing?.active ?? null,
    existing,
  };
}

async function main() {
  const states = [];
  for (const user of users) states.push(await inspect(user));

  if (!APPLY) {
    const report = [];
    for (const state of states) {
      const match = state.existing && state.password_configured
        ? await verifyPassword(state.existing ? users[state.index - 1].password : '', state.existing.password_hash)
        : null;
      report.push({...state, existing: undefined, password_matches: match});
    }
    console.log(JSON.stringify({mode: 'check', users: report}, null, 2));
    console.log('Check complete; no account or password was changed. Use --apply after approval.');
    return;
  }

  let failed = false;
  for (const state of states) {
    if (state.status === 'MISSING_USERNAME') {
      console.log(JSON.stringify(state));
      failed = true;
      continue;
    }
    const user = users[state.index - 1];
    if (!user.password) {
      console.log(JSON.stringify({index: user.index, username: user.username, status: 'MISSING_PASSWORD'}));
      failed = true;
      continue;
    }
    if (state.existing) {
      if (state.existing.role !== 'USER') {
        console.log(JSON.stringify({index: user.index, username: user.username, status: 'NOT_A_USER_ACCOUNT'}));
        failed = true;
        continue;
      }
      if (await verifyPassword(user.password, state.existing.password_hash)) {
        console.log(JSON.stringify({index: user.index, username: user.username, status: 'ALREADY_MATCHES'}));
        continue;
      }
      if (!RESET) {
        console.log(JSON.stringify({index: user.index, username: user.username, status: 'PASSWORD_MISMATCH_RESET_REQUIRED'}));
        failed = true;
        continue;
      }
      const hash = await hashBootstrapPassword(user.password);
      await row(
        `UPDATE cash_portal_users SET password_hash=$2, must_change_password=false,
                password_changed_at=now(), version=version+1 WHERE id=$1`,
        [state.existing.id, hash],
      );
      await recordAudit({
        actor: ACTOR,
        action: 'APP_USER_PASSWORD_RESET',
        entity: 'cash_portal_user',
        entityId: state.existing.id,
        detail: {username: user.username, via: 'provision-users', source: 'env_or_secret_file'},
        source: 'SYSTEM',
      });
      console.log(JSON.stringify({index: user.index, username: user.username, status: 'PASSWORD_RESET'}));
      continue;
    }
    const id = adminId(user.username);
    const hash = await hashBootstrapPassword(user.password);
    await row(
      `INSERT INTO cash_portal_users
         (id, username, password_hash, role, display_name, must_change_password, active,
          created_by, capabilities)
       VALUES ($1,$2,$3,'USER',$4,false,true,'provision-users','[]'::jsonb)`,
      [id, user.username, hash, String(user.displayName).slice(0, 150)],
    );
    await recordAudit({
      actor: ACTOR,
      action: 'APP_USER_PROVISIONED',
      entity: 'cash_portal_user',
      entityId: id,
      detail: {username: user.username, via: 'provision-users', source: 'env_or_secret_file'},
      source: 'SYSTEM',
    });
    console.log(JSON.stringify({index: user.index, username: user.username, status: 'USER_CREATED'}));
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'USER_PROVISION_FAILED'}));
  process.exitCode = 1;
});
