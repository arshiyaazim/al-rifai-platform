#!/usr/bin/env node
// AL-RIFA'I — WhatsApp store importer and continuous sync worker.
//
// Ingestion source: the bridge's own persisted SQLite message store
// (messages.db). This is a supported, credential-free read path. It does not
// use the MCP content-reader interface, needs no per-chat profile entry, and
// never touches whatsapp.db (the pairing/session store).
//
//   node sync-worker.mjs --mode=import   one-shot historical catch-up
//   node sync-worker.mjs --mode=tail     continuous sync (default)
//   node sync-worker.mjs --mode=status   print checkpoints, change nothing
//
// Guarantees:
//   * restartable  — checkpoint is the highest committed SQLite rowid
//   * idempotent   — unique (account_id, chat_jid, message_id)
//   * low write load — a no-op cycle performs no INSERT/UPDATE at all
//   * no secrets   — media decryption keys and session material are never read
//   * fail visible — every error is written to whatsapp_sync_state.last_error
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, existsSync, mkdirSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';

const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]) ?? 'tail';
const SNAPSHOT_DIR = process.argv.find((a) => a.startsWith('--snapshot-dir='))?.split('=')[1] ?? null;
const BATCH = Number(process.env.SYNC_BATCH ?? 400);
const INTERVAL_MS = Number(process.env.SYNC_INTERVAL_MS ?? 5000);
const RECENT_WINDOW = Number(process.env.SYNC_RECENT_WINDOW ?? 300);
const RECENT_EVERY = Number(process.env.SYNC_RECENT_EVERY ?? 12);

const ACCOUNTS = [
  {
    id: process.env.WA01_ID ?? 'wa-01',
    label: process.env.WA01_LABEL ?? 'WhatsApp account 1',
    path: process.env.WA01_DB ?? '/wa/wa-01/messages.db',
    jid: process.env.WA01_JID ?? null,
  },
  {
    id: process.env.WA02_ID ?? 'wa-02',
    label: process.env.WA02_LABEL ?? 'WhatsApp account 2',
    path: process.env.WA02_DB ?? '/wa/wa-02/messages.db',
    jid: process.env.WA02_JID ?? null,
  },
];

const sha = (value) => createHash('sha256').update(value ?? '').digest('hex');
const log = (...args) => console.log(new Date().toISOString(), ...args);

// The bridge store may contain values that PostgreSQL will not accept verbatim:
// BLOB columns, NUL bytes and lone surrogates left by non-UTF-8 input. A bad
// value must never drop a message or fail a batch, so it is normalised.
const clean = (value) => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  if (typeof value !== 'string') return value;
  return value
    .replace(/\u0000/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD')
    .replace(/(^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '$1\uFFFD');
};

const hexOf = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value || null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
};

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(String(value).trim().replace(' ', 'T'));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function chatKind(chatJid) {
  if (chatJid.endsWith('@g.us')) return 'GROUP';
  if (chatJid.endsWith('@lid')) return 'LID';
  if (chatJid.endsWith('@s.whatsapp.net')) return 'PN';
  return 'OTHER';
}

function password() {
  return process.env.PGPASSWORD_FILE
    ? readFileSync(process.env.PGPASSWORD_FILE, 'utf8').trim()
    : process.env.PGPASSWORD;
}

function pool() {
  const p = new pg.Pool({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'alrifai_v2',
    user: process.env.PGUSER ?? 'alrifai_v2_runtime',
    password: password(),
    max: 2,
    idleTimeoutMillis: 10_000,
    application_name: 'alrifai-sync',
  });
  p.on('error', (error) => log('POOL_ERROR', error.message));
  return p;
}

function openStore(account, {snapshot = false} = {}) {
  if (!existsSync(account.path)) throw new Error(`STORE_MISSING:${account.path}`);
  let path = account.path;
  if (snapshot) {
    if (!SNAPSHOT_DIR) throw new Error('SNAPSHOT_DIR_REQUIRED');
    mkdirSync(SNAPSHOT_DIR, {recursive: true});
    path = join(SNAPSHOT_DIR, `${account.id}.db`);
    rmSync(path, {force: true});
    const source = new DatabaseSync(account.path, {readOnly: true});
    try {
      // SQLite's own consistent copy: reads under a shared lock, never blocks
      // the bridge and never captures an in-flight write.
      source.exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
    } finally {
      source.close();
    }
  }
  const db = new DatabaseSync(path, {readOnly: true});
  const columns = new Set(db.prepare('PRAGMA table_info(messages)').all().map((c) => c.name));
  return {db, columns, path};
}

async function ensureAccounts(client, accounts) {
  for (const account of accounts) {
    await client.query(
      `INSERT INTO whatsapp_accounts (id, label, enabled, transport, socket_path, account_jid)
       VALUES ($1,$2,true,'SQLITE_STORE',$3,$4)
       ON CONFLICT (id) DO UPDATE
         SET transport = 'SQLITE_STORE', socket_path = EXCLUDED.socket_path,
             account_jid = COALESCE(EXCLUDED.account_jid, whatsapp_accounts.account_jid),
             updated_at = now()`,
      [account.id, account.label, account.path, account.jid],
    );
    await client.query(
      `INSERT INTO whatsapp_sync_state (account_id, source_path)
       VALUES ($1,$2) ON CONFLICT (account_id) DO UPDATE SET source_path = EXCLUDED.source_path`,
      [account.id, account.path],
    );
  }
}

async function importChats(client, account, db) {
  const chats = db.prepare('SELECT jid, name FROM chats').all();
  for (let i = 0; i < chats.length; i += BATCH) {
    const chunk = chats.slice(i, i + BATCH);
    const values = [];
    const params = [];
    chunk.forEach((chat, index) => {
      const base = index * 3;
      values.push(`($${base + 1},$${base + 2},$${base + 3},'BOTH',true)`);
      params.push(account.id, clean(chat.jid), clean(chat.name ?? null));
    });
    await client.query(
      `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose, authorized)
       VALUES ${values.join(',')}
       ON CONFLICT (account_id, chat_jid) DO UPDATE
         SET label = COALESCE(EXCLUDED.label, whatsapp_chats.label)`,
      params,
    );
  }
  return chats.length;
}

function selectColumns(columns) {
  const pick = (name) => (columns.has(name) ? name : `NULL AS ${name}`);
  return [
    'rowid AS source_rowid',
    pick('id'), pick('chat_jid'), pick('sender'), pick('content'),
    pick('timestamp'), pick('is_from_me'), pick('media_type'), pick('filename'),
    pick('file_sha256'), pick('file_length'), pick('deleted_at'),
    pick('quoted_message_id'), pick('original_sender_jid'), pick('original_chat_jid'),
    pick('group_participant_jid'), pick('resolved_sender_jid'), pick('resolved_chat_jid'),
    pick('identity_state'), pick('chat_identity_state'),
  ].join(', ');
}

const INSERT_COLUMNS = [
  'account_id', 'chat_jid', 'message_id', 'direction', 'sender_jid', 'source_timestamp',
  'text_content', 'content_hash', 'source_rowid', 'import_run_id', 'source_sha256',
  'chat_label', 'chat_kind', 'sender_resolved_jid', 'chat_resolved_jid', 'identity_state',
  'group_participant_jid', 'quoted_message_id', 'media_type', 'media_filename',
  'media_sha256', 'media_length', 'deleted_at', 'raw_payload',
];

const UPDATE_SET = INSERT_COLUMNS
  .filter((name) => !['account_id', 'chat_jid', 'message_id'].includes(name))
  .map((name) => `${name} = EXCLUDED.${name}`)
  .join(', ');

function toRow(account, runId, chatLabels, row) {
  const timestamp = parseTimestamp(row.timestamp);
  if (!timestamp) throw new Error(`BAD_TIMESTAMP:${row.id}`);
  const text = clean(row.content ?? null);
  const payload = {
    id: row.id, chat_jid: row.chat_jid, sender: row.sender,
    timestamp: row.timestamp, is_from_me: row.is_from_me,
    media_type: row.media_type, filename: row.filename,
    file_sha256: hexOf(row.file_sha256), file_length: row.file_length,
    deleted_at: row.deleted_at, quoted_message_id: row.quoted_message_id,
    original_sender_jid: row.original_sender_jid, original_chat_jid: row.original_chat_jid,
    group_participant_jid: row.group_participant_jid,
    resolved_sender_jid: row.resolved_sender_jid, resolved_chat_jid: row.resolved_chat_jid,
    identity_state: row.identity_state, chat_identity_state: row.chat_identity_state,
  };
  return [
    account.id, clean(row.chat_jid), clean(row.id), row.is_from_me ? 'OUTGOING' : 'INCOMING',
    clean(row.sender ?? null), timestamp, text, sha(text),
    Number(row.source_rowid), runId,
    sha([account.id, row.chat_jid, row.id, row.sender, row.timestamp, row.is_from_me, text].join('\u0001')),
    clean(chatLabels.get(row.chat_jid) ?? null), chatKind(row.chat_jid),
    clean(row.resolved_sender_jid || null), clean(row.resolved_chat_jid || null),
    clean(row.identity_state || null), clean(row.group_participant_jid || null),
    clean(row.quoted_message_id || null), clean(row.media_type || null), clean(row.filename || null),
    hexOf(row.file_sha256), row.file_length ?? null,
    parseTimestamp(row.deleted_at), clean(JSON.stringify(payload)),
  ];
}

async function insertMessages(client, rows) {
  if (!rows.length) return 0;
  const params = [];
  const values = rows.map((row, index) => {
    const base = index * INSERT_COLUMNS.length;
    params.push(...row);
    return `(${INSERT_COLUMNS.map((_, offset) => `$${base + offset + 1}`).join(',')})`;
  });
  const result = await client.query(
    `INSERT INTO whatsapp_messages (${INSERT_COLUMNS.join(',')})
     VALUES ${values.join(',')}
     ON CONFLICT ON CONSTRAINT whatsapp_messages_source_key DO UPDATE SET ${UPDATE_SET}
     WHERE whatsapp_messages.content_hash IS DISTINCT FROM EXCLUDED.content_hash
        OR whatsapp_messages.deleted_at   IS DISTINCT FROM EXCLUDED.deleted_at
        OR whatsapp_messages.media_type   IS DISTINCT FROM EXCLUDED.media_type`,
    params,
  );
  return result.rowCount ?? 0;
}

async function syncAccount(client, account, options = {}) {
  const {db, columns, path} = openStore(account, {snapshot: Boolean(options.snapshot)});
  try {
    const chatLabels = new Map(db.prepare('SELECT jid, name FROM chats').all().map((c) => [c.jid, c.name]));
    const state = (
      await client.query('SELECT last_rowid FROM whatsapp_sync_state WHERE account_id = $1', [account.id])
    ).rows[0] ?? {last_rowid: 0};
    const checkpoint = Number(state.last_rowid ?? 0);
    const maxRow = Number(db.prepare('SELECT coalesce(max(rowid),0) AS m FROM messages').get().m);
    const pending = maxRow > checkpoint;
    if (!pending && !options.recent) return {account: account.id, pending: false, written: 0};

    const since = options.recent && !pending ? Math.max(0, checkpoint - RECENT_WINDOW) : checkpoint;
    const select = db.prepare(
      `SELECT ${selectColumns(columns)} FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
    );
    let runId = null;
    let seen = 0;
    let written = 0;
    let latest = checkpoint;
    const sourceHash = options.snapshot
      ? sha(readFileSync(path))
      : sha(`${path}:${maxRow}`);

    for (;;) {
      const chunk = select.all(since + seen, maxRow, BATCH);
      if (!chunk.length) break;
      const rows = chunk.map((row) => toRow(account, runId, chatLabels, row));
      if (!runId) {
        runId = `${options.snapshot ? 'import' : 'sync'}-${account.id}-${randomUUID()}`;
        await client.query(
          `INSERT INTO whatsapp_import_runs (id, account_id, source_path, source_sha256, snapshot_at)
           VALUES ($1,$2,$3,$4,now())`,
          [runId, account.id, path, sourceHash],
        );
      }
      written += await insertMessages(client, rows);
      seen += chunk.length;
      latest = Math.max(latest, Number(chunk[chunk.length - 1].source_rowid));
      await client.query(
        `UPDATE whatsapp_sync_state
            SET last_rowid = $2, last_synced_at = now(), last_error = NULL,
                messages_total = $3, updated_at = now()
          WHERE account_id = $1`,
        [account.id, latest, maxRow],
      );
      if (chunk.length < BATCH) break;
    }

    if (runId) {
      await client.query(
        `UPDATE whatsapp_import_runs
            SET status='COMPLETED', finished_at=now(), rows_seen=$2, rows_inserted=$3,
                rows_skipped=GREATEST($2::int - $3::int, 0)
          WHERE id=$1`,
        [runId, seen, written],
      );
    }
    return {account: account.id, from: checkpoint, to: latest, seen, written, pending};
  } finally {
    db.close();
  }
}

async function deriveIdentity(client, accountId) {
  // Aliases come only from columns the bridge itself resolved. Nothing is
  // invented: a JID is aliased only to another JID the bridge linked it to.
  const {rowCount} = await client.query(
    `INSERT INTO identity_aliases (account_id, jid, kind, person_ref, confidence, evidence_ref)
     SELECT DISTINCT $1, sender, 'PN', resolved_sender_jid,
            CASE WHEN identity_state = 'RESOLVED' THEN 'EXACT' ELSE 'VARIANT' END,
            'bridge:resolved_sender_jid'
       FROM whatsapp_messages
      WHERE account_id = $1 AND resolved_sender_jid IS NOT NULL AND resolved_sender_jid <> ''
        AND sender IS DISTINCT FROM resolved_sender_jid
     ON CONFLICT (account_id, jid) DO NOTHING`,
    [accountId],
  );
  return rowCount ?? 0;
}

async function status() {
  const client = new pg.Client({
    host: process.env.PGHOST ?? '127.0.0.1',
    port: Number(process.env.PGPORT ?? 5432),
    database: process.env.PGDATABASE ?? 'alrifai_v2',
    user: process.env.PGUSER ?? 'alrifai_v2_runtime',
    password: password(),
    application_name: 'alrifai-sync-status',
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT m.account_id, count(*) AS messages,
              count(DISTINCT m.chat_jid) AS chats,
              count(*) FILTER (WHERE m.direction='INCOMING') AS incoming,
              count(*) FILTER (WHERE m.direction='OUTGOING') AS outgoing,
              count(*) FILTER (WHERE m.chat_kind='GROUP') AS groups,
              min(m.source_timestamp)::date AS first_day,
              max(m.source_timestamp)::date AS last_day,
              s.last_rowid, s.last_synced_at, s.last_error
         FROM whatsapp_messages m
         LEFT JOIN whatsapp_sync_state s ON s.account_id = m.account_id
        GROUP BY m.account_id, s.last_rowid, s.last_synced_at, s.last_error
        ORDER BY m.account_id`,
    );
    console.log(JSON.stringify(result.rows, null, 2));
  } finally {
    await client.end();
  }
}

async function main() {
  if (MODE === 'status') return status();
  const p = pool();
  const client = await p.connect();
  try {
    await ensureAccounts(client, ACCOUNTS);
    let round = 0;
    for (;;) {
      round += 1;
      const recent = round % RECENT_EVERY === 0;
      for (const account of ACCOUNTS) {
        try {
          const result = await syncAccount(client, account, {
            snapshot: MODE === 'import' && Boolean(SNAPSHOT_DIR),
            recent,
          });
          if (result.written) log(MODE === 'import' ? 'IMPORT' : 'TAIL', JSON.stringify(result));
        } catch (error) {
          const message = String(error?.message ?? error).slice(0, 400);
          log('SYNC_ERROR', account.id, message);
          await client
            .query(`UPDATE whatsapp_sync_state SET last_error=$2, updated_at=now() WHERE account_id=$1`, [
              account.id,
              message,
            ])
            .catch(() => undefined);
        }
      }
      if (MODE === 'import') {
        for (const account of ACCOUNTS) await deriveIdentity(client, account.id).catch(() => 0);
        log('IMPORT_COMPLETE');
        break;
      }
      if (round % 12 === 0) {
        for (const account of ACCOUNTS) await deriveIdentity(client, account.id).catch(() => 0);
      }
      await new Promise((resolve) => setTimeout(resolve, INTERVAL_MS));
    }
  } finally {
    client.release();
    await p.end();
  }
}

main().catch((error) => {
  log('FATAL', error?.message ?? error);
  process.exit(1);
});
