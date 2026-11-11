#!/usr/bin/env node
// AL-RIFA'I — read-only WhatsApp bridge → Main Database mirror verifier.
//
// Compares each bridge's own SQLite message store with `whatsapp_messages` by
// the stable key (account, chat_jid, message_id), then compares the fields that
// must be preserved. It also reports media metadata vs actual stored media.
//
//   node scripts/verify-message-mirror.mjs
//   node scripts/verify-message-mirror.mjs --strict
//   node scripts/verify-message-mirror.mjs --strict --strict-media
//
// `--strict` exits non-zero for missing/extra/duplicate/mismatched messages.
// `--strict-media` additionally exits non-zero when any capturable source media
// message has no `whatsapp_media` row.
//
// It never writes to either database and never opens a WhatsApp socket.

import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {loadEnv, secret, setting} from '../lib/env.mjs';
import {isCapturableMedia} from '../lib/whatsapp-media.mjs';

loadEnv();

const strict = process.argv.includes('--strict');
const strictMedia = process.argv.includes('--strict-media');
const accounts = [
  {
    id: setting('WA01_ID') || 'wa-01',
    path: setting('WA01_DB') || '/var/lib/vps/whatsapp/wa-01/store/messages.db',
  },
  {
    id: setting('WA02_ID') || 'wa-02',
    path: setting('WA02_DB') || '/var/lib/vps/whatsapp/wa-02/store/messages.db',
  },
];

function iso(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const parsed = new Date(String(value).trim().replace(' ', 'T'));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : String(value);
}

function hex(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('hex');
  return String(value);
}

function sameNullable(left, right) {
  return String(left ?? '') === String(right ?? '');
}

async function verifyAccount(client, account) {
  const sourceDb = new DatabaseSync(account.path, {readOnly: true});
  let source;
  try {
    source = sourceDb.prepare('SELECT rowid AS source_rowid, * FROM messages').all();
  } finally {
    sourceDb.close();
  }
  const main = (await client.query(
    `SELECT source_rowid, message_id, chat_jid, direction, sender_jid,
            source_timestamp, text_content, content_hash, media_type,
            media_filename, media_sha256, media_length, deleted_at,
            quoted_message_id, raw_payload
       FROM whatsapp_messages WHERE account_id = $1`,
    [account.id],
  )).rows;

  const sourceKey = (row) => `${row.chat_jid}\u0000${row.id}`;
  const mainKey = (row) => `${row.chat_jid}\u0000${row.message_id}`;
  const sourceMap = new Map();
  const mainMap = new Map();
  let sourceDuplicates = 0;
  let mainDuplicates = 0;
  for (const row of source) {
    const key = sourceKey(row);
    if (sourceMap.has(key)) sourceDuplicates += 1;
    else sourceMap.set(key, row);
  }
  for (const row of main) {
    const key = mainKey(row);
    if (mainMap.has(key)) mainDuplicates += 1;
    else mainMap.set(key, row);
  }

  const missing = [...sourceMap.keys()].filter((key) => !mainMap.has(key));
  const extra = [...mainMap.keys()].filter((key) => !sourceMap.has(key));
  const fields = {
    direction: 0, sender: 0, timestamp: 0, text: 0,
    media_type: 0, filename: 0, media_sha256: 0, media_length: 0,
    deleted_at: 0, quoted: 0, original_sender: 0, original_chat: 0,
    group_participant: 0, resolved_sender: 0, resolved_chat: 0,
    identity_state: 0, chat_identity_state: 0, source_rowid: 0,
  };
  const samples = {};

  for (const [key, sourceRow] of sourceMap) {
    const mainRow = mainMap.get(key);
    if (!mainRow) continue;
    const payload = mainRow.raw_payload && typeof mainRow.raw_payload === 'object'
      ? mainRow.raw_payload
      : {};
    const diffs = [];
    const rawText = String(sourceRow.content ?? '');
    const mirroredText = typeof payload.content_base64 === 'string'
      ? Buffer.from(payload.content_base64, 'base64').toString('utf8')
      : String(mainRow.text_content ?? '');
    if ((sourceRow.is_from_me ? 'OUTGOING' : 'INCOMING') !== mainRow.direction) { fields.direction += 1; diffs.push('direction'); }
    if (!sameNullable(sourceRow.sender, mainRow.sender_jid)) { fields.sender += 1; diffs.push('sender'); }
    if (iso(sourceRow.timestamp) !== iso(mainRow.source_timestamp)) { fields.timestamp += 1; diffs.push('timestamp'); }
    if (rawText !== mirroredText) { fields.text += 1; diffs.push('text'); }
    if (!sameNullable(sourceRow.media_type?.toLowerCase?.(), mainRow.media_type?.toLowerCase?.())) { fields.media_type += 1; diffs.push('media_type'); }
    if (!sameNullable(sourceRow.filename, mainRow.media_filename)) { fields.filename += 1; diffs.push('filename'); }
    if (!sameNullable(hex(sourceRow.file_sha256), mainRow.media_sha256)) { fields.media_sha256 += 1; diffs.push('media_sha256'); }
    if (Number(sourceRow.file_length ?? 0) !== Number(mainRow.media_length ?? 0)) { fields.media_length += 1; diffs.push('media_length'); }
    if (iso(sourceRow.deleted_at) !== iso(mainRow.deleted_at)) { fields.deleted_at += 1; diffs.push('deleted_at'); }
    if (!sameNullable(sourceRow.quoted_message_id, mainRow.quoted_message_id)) { fields.quoted += 1; diffs.push('quoted'); }
    if (!sameNullable(sourceRow.original_sender_jid, payload.original_sender_jid)) { fields.original_sender += 1; diffs.push('original_sender'); }
    if (!sameNullable(sourceRow.original_chat_jid, payload.original_chat_jid)) { fields.original_chat += 1; diffs.push('original_chat'); }
    if (!sameNullable(sourceRow.group_participant_jid, payload.group_participant_jid)) { fields.group_participant += 1; diffs.push('group_participant'); }
    if (!sameNullable(sourceRow.resolved_sender_jid, payload.resolved_sender_jid)) { fields.resolved_sender += 1; diffs.push('resolved_sender'); }
    if (!sameNullable(sourceRow.resolved_chat_jid, payload.resolved_chat_jid)) { fields.resolved_chat += 1; diffs.push('resolved_chat'); }
    if (!sameNullable(sourceRow.identity_state, payload.identity_state)) { fields.identity_state += 1; diffs.push('identity_state'); }
    if (!sameNullable(sourceRow.chat_identity_state, payload.chat_identity_state)) { fields.chat_identity_state += 1; diffs.push('chat_identity_state'); }
    if (Number(sourceRow.source_rowid) !== Number(mainRow.source_rowid)) { fields.source_rowid += 1; diffs.push('source_rowid'); }
    if (diffs.length && !samples[diffs[0]]) {
      samples[diffs[0]] = {chat_jid: key.split('\u0000')[0], message_id: key.split('\u0000')[1], fields: diffs};
    }
  }

  const mediaSource = source.filter((row) => isCapturableMedia(String(row.media_type ?? '').toLowerCase()));
  const mediaRows = (await client.query(
    `SELECT chat_jid, message_id, media_type, status, error, storage_path
       FROM whatsapp_media WHERE account_id=$1`,
    [account.id],
  )).rows;
  const mediaMap = new Map(mediaRows.map((row) => [`${row.chat_jid}\u0000${row.message_id}`, row]));
  const mediaMissing = mediaSource.filter((row) => !mediaMap.has(sourceKey(row)));
  const mediaStatus = {STORED: 0, FAILED: 0, SKIPPED: 0};
  for (const row of mediaRows) {
    if (Object.hasOwn(mediaStatus, row.status)) mediaStatus[row.status] += 1;
  }
  const sourceWithUrl = mediaSource.filter((row) => typeof row.url === 'string' && row.url.trim()).length;
  const sourceWithKey = mediaSource.filter((row) => row.media_key != null).length;

  const checkpoint = (await client.query(
    'SELECT last_rowid, last_synced_at, last_error FROM whatsapp_sync_state WHERE account_id=$1',
    [account.id],
  )).rows[0] ?? null;
  const maxRowid = source.reduce((max, row) => Math.max(max, Number(row.source_rowid) || 0), 0);

  const fieldMismatchTotal = Object.values(fields).reduce((sum, value) => sum + value, 0);
  const clean = missing.length === 0 && extra.length === 0
    && sourceDuplicates === 0 && mainDuplicates === 0 && fieldMismatchTotal === 0;
  return {
    account: account.id,
    sourcePath: account.path,
    sourceCount: source.length,
    mainCount: main.length,
    missing: missing.length,
    extra: extra.length,
    sourceDuplicates,
    mainDuplicates,
    fieldMismatches: fields,
    fieldMismatchTotal,
    mismatchSamples: samples,
    missingSample: missing.slice(0, 10).map((key) => ({chat_jid: key.split('\u0000')[0], message_id: key.split('\u0000')[1]})),
    extraSample: extra.slice(0, 10).map((key) => ({chat_jid: key.split('\u0000')[0], message_id: key.split('\u0000')[1]})),
    sourceRowid: {min: source.length ? Math.min(...source.map((row) => Number(row.source_rowid))) : null, max: maxRowid, gaps: maxRowid - source.length},
    checkpoint,
    checkpointLag: Math.max(0, maxRowid - Number(checkpoint?.last_rowid ?? 0)),
    messageMirror: clean ? 'COMPLETE' : 'MISMATCH',
    media: {
      sourceMediaMessages: mediaSource.length,
      sourceWithUrl,
      sourceWithKey,
      rows: mediaRows.length,
      status: mediaStatus,
      missingRows: mediaMissing.length,
      missingByType: Object.fromEntries([...mediaMissing.reduce((map, row) => {
        const type = String(row.media_type ?? '').toLowerCase();
        map.set(type, (map.get(type) ?? 0) + 1);
        return map;
      }, new Map())]),
      completeness: mediaMissing.length === 0 ? 'COMPLETE' : 'PARTIAL',
    },
  };
}

async function main() {
  const client = new pg.Client({
    host: setting('PGHOST') || '127.0.0.1',
    port: Number(setting('PGPORT') || 5432),
    database: setting('PGDATABASE') || 'alrifai_v2',
    user: setting('PGUSER') || 'alrifai_app',
    password: secret('PGPASSWORD'),
    application_name: 'verify-message-mirror',
  });
  await client.connect();
  try {
    await client.query('SET default_transaction_read_only=on');
    const results = [];
    for (const account of accounts) results.push(await verifyAccount(client, account));
    const report = {
      generatedAt: new Date().toISOString(),
      database: setting('PGDATABASE'),
      status: results.every((result) => result.messageMirror === 'COMPLETE'
        && result.media.completeness === 'COMPLETE') ? 'COMPLETE' : 'PARTIAL',
      accounts: results,
    };
    console.log(JSON.stringify(report, null, 2));
    if (strict && results.some((result) => result.messageMirror !== 'COMPLETE')) process.exitCode = 1;
    if (strictMedia && results.some((result) => result.media.completeness !== 'COMPLETE')) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'MIRROR_VERIFY_FAILED'}));
  process.exitCode = 1;
});
