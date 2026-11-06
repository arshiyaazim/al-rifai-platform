#!/usr/bin/env node
// AL-RIFA'I — WA-01 business activation from the protected Owner artifact.
//
// Dry-run by default. It never prints chat JIDs, participant JIDs or phone
// numbers. `--apply` requires an explicit continuity watermark and writes the
// allowlists while keeping the router itself disabled; enabling the router is a
// separate Gate 2 step.
//
//   node --experimental-strip-types scripts/standalone/wa01-activation.mjs \
//     --file=/var/lib/vps/al-rifai/private/phase3_activation_data.proposed.json \
//     --watermark=19634
//   node ... --apply --watermark=19634
//
// The watermark is never derived from the current maximum at apply time.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';

loadEnv();

class ActivationError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const flag = (name) => process.argv.includes(`--${name}`);

function connection() {
  const host = (process.env.PGHOST ?? '').trim();
  const database = (process.env.PGDATABASE ?? '').trim();
  const port = Number((process.env.PGPORT ?? '5432').trim());
  const schema = (process.env.PGSCHEMA ?? 'public').trim() || 'public';
  const user = (process.env.PGUSER ?? '').trim();
  if (!host || !database || !user) throw new ActivationError('DATABASE_CONFIG_MISSING');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ActivationError('DATABASE_CONFIG_INVALID:PGPORT');
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new ActivationError('DATABASE_CONFIG_INVALID:PGSCHEMA');
  const password = secret('PGPASSWORD');
  if (!password) throw new ActivationError('DATABASE_CONFIG_MISSING:PGPASSWORD');
  return {host, database, port, schema, user, password};
}

function stableId(prefix, parts) {
  return `${prefix}-${createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40)}`;
}

function validateArtifact(artifact) {
  const chats = [
    ...(artifact.cash?.direct_chats ?? []),
    ...(artifact.vessel?.direct_chats ?? []),
    ...(artifact.vessel?.groups ?? []),
  ];
  const participants = artifact.vessel?.participants ?? [];
  const wa02Chats = artifact.accounts?.['wa-02']?.business_chats ?? artifact.business_chats_wa02 ?? [];
  const wa01Business = artifact.business_chats_wa01 ?? [];

  if (!Array.isArray(chats) || chats.length !== 7) throw new ActivationError('ARTIFACT_CHAT_COUNT', String(chats.length));
  if (!Array.isArray(participants) || participants.length !== 26) {
    throw new ActivationError('ARTIFACT_PARTICIPANT_COUNT', String(participants.length));
  }
  if (wa02Chats.length !== 0) throw new ActivationError('ARTIFACT_WA02_SCOPE_NOT_EMPTY');
  if (wa01Business.length !== 9) throw new ActivationError('ARTIFACT_WA01_ALLOWLIST_COUNT', String(wa01Business.length));
  if (!String(artifact.status ?? '').startsWith('PROPOSED') && artifact.status !== 'APPROVED') {
    throw new ActivationError('ARTIFACT_STATUS_NOT_APPROVABLE', String(artifact.status));
  }
  const rows = [];
  for (const chat of chats) {
    if (chat.account_id !== 'wa-01') throw new ActivationError('ARTIFACT_FOREIGN_ACCOUNT');
    const chatJid = chat.chat_jid ?? chat.group_jid;
    if (!chatJid) throw new ActivationError('ARTIFACT_CHAT_JID_MISSING');
    if (!['CASH', 'ORDERS', 'BOTH'].includes(chat.purpose)) throw new ActivationError('ARTIFACT_PURPOSE_INVALID');
    rows.push({account_id: 'wa-01', chat_jid: chatJid, label: chat.display_name ?? null, purpose: chat.purpose});
    if (chat.alias_lid) {
      rows.push({account_id: 'wa-01', chat_jid: chat.alias_lid, label: chat.display_name ?? null, purpose: chat.purpose});
    }
  }
  const allow = new Set(wa01Business);
  const coverage = new Set(rows.map((entry) => entry.chat_jid));
  if (coverage.size !== allow.size || [...coverage].some((jid) => !allow.has(jid))) {
    throw new ActivationError('ARTIFACT_ALLOWLIST_MISMATCH');
  }
  for (const participant of participants) {
    if (participant.account_id !== 'wa-01') throw new ActivationError('ARTIFACT_FOREIGN_PARTICIPANT');
    const group = chats.some((chat) => (chat.chat_jid ?? chat.group_jid) === participant.group_jid);
    if (!group) throw new ActivationError('ARTIFACT_PARTICIPANT_GROUP_NOT_ALLOWLISTED');
  }
  return {chats: rows, participants, wa01Business, wa02Chats};
}

async function main() {
  const file = arg('file') ?? '/var/lib/vps/al-rifai/private/phase3_activation_data.proposed.json';
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ActivationError('ARTIFACT_UNREADABLE', String(error.message).slice(0, 200));
  }
  const {chats, participants, wa01Business, wa02Chats} = validateArtifact(artifact);

  const watermarkRaw = arg('watermark');
  const watermark = Number(watermarkRaw);
  if (!Number.isSafeInteger(watermark) || watermark < 0) {
    throw new ActivationError('WATERMARK_REQUIRED', 'pass an explicit --watermark=<non-negative integer>');
  }

  const config = connection();
  const client = new pg.Client({...config, application_name: 'al-rifai-wa01-activation'});
  await client.connect();
  try {
    await client.query(`SET search_path TO "${config.schema}"`);
    const sync = await client.query(
      'SELECT account_id, last_rowid FROM whatsapp_sync_state ORDER BY account_id',
    );
    const byAccount = new Map(sync.rows.map((entry) => [entry.account_id, String(entry.last_rowid ?? '')]));
    if (!byAccount.has('wa-01') || !byAccount.has('wa-02')) {
      throw new ActivationError('SYNC_ACCOUNTS_INCOMPLETE', [...byAccount.keys()].join(','));
    }
    const wa01Max = BigInt(byAccount.get('wa-01'));
    if (BigInt(watermark) > wa01Max) {
      throw new ActivationError('WATERMARK_ABOVE_BRIDGE_MAX', `${watermark} > ${wa01Max}`);
    }
    const pending = await client.query(
      `SELECT count(*)::int AS n
         FROM whatsapp_messages m
        WHERE m.account_id = 'wa-01'
          AND m.processing_status = 'PENDING'
          AND m.source_rowid IS NOT NULL
          AND m.source_rowid > $1
          AND m.chat_jid = ANY($2::text[])`,
      [watermark, wa01Business],
    );
    const plan = {
      step: 'plan',
      database: config.database,
      chats: chats.length,
      participants: participants.length,
      wa01BusinessChats: wa01Business.length,
      wa02BusinessChats: wa02Chats.length,
      watermark,
      bridgeMaxWa01: String(wa01Max),
      pendingAuthorized: pending.rows[0]?.n ?? 0,
      apply: flag('apply'),
    };
    console.log(JSON.stringify(plan, null, 2));
    if (!flag('apply')) {
      console.log('dry run complete; nothing was changed. Re-run with --apply --watermark=<approved>.');
      return;
    }

    await client.query('BEGIN');
    for (const chat of chats) {
      await client.query(
        `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
         VALUES ($1,$2,$3,$4,true)
         ON CONFLICT (account_id, chat_jid) DO UPDATE
           SET label=EXCLUDED.label, purpose=EXCLUDED.purpose, authorized=true`,
        [chat.account_id, chat.chat_jid, chat.display_name ?? null, chat.purpose],
      );
    }
    for (const participant of participants) {
      const participantJid = participant.phase3_match_form ?? participant.canonical_jid ?? participant.participant_jid;
      await client.query(
        `INSERT INTO escort_client_group_authorizations
           (id, account_id, group_jid, participant_jid, client_contact_id, active)
         VALUES ($1,$2,$3,$4,$5,true)
         ON CONFLICT (id) DO UPDATE SET participant_jid=EXCLUDED.participant_jid, active=true`,
        [
          stableId('wga', [participant.account_id, participant.group_jid, participantJid, participant.client_contact_id]),
          participant.account_id, participant.group_jid, participantJid, participant.client_contact_id,
        ],
      );
    }
    const adminJids = artifact.cash?.admin_jids_recommended ?? artifact.accounts?.['wa-01']?.admin_jids_recommended ?? [];
    await client.query(
      `UPDATE whatsapp_accounts SET admin_jids=$1::jsonb, updated_at=now() WHERE id='wa-01'`,
      [JSON.stringify(adminJids)],
    );
    const settings = [
      ['phase3_business_chats:wa-01', JSON.stringify(wa01Business)],
      ['phase3_business_chats:wa-02', JSON.stringify(wa02Chats)],
      ['phase3_cutover_rowid:wa-01', JSON.stringify(watermark)],
      ['phase3_cutover_rowid:wa-02', JSON.stringify(Number(byAccount.get('wa-02')) || 0)],
      // The router stays disabled until the separate Gate 2 activation step.
      ['phase3_router_enabled', 'false'],
    ];
    for (const [key, value] of settings) {
      await client.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ($1,$2::jsonb,now())
         ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [key, value],
      );
    }
    await client.query('COMMIT');
    console.log(JSON.stringify({step: 'applied', routerEnabled: false, chats: chats.length,
      participants: participants.length, watermark}, null, 2));
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAILED',
    code: error?.code ?? 'ACTIVATION_FAILED',
    message: String(error?.message ?? error).slice(0, 300),
  }));
  process.exitCode = 1;
});
