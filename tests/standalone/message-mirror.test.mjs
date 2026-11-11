// WhatsApp bridge → Main Database mirror integration test.
//
// Uses a temporary SQLite bridge store and the disposable test database. It
// proves historical import, late-edit reconciliation, idempotency, media status
// recording and the read-only verifier. No WhatsApp socket is opened.
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';

loadEnv();

const REPO = new URL('../..', import.meta.url).pathname;
const A = 'mirror-test-a';
const B = 'mirror-test-b';
const tmp = mkdtempSync('/tmp/opencode/mirror-test-');
const paths = {A: join(tmp, 'a', 'messages.db'), B: join(tmp, 'b', 'messages.db')};

function source(path, account) {
  mkdirSync(dirname(path), {recursive: true});
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE chats (jid TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE calls (
      call_id TEXT, chat_jid TEXT, from_jid TEXT, timestamp TEXT, is_from_me INTEGER,
      call_type TEXT, is_group INTEGER, result TEXT, duration_sec INTEGER, ended_at TEXT, reason TEXT,
      PRIMARY KEY (call_id, chat_jid));
    CREATE TABLE messages (
      id TEXT, chat_jid TEXT, sender TEXT, content TEXT, timestamp TEXT,
      is_from_me INTEGER, media_type TEXT, filename TEXT, url TEXT, media_key BLOB,
      file_sha256 BLOB, file_enc_sha256 BLOB, file_length INTEGER, deleted_at TEXT,
      quoted_message_id TEXT, original_sender_jid TEXT, original_chat_jid TEXT,
      group_participant_jid TEXT, resolved_sender_jid TEXT, resolved_chat_jid TEXT,
      identity_state TEXT, chat_identity_state TEXT, PRIMARY KEY (id, chat_jid));`);
  const chat = account === 'A' ? '8801700000001@s.whatsapp.net' : '8801700000002@s.whatsapp.net';
  const self = account === 'A' ? '8801880446111@s.whatsapp.net' : '8801958122300@s.whatsapp.net';
  db.prepare('INSERT INTO chats (jid,name) VALUES (?,?)').run(chat, `Mirror Client ${account}`);
  db.prepare(`INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me)
    VALUES (?,?,?,?,?,0)`).run(`MSG-${account}-1`, chat, chat, 'Hello mirror', '2026-11-08 10:00:00+00:00');
  db.prepare(`INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me)
    VALUES (?,?,?,?,?,1)`).run(`MSG-${account}-2`, chat, self, 'Outgoing mirror', '2026-11-08 10:01:00+00:00');
  db.prepare(`INSERT INTO messages (id,chat_jid,sender,content,timestamp,is_from_me,media_type,filename,file_sha256,file_length)
    VALUES (?,?,?,?,?,0,'image','photo.jpg',?,123)`).run(
    `MSG-${account}-3`, chat, chat, '', '2026-11-08 10:02:00+00:00', Buffer.alloc(32, account === 'A' ? 1 : 2),
  );
  db.prepare(`INSERT INTO calls (call_id,chat_jid,from_jid,timestamp,is_from_me,call_type,is_group,result,duration_sec,reason)
    VALUES (?,?,?,?,0,'voice',0,'missed',0,'no answer')`).run(
    `CALL-${account}-1`, chat, chat, '2026-11-08 10:03:00+00:00',
  );
  db.close();
  const contactDb = new DatabaseSync(join(dirname(path), 'whatsapp.db'));
  contactDb.exec(`CREATE TABLE whatsmeow_contacts (their_jid TEXT, first_name TEXT, full_name TEXT, push_name TEXT, business_name TEXT);
    CREATE TABLE whatsmeow_lid_map (lid TEXT, pn TEXT);
    INSERT INTO whatsmeow_contacts (their_jid,first_name,full_name,push_name,business_name)
      VALUES ('${chat}', NULL, 'Contact ${account}', 'Push ${account}', NULL);`);
  contactDb.close();
}

function run(args) {
  const result = spawnSync(process.execPath, ['scripts/sync-worker.mjs', ...args], {
    cwd: REPO,
    env: {
      ...process.env,
      WA01_ID: A, WA01_DB: paths.A, WA01_LABEL: 'Mirror A',
      WA02_ID: B, WA02_DB: paths.B, WA02_LABEL: 'Mirror B',
      ALRIFAI_MEDIA_ENABLED: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr + result.stdout);
  return result;
}

async function db() {
  const client = new pg.Client({
    host: process.env.PGHOST,
    port: Number(process.env.PGPORT || 5432),
    database: process.env.PGDATABASE,
    user: process.env.PGUSER,
    password: secret('PGPASSWORD'),
  });
  await client.connect();
  return client;
}

async function cleanup(client) {
  for (const id of [A, B]) {
    await client.query('DELETE FROM whatsapp_media WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_message_intelligence WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_calls WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_messages WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_chats WHERE account_id=$1', [id]);
    await client.query('DELETE FROM identity_aliases WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_sync_state WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_import_runs WHERE account_id=$1', [id]);
    await client.query('DELETE FROM whatsapp_accounts WHERE id=$1', [id]);
  }
}

test('bridge messages mirror exactly, late edits reconcile, and media status is explicit', async () => {
  source(paths.A, 'A');
  source(paths.B, 'B');
  const client = await db();
  try {
    await cleanup(client);
    run(['--mode=import']);
    for (const id of [A, B]) {
      const count = await client.query('SELECT count(*)::int AS n FROM whatsapp_messages WHERE account_id=$1', [id]);
      assert.equal(count.rows[0].n, 3);
      const mirrored = await client.query('SELECT count(*)::int AS n FROM whatsapp_messages WHERE account_id=$1 AND mirrored_at IS NOT NULL', [id]);
      assert.equal(mirrored.rows[0].n, 3);
      const calls = await client.query('SELECT count(*)::int AS n FROM whatsapp_calls WHERE account_id=$1', [id]);
      assert.equal(calls.rows[0].n, 1);
    }
    const contact = await client.query(
      `SELECT metadata FROM identity_aliases
        WHERE account_id=$1 AND jid='8801700000001@s.whatsapp.net'`, [A],
    );
    assert.equal(contact.rows[0]?.metadata?.my_contact_name, 'Contact A');
    assert.equal(contact.rows[0]?.metadata?.push_name, 'Push A');

    // Late edit/revocation below the tail checkpoint must be reconciled.
    const sourceDb = new DatabaseSync(paths.A);
    sourceDb.prepare(`UPDATE messages SET content='Hello mirror edited',
      timestamp='2026-11-08 10:05:00+00:00', deleted_at='2026-11-08 10:06:00+00:00'
      WHERE id='MSG-A-1'`).run();
    sourceDb.close();
    const first = run(['--mode=reconcile']);
    assert.match(first.stdout, /"account":"mirror-test-a".*"written":1/);
    const second = run(['--mode=reconcile']);
    assert.match(second.stdout, /"account":"mirror-test-a".*"written":0/);
    const edited = await client.query(
      `SELECT text_content, source_timestamp, deleted_at FROM whatsapp_messages
        WHERE account_id=$1 AND message_id='MSG-A-1'`, [A],
    );
    assert.equal(edited.rows[0].text_content, 'Hello mirror edited');
    assert.ok(edited.rows[0].deleted_at);

    // Explicit media status for a source media message without URL/key.
    const media = run(['--mode=media-status', '--confirm']);
    assert.match(media.stdout, /MEDIA_STATUS/);
    const status = await client.query(
      `SELECT status, error FROM whatsapp_media WHERE account_id=$1 AND message_id='MSG-A-3'`, [A],
    );
    assert.equal(status.rows[0].status, 'SKIPPED');
    assert.equal(status.rows[0].error, 'MEDIA_SOURCE_METADATA_ABSENT');

    // The read-only verifier must report a complete message mirror and a
    // complete media-status inventory (files may be SKIPPED, not falsely STORED).
    const verify = spawnSync(process.execPath, ['scripts/verify-message-mirror.mjs', '--strict', '--strict-media'], {
      cwd: REPO,
      env: {...process.env, WA01_ID: A, WA01_DB: paths.A, WA02_ID: B, WA02_DB: paths.B},
      encoding: 'utf8',
    });
    assert.equal(verify.status, 0, verify.stderr + verify.stdout);
    const report = JSON.parse(verify.stdout);
    assert.equal(report.status, 'COMPLETE');
    assert.equal(report.accounts.every((account) => account.messageMirror === 'COMPLETE'), true);
  } finally {
    await cleanup(client).catch(() => undefined);
    await client.end();
    rmSync(tmp, {recursive: true, force: true});
  }
});
