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
//   * no secrets   — media keys are used in memory only; session material is
//                    never read and nothing secret is written to PostgreSQL
//   * fail visible — every error is written to whatsapp_sync_state.last_error
//
// Phase 2 adds:
//   * identity evidence for accounts, chats, participants and PN/LID links
//   * new-media capture: the bridge stores the media URL + key + plaintext
//     hash; this worker downloads, decrypts, verifies and stores the bytes in
//     the persistent media directory. It never downloads historical media
//     during --mode=import, and it never writes to the bridge SQLite stores.
import {createHash, randomUUID} from 'node:crypto';
import {readFileSync, existsSync, mkdirSync, rmSync, writeFileSync, chmodSync, chownSync, renameSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {loadEnv, secret, setting} from '../lib/env.mjs';
import {
  decryptWhatsAppMedia,
  isCapturableMedia,
  mimeFor,
  safeStorageName,
  sanitizeFilename,
  sha256Hex,
  storageExtension,
} from '../lib/whatsapp-media.mjs';
import {canonicalPnJid, identityConfidence, jidKind, normalizeAccountJid, personKey} from '../lib/whatsapp-identity.mjs';

// The one configuration source: `.env` at the project root. Inside a container
// the same keys arrive as environment variables, which always take precedence.
loadEnv();

const MODE = (process.argv.find((a) => a.startsWith('--mode='))?.split('=')[1]) ?? 'tail';
const SNAPSHOT_DIR = process.argv.find((a) => a.startsWith('--snapshot-dir='))?.split('=')[1] ?? null;
const BATCH = Number(setting('SYNC_BATCH') || 400);
const INTERVAL_MS = Number(setting('SYNC_INTERVAL_MS') || 5000);
const RECENT_WINDOW = Number(setting('SYNC_RECENT_WINDOW') || 300);
const RECENT_EVERY = Number(setting('SYNC_RECENT_EVERY') || 12);
const IDENTITY_EVERY = Number(setting('SYNC_IDENTITY_EVERY') || RECENT_EVERY);

// Media capture. Disabled with ALRIFAI_MEDIA_ENABLED=0; the storage directory
// is a persistent host volume, never the Git checkout or the image.
const MEDIA_ENABLED = (setting('ALRIFAI_MEDIA_ENABLED') || '1') !== '0';
const MEDIA_DIR = setting('ALRIFAI_MEDIA_DIR') || '/media';
const MEDIA_MAX_BYTES = Number(setting('ALRIFAI_MEDIA_MAX_BYTES') || 25 * 1024 * 1024);
const MEDIA_TIMEOUT_MS = Number(setting('ALRIFAI_MEDIA_TIMEOUT_MS') || 20_000);
const MEDIA_RETRY_LIMIT = Number(setting('ALRIFAI_MEDIA_RETRY_LIMIT') || 20);
const MEDIA_UID = Number(setting('ALRIFAI_MEDIA_UID') || 10001);
const MEDIA_GID = Number(setting('ALRIFAI_MEDIA_GID') || 10001);

const ACCOUNTS = [
  {
    id: setting('WA01_ID') || 'wa-01',
    label: setting('WA01_LABEL') || 'WhatsApp account 1',
    path: setting('WA01_DB') || '/wa/wa-01/messages.db',
    jid: setting('WA01_JID') || null,
  },
  {
    id: setting('WA02_ID') || 'wa-02',
    label: setting('WA02_LABEL') || 'WhatsApp account 2',
    path: setting('WA02_DB') || '/wa/wa-02/messages.db',
    jid: setting('WA02_JID') || null,
  },
];

// The worker writes with the least-privilege runtime role, never the owner.
const DB_USER = setting('SYNC_DB_USER') || setting('ALRIFAI_REVIEW_DB_USER');
const DB_PASSWORD = secret('SYNC_DB_PASSWORD') || secret('ALRIFAI_REVIEW_PASSWORD');

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

function password() {
  return DB_PASSWORD || process.env.PGPASSWORD;
}

function pool() {
  const p = new pg.Pool({
    host: setting('PGHOST') || '127.0.0.1',
    port: Number(setting('PGPORT') || 5432),
    database: setting('PGDATABASE') || 'alrifai_v2',
    user: DB_USER || 'alrifai_v2_runtime',
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
    // Media keys stay in the bridge store. They are read here, used in memory
    // and never inserted into PostgreSQL or logged.
    pick('url'), pick('media_key'), pick('file_enc_sha256'),
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
    clean(chatLabels.get(row.chat_jid) ?? null), jidKind(row.chat_jid),
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

// ─────────────────────────────────────────────────── media capture ──

function bestEffortOwner(path) {
  try {
    chownSync(path, MEDIA_UID, MEDIA_GID);
  } catch {
    // Not running as root, or the host already owns the path. The app only
    // needs readable files; the container runs as root here, so this normally
    // applies.
  }
}

function ensureMediaRoot(accountId) {
  mkdirSync(MEDIA_DIR, {recursive: true, mode: 0o700});
  chmodSync(MEDIA_DIR, 0o700);
  bestEffortOwner(MEDIA_DIR);
  const dir = join(MEDIA_DIR, accountId);
  mkdirSync(dir, {recursive: true, mode: 0o700});
  chmodSync(dir, 0o700);
  bestEffortOwner(dir);
  return dir;
}

function persistMedia(accountId, digest, extension, bytes) {
  const dir = ensureMediaRoot(accountId);
  const name = safeStorageName(digest, extension);
  const finalPath = join(dir, name);
  if (!existsSync(finalPath)) {
    const tmp = `${finalPath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(tmp, bytes, {mode: 0o600});
    chmodSync(tmp, 0o600);
    bestEffortOwner(tmp);
    renameSync(tmp, finalPath);
  }
  return `${accountId}/${name}`;
}

function mediaErrorCode(error) {
  const message = String(error?.message ?? error ?? '');
  if (/^MEDIA_[A-Z_]+$/.test(message)) return message;
  if (message === 'The operation was aborted.') return 'MEDIA_TIMEOUT';
  const http = /^MEDIA_HTTP_(\d{3})$/.exec(message);
  if (http) return `MEDIA_HTTP_${http[1]}`;
  if (/fetch failed|ENOTFOUND|ECONN|ETIMEDOUT/i.test(message)) return 'MEDIA_NETWORK';
  return 'MEDIA_CAPTURE_FAILED';
}

async function downloadEncrypted(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), MEDIA_TIMEOUT_MS);
  try {
    const response = await fetch(url, {signal: controller.signal, redirect: 'follow'});
    if (!response.ok) throw new Error(`MEDIA_HTTP_${response.status}`);
    const declared = Number(response.headers.get('content-length') || 0);
    if (declared > MEDIA_MAX_BYTES + 10) throw new Error('MEDIA_TOO_LARGE');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MEDIA_MAX_BYTES + 10) throw new Error('MEDIA_TOO_LARGE');
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}

async function recordMedia(client, account, row, {status, error = null, storagePath = '', digest = null, bytes = 0}) {
  const messageId = clean(row.id);
  const chatJid = clean(row.chat_jid);
  const type = clean(String(row.media_type ?? '').toLowerCase());
  const filename = sanitizeFilename(clean(row.filename ?? ''));
  await client.query(
    `INSERT INTO whatsapp_media
       (account_id, chat_jid, message_id, media_type, mime_type, filename,
        byte_length, sha256, storage_path, status, error, captured_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now(),now())
     ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE SET
       media_type = EXCLUDED.media_type,
       mime_type = EXCLUDED.mime_type,
       filename = EXCLUDED.filename,
       byte_length = EXCLUDED.byte_length,
       sha256 = EXCLUDED.sha256,
       storage_path = EXCLUDED.storage_path,
       status = EXCLUDED.status,
       error = EXCLUDED.error,
       updated_at = now()`,
    [
      account.id, chatJid, messageId, type,
      mimeFor(type, filename), filename,
      bytes, digest, storagePath, status, error,
    ],
  );
}

async function captureMedia(client, account, row) {
  const type = String(row.media_type ?? '').toLowerCase();
  if (!isCapturableMedia(type)) return 'SKIPPED';
  const digest = hexOf(row.file_sha256);
  if (!digest || !/^[a-f0-9]{64}$/.test(digest)) return 'SKIPPED';

  const existing = (
    await client.query(
      `SELECT status, sha256 FROM whatsapp_media
        WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3`,
      [account.id, clean(row.chat_jid), clean(row.id)],
    )
  ).rows[0];
  if (existing && existing.status === 'STORED' && existing.sha256 === digest) return 'SKIPPED';
  if (!MEDIA_ENABLED) {
    await recordMedia(client, account, row, {status: 'SKIPPED', error: 'MEDIA_DISABLED', digest, bytes: Number(row.file_length || 0)});
    return 'SKIPPED';
  }

  const url = typeof row.url === 'string' ? row.url.trim() : '';
  const mediaKey = row.media_key;
  if (!url || !mediaKey || !row.file_length) {
    await recordMedia(client, account, row, {status: 'FAILED', error: 'MEDIA_METADATA_INCOMPLETE', digest, bytes: Number(row.file_length || 0)});
    return 'FAILED';
  }

  try {
    const encrypted = await downloadEncrypted(url);
    const plaintext = decryptWhatsAppMedia(encrypted, mediaKey, type);
    const actual = sha256Hex(plaintext);
    if (actual !== digest) throw new Error('MEDIA_HASH_MISMATCH');
    const filename = sanitizeFilename(clean(row.filename ?? ''));
    const storagePath = persistMedia(account.id, digest, storageExtension(type, filename), plaintext);
    await recordMedia(client, account, row, {
      status: 'STORED', digest, bytes: plaintext.length, storagePath,
    });
    return 'STORED';
  } catch (error) {
    await recordMedia(client, account, row, {
      status: 'FAILED', error: mediaErrorCode(error), digest, bytes: Number(row.file_length || 0),
    });
    return 'FAILED';
  }
}

async function captureChunkMedia(client, account, chunk) {
  let stored = 0;
  let failed = 0;
  for (const row of chunk) {
    if (!row.media_type) continue;
    try {
      const result = await captureMedia(client, account, row);
      if (result === 'STORED') stored += 1;
      else if (result === 'FAILED') failed += 1;
    } catch (error) {
      failed += 1;
      log('MEDIA_ERROR', account.id, mediaErrorCode(error));
    }
  }
  return {stored, failed};
}

async function retryFailedMedia(client, account, db, columns) {
  const failed = await client.query(
    `SELECT chat_jid, message_id FROM whatsapp_media
      WHERE account_id=$1 AND status='FAILED'
        AND error IS DISTINCT FROM 'MEDIA_METADATA_INCOMPLETE'
        AND updated_at > now() - interval '6 hours'
      ORDER BY updated_at ASC LIMIT $2`,
    [account.id, MEDIA_RETRY_LIMIT],
  );
  if (!failed.rows.length) return 0;
  const select = db.prepare(`SELECT ${selectColumns(columns)} FROM messages WHERE id=? AND chat_jid=? LIMIT 1`);
  let retried = 0;
  for (const item of failed.rows) {
    const row = select.get(item.message_id, item.chat_jid);
    if (!row) continue;
    try {
      await captureMedia(client, account, row);
      retried += 1;
    } catch {
      // The failure is already recorded on the media row.
    }
  }
  return retried;
}

// ────────────────────────────────────────────────── identity evidence ──

async function upsertIdentity(client, accountId, jid, {displayName, nameSource, canonicalJid, evidence, metadata = {}}) {
  const value = String(jid ?? '').trim();
  if (!value) return;
  const kind = jidKind(value);
  const confidence = identityConfidence({kind, canonicalJid, displayName});
  await client.query(
    `INSERT INTO identity_aliases
       (account_id, jid, kind, person_ref, confidence, evidence_ref,
        display_name, name_source, canonical_jid, person_key,
        first_seen_at, last_seen_at, metadata)
     VALUES ($1,$2,$3,NULL,$4,$5,$6,$7,$8,$9,now(),now(),$10::jsonb)
     ON CONFLICT (account_id, jid) DO UPDATE SET
       kind = EXCLUDED.kind,
       display_name = COALESCE(EXCLUDED.display_name, identity_aliases.display_name),
       name_source = COALESCE(EXCLUDED.name_source, identity_aliases.name_source),
       canonical_jid = COALESCE(EXCLUDED.canonical_jid, identity_aliases.canonical_jid),
       person_key = COALESCE(EXCLUDED.person_key, identity_aliases.person_key),
       confidence = CASE
         WHEN identity_aliases.confidence = 'EXACT' THEN 'EXACT'
         WHEN EXCLUDED.confidence = 'EXACT' THEN 'EXACT'
         WHEN identity_aliases.confidence = 'VARIANT' OR EXCLUDED.confidence = 'VARIANT' THEN 'VARIANT'
         ELSE 'UNRESOLVED'
       END,
       evidence_ref = COALESCE(EXCLUDED.evidence_ref, identity_aliases.evidence_ref),
       last_seen_at = now(),
       metadata = identity_aliases.metadata || EXCLUDED.metadata`,
    [
      accountId, clean(value), kind, confidence, evidence ?? null,
      clean(displayName ?? null), nameSource ?? null, clean(canonicalJid ?? null),
      personKey(canonicalJid, value), JSON.stringify(metadata),
    ],
  );
}

async function deriveIdentity(client, account, db, columns) {
  // Account identity: the bridge's own paired identity when present, otherwise
  // the sender of this account's outgoing messages. Never guessed.
  let pairedJid = account.jid || null;
  let pairedLid = null;
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
  if (tables.has('native_stream')) {
    const stream = db.prepare('SELECT paired_jid, paired_lid FROM native_stream LIMIT 1').get();
    pairedJid = stream?.paired_jid || pairedJid;
    pairedLid = stream?.paired_lid || null;
  }
  if (!pairedJid) {
    const own = db
      .prepare("SELECT sender, count(*) AS n FROM messages WHERE is_from_me=1 AND sender IS NOT NULL AND sender<>'' GROUP BY sender ORDER BY n DESC LIMIT 1")
      .get();
    pairedJid = own?.sender || null;
  }
  const accountJid = normalizeAccountJid(pairedJid);
  if (accountJid) {
    // Replace a device-qualified or bare value with the canonical PN.
    await client.query(
      'UPDATE whatsapp_accounts SET account_jid=$2, updated_at=now() WHERE id=$1',
      [account.id, clean(accountJid)],
    );
    await upsertIdentity(client, account.id, accountJid, {
      displayName: account.label, nameSource: 'ACCOUNT', canonicalJid: accountJid,
      evidence: 'bridge:native_stream', metadata: {role: 'account'},
    });
    if (pairedJid && pairedJid !== accountJid) {
      await upsertIdentity(client, account.id, pairedJid, {
        displayName: account.label, nameSource: 'ACCOUNT', canonicalJid: accountJid,
        evidence: 'bridge:native_stream', metadata: {role: 'account', deviceQualified: true},
      });
    }
  }
  if (pairedLid) {
    await upsertIdentity(client, account.id, pairedLid, {
      displayName: account.label, nameSource: 'ACCOUNT', canonicalJid: accountJid,
      evidence: 'bridge:native_stream', metadata: {role: 'account'},
    });
  }

  // Chat labels. A LID chat is linked to a PN only when the bridge itself
  // resolved it; otherwise it stays explicitly unresolved.
  const chats = db.prepare('SELECT jid, name FROM chats').all();
  const directNames = new Map();
  for (const chat of chats) {
    if (jidKind(chat.jid) === 'GROUP') continue;
    const name = clean(chat.name ?? '') || '';
    if (name) directNames.set(chat.jid, name);
  }
  const lidLinks = new Map();
  if (columns.has('resolved_chat_jid')) {
    for (const link of db
      .prepare("SELECT DISTINCT chat_jid, resolved_chat_jid FROM messages WHERE chat_jid LIKE '%@lid' AND resolved_chat_jid IS NOT NULL AND resolved_chat_jid<>''")
      .all()) {
      lidLinks.set(link.chat_jid, link.resolved_chat_jid);
    }
  }
  for (const chat of chats) {
    const kind = jidKind(chat.jid);
    const canonical = kind === 'LID'
      ? (lidLinks.get(chat.jid) ?? null)
      : kind === 'PN'
        ? (canonicalPnJid(chat.jid) ?? chat.jid)
        : kind === 'GROUP'
          ? chat.jid
          : null;
    await upsertIdentity(client, account.id, chat.jid, {
      displayName: clean(chat.name ?? '') || null,
      nameSource: 'CHAT_LABEL',
      canonicalJid: canonical,
      evidence: 'bridge:chats.name',
      metadata: {kind},
    });
  }

  // Group participants: the bridge exposes the actual participant on WA-01;
  // on WA-02 the message sender is the participant. A participant inherits the
  // direct-chat name when one exists, and otherwise stays unnamed.
  const participantQuery = columns.has('group_participant_jid')
    ? `SELECT chat_jid, COALESCE(NULLIF(group_participant_jid,''), NULLIF(sender,'')) AS jid, resolved_sender_jid
         FROM messages WHERE chat_jid LIKE '%@g.us'`
    : `SELECT chat_jid, sender AS jid, NULL AS resolved_sender_jid
         FROM messages WHERE chat_jid LIKE '%@g.us'`;
  const seen = new Map();
  for (const item of db.prepare(participantQuery).all()) {
    if (!item.jid) continue;
    const known = seen.get(item.jid);
    if (!known || (!known.resolved && item.resolved_sender_jid)) {
      seen.set(item.jid, {resolved: item.resolved_sender_jid || null, chat: item.chat_jid});
    }
  }
  for (const [jid, info] of seen) {
    const kind = jidKind(jid);
    const name = directNames.get(jid) ?? null;
    const canonical = info.resolved
      ? (canonicalPnJid(info.resolved) ?? info.resolved)
      : kind === 'PN'
        ? (canonicalPnJid(jid) ?? jid)
        : null;
    await upsertIdentity(client, account.id, jid, {
      displayName: name,
      nameSource: name ? 'CHAT_LABEL' : null,
      canonicalJid: canonical,
      evidence: 'bridge:messages.group_participant_jid',
      metadata: {group: info.chat},
    });
  }

  // PN/LID links the bridge resolved for direct senders.
  if (columns.has('resolved_sender_jid')) {
    const links = db
      .prepare("SELECT DISTINCT sender, resolved_sender_jid FROM messages WHERE sender IS NOT NULL AND sender<>'' AND resolved_sender_jid IS NOT NULL AND resolved_sender_jid<>'' AND sender<>resolved_sender_jid")
      .all();
    for (const link of links) {
      await upsertIdentity(client, account.id, link.sender, {
        displayName: directNames.get(link.sender) ?? null,
        nameSource: directNames.has(link.sender) ? 'CHAT_LABEL' : null,
        canonicalJid: canonicalPnJid(link.resolved_sender_jid) ?? link.resolved_sender_jid,
        evidence: 'bridge:messages.resolved_sender_jid',
      });
    }
  }

  const counts = await client.query(
    `SELECT count(*)::text AS total, count(*) FILTER (WHERE confidence='EXACT')::text AS exact
       FROM identity_aliases WHERE account_id=$1`,
    [account.id],
  );
  return {total: Number(counts.rows[0]?.total ?? 0), exact: Number(counts.rows[0]?.exact ?? 0)};
}

// ────────────────────────────────────────────────────────── the loop ──

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

    let identity = null;
    if (!pending && !options.recent) {
      if (options.identity) identity = await deriveIdentity(client, account, db, columns);
      return {account: account.id, pending: false, written: 0, identity};
    }

    const since = options.recent && !pending ? Math.max(0, checkpoint - RECENT_WINDOW) : checkpoint;
    const select = db.prepare(
      `SELECT ${selectColumns(columns)} FROM messages WHERE rowid > ? AND rowid <= ? ORDER BY rowid LIMIT ?`,
    );
    let runId = null;
    let seen = 0;
    let written = 0;
    let latest = checkpoint;
    let media = {stored: 0, failed: 0};
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
      // Media is captured only in continuous mode: --mode=import must not
      // recover historical attachments.
      if (MODE === 'tail') {
        const captured = await captureChunkMedia(client, account, chunk);
        media = {stored: media.stored + captured.stored, failed: media.failed + captured.failed};
      }
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
    if (MODE === 'tail' && options.recent) await retryFailedMedia(client, account, db, columns);
    if (options.identity) identity = await deriveIdentity(client, account, db, columns);
    return {account: account.id, from: checkpoint, to: latest, seen, written, pending, media, identity};
  } finally {
    db.close();
  }
}

async function status() {
  const client = new pg.Client({
    host: setting('PGHOST') || '127.0.0.1',
    port: Number(setting('PGPORT') || 5432),
    database: setting('PGDATABASE') || 'alrifai_v2',
    user: DB_USER || 'alrifai_v2_runtime',
    password: password(),
    application_name: 'alrifai-sync-status',
  });
  await client.connect();
  try {
    const result = await client.query(
      `SELECT s.account_id,
              coalesce(m.messages,0)::text AS messages,
              coalesce(m.chats,0)::text AS chats,
              coalesce(m.incoming,0)::text AS incoming,
              coalesce(m.outgoing,0)::text AS outgoing,
              coalesce(m.groups,0)::text AS groups,
              m.first_day, m.last_day,
              s.last_rowid, s.last_synced_at, s.last_error,
              coalesce(w.stored,0)::text AS media_stored,
              coalesce(w.failed,0)::text AS media_failed,
              coalesce(w.bytes,0)::text AS media_bytes,
              coalesce(i.total,0)::text AS identities,
              coalesce(i.exact,0)::text AS identities_exact,
              a.account_jid
         FROM whatsapp_sync_state s
         LEFT JOIN whatsapp_accounts a ON a.id = s.account_id
         LEFT JOIN (
           SELECT account_id, count(*) AS messages, count(DISTINCT chat_jid) AS chats,
                  count(*) FILTER (WHERE direction='INCOMING') AS incoming,
                  count(*) FILTER (WHERE direction='OUTGOING') AS outgoing,
                  count(*) FILTER (WHERE chat_kind='GROUP') AS groups,
                  min(source_timestamp)::date AS first_day,
                  max(source_timestamp)::date AS last_day
             FROM whatsapp_messages GROUP BY account_id
         ) m ON m.account_id = s.account_id
         LEFT JOIN (
           SELECT account_id,
                  count(*) FILTER (WHERE status='STORED') AS stored,
                  count(*) FILTER (WHERE status='FAILED') AS failed,
                  coalesce(sum(byte_length) FILTER (WHERE status='STORED'),0) AS bytes
             FROM whatsapp_media GROUP BY account_id
         ) w ON w.account_id = s.account_id
         LEFT JOIN (
           SELECT account_id, count(*) AS total,
                  count(*) FILTER (WHERE confidence='EXACT') AS exact
             FROM identity_aliases GROUP BY account_id
         ) i ON i.account_id = s.account_id
        ORDER BY s.account_id`,
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
      const identity = round === 1 || round % IDENTITY_EVERY === 0;
      for (const account of ACCOUNTS) {
        try {
          const result = await syncAccount(client, account, {
            snapshot: MODE === 'import' && Boolean(SNAPSHOT_DIR),
            recent,
            identity,
          });
          if (result.written || result.media?.stored || result.media?.failed || result.identity) {
            log(MODE === 'import' ? 'IMPORT' : 'TAIL', JSON.stringify(result));
          }
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
        log('IMPORT_COMPLETE');
        break;
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
