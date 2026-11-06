#!/usr/bin/env node
// AL-RIFA'I — manage the effective-dated authorized-contact registry.
//
// Dry-run by default. Example:
//   node ... --account=wa-01 --role=ACCOUNTANT --jid=8801...@s.whatsapp.net \
//     --replace --reason="Owner-approved replacement" --apply
//
// The registry is stored in app_settings.phase3_authorized_contacts:<account>.
// Changing the number never authorizes an observed number automatically.
import {row} from '../../lib/standalone/db.ts';
import {recordAudit} from '../../lib/standalone/audit.ts';
import {normalizeMobile} from '../../lib/business-rules.mjs';

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const APPLY = flag('apply');
const ACTOR = {id: 'system:authorized-contact-cli', role: 'ADMIN'};
const account = arg('account') ?? 'wa-01';
const role = (arg('role') ?? 'ACCOUNTANT').toUpperCase();
const jid = arg('jid') ?? '';
const aliases = (arg('aliases') ?? '').split(',').map((value) => value.trim()).filter(Boolean);
const status = (arg('status') ?? 'ACTIVE').toUpperCase();
const effectiveFrom = arg('effective-from') ?? new Date().toISOString().slice(0, 10);
const effectiveTo = arg('effective-to') ?? null;
const replace = flag('replace');
const reason = arg('reason') ?? 'Owner-approved contact update';

if (!jid) throw new Error('JID_REQUIRED');
if (!['ACTIVE', 'REVOKED'].includes(status)) throw new Error('INVALID_STATUS');
if (!normalizeMobile(jid) && !/@(?:s\.whatsapp\.net|lid|g\.us)$/.test(jid)) {
  throw new Error('INVALID_JID_OR_MOBILE');
}

async function main() {
  const key = `phase3_authorized_contacts:${account}`;
  const existing = await row(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  const contacts = Array.isArray(existing?.value) ? existing.value : [];
  const today = new Date().toISOString().slice(0, 10);
  const next = contacts.map((contact) =>
    replace && contact.role === role && (contact.status ?? 'ACTIVE') === 'ACTIVE'
      ? {...contact, status: 'REPLACED', effectiveTo: today}
      : contact);
  const duplicate = next.some((contact) =>
    contact.role === role && contact.jid === jid && (contact.status ?? 'ACTIVE') === 'ACTIVE');
  const entry = {
    role, jid, aliases, status, effectiveFrom,
    ...(effectiveTo ? {effectiveTo} : {}),
    approvedBy: ACTOR.id, reason,
  };
  if (!duplicate) next.push(entry);
  const summary = {
    account, role, status, replace,
    total: next.length,
    active: next.filter((contact) => (contact.status ?? 'ACTIVE') === 'ACTIVE').length,
    applied: APPLY,
  };
  if (!APPLY) {
    console.log(JSON.stringify(summary, null, 2));
    console.log('Dry run complete; the registry was not changed.');
    return;
  }
  await row(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(next)],
  );
  await recordAudit({
    actor: ACTOR,
    action: 'AUTHORIZED_CONTACT_UPDATED',
    entity: 'authorized_contacts',
    entityId: account,
    detail: {role, status, replace, aliasCount: aliases.length, reason},
    source: 'SYSTEM',
  });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'CONTACT_UPDATE_FAILED'}));
  process.exitCode = 1;
});
