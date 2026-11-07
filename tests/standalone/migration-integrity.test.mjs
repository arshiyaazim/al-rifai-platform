// Migration 010 -> 011 integrity checks — isolated disposable database only.
//
// This test proves the installed schema, ledger checksums, ordering, the
// immutable append-only design and idempotent re-application. Full fresh and
// incremental runner behaviour is verified separately by the release evidence
// commands recorded in the handoff.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {row, rows} from '../../lib/standalone/db.ts';
import {createPool} from '../../db/postgres.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const sqlFile = (name) => readFileSync(join(ROOT, 'db', 'standalone', name));
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

async function withOwner(fn) {
  const owner = createPool({role: 'app', readOnly: false, applicationName: 'alrifai-migration-test'});
  try {
    return await fn(owner);
  } finally {
    await owner.end();
  }
}

test('010 and 011 are installed in order with the exact file checksums', async () => {
  const installed = await withOwner(async (owner) =>
    (await owner.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version')).rows);
  const byVersion = new Map(installed.map((entry) => [entry.version, entry]));
  const ten = byVersion.get('010');
  const eleven = byVersion.get('011');
  assert.ok(ten, 'migration 010 is recorded');
  assert.ok(eleven, 'migration 011 is recorded');
  assert.equal(ten.name, '010_vessel_draft_delivery.sql');
  assert.equal(eleven.name, '011_cash_payment_events.sql');
  assert.equal(ten.checksum, sha256(sqlFile('010_vessel_draft_delivery.sql')));
  assert.equal(eleven.checksum, sha256(sqlFile('011_cash_payment_events.sql')));
  const order = installed.map((entry) => entry.version);
  assert.ok(order.indexOf('010') < order.indexOf('011'), '010 must be applied before 011');
});

test('010 vessel draft delivery schema is additive and intact', async () => {
  const table = await row("SELECT to_regclass('public.vessel_draft_deliveries') IS NOT NULL AS present");
  assert.equal(table.present, true);
  const columns = await rows(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'vessel_draft_deliveries'
      ORDER BY ordinal_position`,
  );
  const names = columns.map((column) => column.column_name);
  for (const required of ['id', 'program_id', 'content_hash', 'state', 'lease_until', 'delivery_ref']) {
    assert.ok(names.includes(required), `vessel_draft_deliveries.${required} exists`);
  }
  const fk = await row(
    `SELECT count(*)::int AS n FROM information_schema.table_constraints
      WHERE table_schema='public' AND table_name='vessel_draft_deliveries' AND constraint_type='FOREIGN KEY'`,
  );
  assert.ok(fk.n >= 1, 'program_id foreign key exists');
  // Migration 010 is inert: no sending capability is introduced here.
  assert.equal((await row('SELECT count(*)::int AS n FROM vessel_draft_deliveries')).n, 0);
});

test('011 Business Paid Event table, columns, indexes and triggers exist', async () => {
  const columns = await rows(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='cash_payment_events'
      ORDER BY ordinal_position`,
  );
  const names = columns.map((column) => column.column_name);
  for (const required of [
    'id', 'event_type', 'instruction_id', 'source_submission_id', 'employee_mobile',
    'payout_mobile', 'employee_name', 'employee_link_status', 'amount_minor', 'method',
    'source_category', 'source_message_id', 'source_block_key', 'status', 'paid_at',
    'corrects_event_id', 'reverses_event_id', 'created_by', 'created_at',
  ]) {
    assert.ok(names.includes(required), `cash_payment_events.${required} exists`);
  }
  assert.ok(!names.includes('posted_at'), 'posting time lives only in the posting link table');

  const indexes = await rows(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND tablename='cash_payment_events'`,
  );
  const indexNames = indexes.map((index) => index.indexname);
  for (const required of [
    'cash_payment_events_whatsapp_source',
    'cash_payment_events_office_submission',
    'cash_payment_events_instruction_payment',
    'cash_payment_events_one_correction',
    'cash_payment_events_one_reversal',
  ]) {
    assert.ok(indexNames.includes(required), `${required} exists`);
  }

  const triggers = await rows(
    `SELECT tgname FROM pg_trigger t
       JOIN pg_class c ON c.oid = t.tgrelid
      WHERE c.relname = 'cash_payment_events' AND NOT t.tgisinternal`,
  );
  assert.ok(triggers.some((trigger) => trigger.tgname === 'cash_payment_events_immutable'));

  assert.equal((await row("SELECT to_regclass('public.cash_payment_event_postings') IS NOT NULL AS present")).present, true);
  assert.equal((await row("SELECT to_regprocedure('public.forbid_mutation()') IS NOT NULL AS present")).present, true);
});

test('duplicate WhatsApp source and invalid event values are rejected', async () => {
  const id = `pe-test-${Date.now()}`;
  const sourceMessageId = `constraint-message-${Date.now()}`;
  const insert = (eventId, overrides = {}) => row(
    `INSERT INTO cash_payment_events
       (id, event_type, employee_mobile, payout_mobile, employee_name,
        amount_minor, method, source_category, source_message_id, source_block_key,
        status, paid_at, created_by)
     VALUES ($1,'PAYMENT',$2,$3,$4,$5,'bkash','WHATSAPP',$6,$7,'PAID',now(),'test')
     RETURNING id`,
    [eventId, overrides.employee ?? '+8801712345678', overrides.employee ?? '+8801712345678',
      overrides.name ?? 'Constraint Test', overrides.amount ?? '1000',
      overrides.sourceMessageId ?? sourceMessageId,
      overrides.sourceBlockKey ?? 'payment-block-0'],
  );
  assert.ok(await insert(id));
  await assert.rejects(
    () => insert(`${id}-dup`),
    /duplicate key value violates unique constraint/,
  );
  await assert.rejects(
    () => insert(`${id}-bad-amount`, {amount: '0'}),
    /cash_payment_events_amount_minor_check/,
  );
  await assert.rejects(
    () => insert(`${id}-no-source`, {sourceMessageId: null}),
    /cash_payment_events_whatsapp_source/,
  );
  assert.equal(
    (await row('SELECT count(*)::int AS n FROM cash_payment_events WHERE id LIKE $1', [`${id}%`])).n,
    1,
  );
});

test('011 and 010 re-apply safely in the same database', async () => {
  const eleven = sqlFile('011_cash_payment_events.sql').toString('utf8');
  const ten = sqlFile('010_vessel_draft_delivery.sql').toString('utf8');
  await withOwner(async (owner) => {
    await owner.query('BEGIN');
    try {
      await owner.query(ten);
      await owner.query(eleven);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  });
  // A second independent re-application of 011.
  await withOwner(async (owner) => {
    await owner.query('BEGIN');
    try {
      await owner.query(eleven);
      await owner.query('COMMIT');
    } catch (error) {
      await owner.query('ROLLBACK');
      throw error;
    }
  });
  assert.equal((await row("SELECT value FROM schema_meta WHERE key='schema_version'")).value, '1.6.0');
});