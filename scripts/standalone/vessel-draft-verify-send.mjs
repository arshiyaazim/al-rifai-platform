#!/usr/bin/env node
// AL-RIFA'I — confirm the WhatsApp message id for a SENT Vessel Draft.
//
// The WA-01 bridge returns bridge acceptance but not the native WhatsApp id in
// its current MCP tool result. The bridge stores the outgoing message in its
// own SQLite store with the native id; this read-only lookup binds that id to
// the durable delivery record and writes one audit event.
//
// It never sends, never retries and never edits the message content. If the
// exact outgoing row cannot be found unambiguously, it refuses and changes
// nothing.
//
//   node --experimental-strip-types scripts/standalone/vessel-draft-verify-send.mjs \
//     --delivery=<vdd_...> [--bridge-db=/var/lib/vps/whatsapp/wa-01/store/messages.db]

import {DatabaseSync} from 'node:sqlite';
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';

loadEnv();

const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function connection() {
  const host = (process.env.PGHOST ?? '').trim();
  const database = (process.env.PGDATABASE ?? '').trim();
  const port = Number((process.env.PGPORT ?? '5432').trim());
  const schema = (process.env.PGSCHEMA ?? 'public').trim() || 'public';
  const user = (process.env.PGUSER ?? '').trim();
  if (!host || !database || !user) throw new Error('DATABASE_CONFIG_MISSING');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DATABASE_CONFIG_INVALID:PGPORT');
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error('DATABASE_CONFIG_INVALID:PGSCHEMA');
  const password = secret('PGPASSWORD');
  if (!password) throw new Error('DATABASE_CONFIG_MISSING:PGPASSWORD');
  return {host, database, port, schema, user, password};
}

function bridgeRows(path, chatJid, content) {
  const db = new DatabaseSync(path, {readOnly: true});
  try {
    return db.prepare(
      `SELECT id, chat_jid, timestamp, is_from_me, content
         FROM messages
        WHERE chat_jid = ? AND is_from_me = 1 AND content = ?
        ORDER BY timestamp DESC
        LIMIT 10`,
    ).all(chatJid, content);
  } finally {
    db.close();
  }
}

async function main() {
  const deliveryId = arg('delivery');
  if (!deliveryId) throw new Error('DELIVERY_ID_REQUIRED');
  const bridgeDb = arg('bridge-db') || process.env.WA01_DB
    || '/var/lib/vps/whatsapp/wa-01/store/messages.db';
  const config = connection();
  const client = new pg.Client({...config, application_name: 'al-rifai-vessel-verify-send'});
  await client.connect();
  try {
    await client.query(`SET search_path TO "${config.schema}"`);
    const found = await client.query(
      `SELECT id, program_id, recipient_jid, content, state, delivery_ref,
              created_at::text AS created_at, updated_at::text AS updated_at
         FROM vessel_draft_deliveries WHERE id = $1`,
      [deliveryId],
    );
    if (!found.rowCount) throw new Error('DELIVERY_NOT_FOUND');
    const record = found.rows[0];
    if (record.state !== 'SENT') throw new Error(`DELIVERY_NOT_SENT:${record.state}`);

    const rows = bridgeRows(bridgeDb, record.recipient_jid, record.content);
    if (!rows.length) throw new Error('MESSAGE_ID_NOT_FOUND');
    // The outgoing row must be at/after the delivery claim. Allow a small clock
    // tolerance, never an older unrelated message.
    const floor = Date.parse(record.created_at) - 120_000;
    const eligible = rows.filter((row) => {
      const at = Date.parse(String(row.timestamp));
      return Number.isFinite(at) && at >= floor;
    });
    if (eligible.length !== 1) {
      throw new Error(eligible.length ? 'MESSAGE_ID_AMBIGUOUS' : 'MESSAGE_ID_NOT_AFTER_SEND');
    }
    const messageId = String(eligible[0].id);
    if (record.delivery_ref && record.delivery_ref !== messageId) {
      throw new Error('DELIVERY_REF_CONFLICT');
    }

    await client.query('BEGIN');
    await client.query(
      `UPDATE vessel_draft_deliveries
          SET delivery_ref = COALESCE(delivery_ref, $2), updated_at = now()
        WHERE id = $1`,
      [deliveryId, messageId],
    );
    await client.query(
      `INSERT INTO audit_events (actor, actor_role, action, entity, entity_id, detail, source)
       VALUES ('system:vessel-draft-delivery', 'SYSTEM', $1, 'vessel_draft_delivery', $2, $3::jsonb, 'SYSTEM')`,
      [
        'VESSEL_DRAFT_DELIVERY_MESSAGE_ID_CONFIRMED',
        deliveryId,
        JSON.stringify({
          programId: record.program_id,
          whatsappMessageId: messageId,
          bridgeTimestamp: eligible[0].timestamp,
          evidence: 'BRIDGE_STORE_OUTGOING_MESSAGE',
        }),
      ],
    );
    await client.query('COMMIT');

    console.log(JSON.stringify({
      step: 'confirmed',
      deliveryId,
      programId: record.program_id,
      recipientJid: record.recipient_jid,
      state: record.state,
      whatsappMessageId: messageId,
      bridgeTimestamp: eligible[0].timestamp,
      evidence: 'BRIDGE_STORE_OUTGOING_MESSAGE',
    }, null, 2));
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
    code: error?.message ?? 'VESSEL_DRAFT_VERIFY_SEND_FAILED',
  }));
  process.exitCode = 1;
});
