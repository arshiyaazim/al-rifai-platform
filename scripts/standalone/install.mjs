#!/usr/bin/env node
// AL-RIFA'I — fresh schema installer.
//
// Creates the standalone baseline (db/standalone/schema.sql) in one transaction,
// grants least-privilege runtime access, optionally seeds the first administrator
// and verifies the result. It never touches another schema and never replays the
// historical migration chain.
//
//   node --experimental-strip-types scripts/standalone/install.mjs --preflight
//   node --experimental-strip-types scripts/standalone/install.mjs
//   node --experimental-strip-types scripts/standalone/install.mjs --admin-user owner --admin-password '…'
//
// Configuration: the single `.env` at the project root (lib/env.mjs). Keys are
// PGHOST, PGPORT, PGDATABASE, PGSCHEMA, PGUSER, PGPASSWORD, the runtime role
// (ALRIFAI_REVIEW_DB_USER / ALRIFAI_REVIEW_PASSWORD) and the first
// administrator (ALRIFAI_BOOTSTRAP_ADMIN_USERNAME / _PASSWORD / _NAME).
import {existsSync, readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import pg from 'pg';
import {loadEnv, secret, setting} from '../../lib/env.mjs';
import {grantRuntime} from './grants.mjs';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..', '..');
const SCHEMA_FILE = join(APP_ROOT, 'db', 'standalone', 'schema.sql');
// Additive layers applied after the baseline, in file-name order.
const EXTRA_SCHEMA_FILES = [
  join(APP_ROOT, 'db', 'standalone', '002_raw_import.sql'),
  join(APP_ROOT, 'db', 'standalone', '003_phase2_identity_media.sql'),
  join(APP_ROOT, 'db', 'standalone', '004_phase3_router_state.sql'),
  join(APP_ROOT, 'db', 'standalone', '005_phase3_vessel_correlation.sql'),
  join(APP_ROOT, 'db', 'standalone', '006_phase3_review_queue.sql'),
  join(APP_ROOT, 'db', 'standalone', '007_phase3_review_queue_ui.sql'),
  join(APP_ROOT, 'db', 'standalone', '008_phase3_cash_lifecycle.sql'),
  join(APP_ROOT, 'db', 'standalone', '009_phase3_ai_assistant.sql'),
// 010 is additive and pending Owner approval for outbound activation. The
  // table itself is inert: no WhatsApp capability and no message is created.
  join(APP_ROOT, 'db', 'standalone', '010_vessel_draft_delivery.sql'),
  join(APP_ROOT, 'db', 'standalone', '011_cash_payment_events.sql'),
  join(APP_ROOT, 'db', 'standalone', '012_whatsapp_message_intelligence.sql'),
  join(APP_ROOT, 'db', 'standalone', '013_escort_workflow_authorization.sql'),
  join(APP_ROOT, 'db', 'standalone', '014_manual_programs.sql'),
  join(APP_ROOT, 'db', 'standalone', '015_cash_corrections.sql'),
];

const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const TARGET_TABLES = [
  'schema_meta', 'app_settings', 'cash_portal_users', 'cash_portal_sessions',
  'cash_portal_audit', 'login_throttle_state', 'employees', 'programs',
  'program_assignments', 'program_events', 'attendance', 'rate_config',
  'program_pay', 'cash_accounts', 'cash_instructions', 'cash_postings',
  'ledger_entries', 'cash_submissions', 'cash_submission_reviews',
  'review_items', 'review_decisions', 'audit_events', 'whatsapp_accounts',
  'whatsapp_chats', 'whatsapp_messages', 'whatsapp_cursors',
  'whatsapp_import_runs', 'whatsapp_sync_state', 'identity_aliases',
  'whatsapp_media',
  // Phase 3 Cash lifecycle
  'cash_reversals', 'cash_reconciliations',
  // Cash correction/reversal adjustments (migration 015)
  'cash_transaction_adjustments',
  // Phase 3 Business Paid Events (migration 011)
  'cash_payment_events', 'cash_payment_event_postings',
  // Phase 3 Vessel draft delivery queue (migration 010)
  'vessel_draft_deliveries',
  // WhatsApp message intelligence / call trace (migration 012)
  'whatsapp_calls', 'whatsapp_message_intelligence',
  // Phase 3 AI communication foundation
  'ai_contacts', 'ai_admin_jids', 'ai_conversations', 'ai_messages',
  'ai_applicant_drafts', 'ai_job_catalog', 'ai_outbound_messages',
  'ai_tool_runs', 'ai_escalations', 'ai_order_drafts', 'ai_outbound_attempts', 'schema_migrations',
];

class InstallError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const env = (name) => (process.env[name] ?? '').trim();
const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

/** Read a password from the central config: inline value, else a secret file. */
function readSecret(valueVar) {
  const value = secret(valueVar);
  if (!value) throw new InstallError(`DATABASE_CONFIG_MISSING:${valueVar}`);
  return value;
}

function connection(role) {
  const host = env('PGHOST');
  const database = env('PGDATABASE');
  const port = Number(env('PGPORT') || 5432);
  const schema = env('PGSCHEMA') || 'public';
  if (!host) throw new InstallError('DATABASE_CONFIG_MISSING:PGHOST');
  if (!database) throw new InstallError('DATABASE_CONFIG_MISSING:PGDATABASE');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new InstallError('DATABASE_CONFIG_INVALID:PGPORT');
  if (!IDENT.test(schema)) throw new InstallError('DATABASE_CONFIG_INVALID:PGSCHEMA');
  const user = role === 'runtime' ? env('ALRIFAI_REVIEW_DB_USER') : env('PGUSER');
  if (!user) {
    throw new InstallError(`DATABASE_CONFIG_MISSING:${role === 'runtime' ? 'ALRIFAI_REVIEW_DB_USER' : 'PGUSER'}`);
  }
  if (!IDENT.test(user)) throw new InstallError('DATABASE_CONFIG_INVALID:PGUSER');
  const password = readSecret(role === 'runtime' ? 'ALRIFAI_REVIEW_PASSWORD' : 'PGPASSWORD');
  return {host, port, database, schema, user, password};
}

async function preflight(client, config) {
  const version = await client.query('SHOW server_version_num');
  const number = Number(version.rows[0].server_version_num);
  if (!Number.isFinite(number) || number < 130000) {
    throw new InstallError('PREFLIGHT_POSTGRES_VERSION', `need >= 13, found ${number}`);
  }
  const identity = await client.query('SELECT current_user AS user, current_database() AS db');
  const existing = await client.query(
    'SELECT to_regclass($1) IS NOT NULL AS present',
    [`${config.schema}.schema_meta`],
  );
  const runtimeRole = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [
    env('ALRIFAI_REVIEW_DB_USER'),
  ]);
  const schemaExists = config.schema === 'public'
    ? true
    : (await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [config.schema])).rows[0].present;
  return {
    postgres: number,
    user: identity.rows[0].user,
    database: identity.rows[0].db,
    schema: config.schema,
    schemaExists,
    alreadyInstalled: existing.rows[0].present,
    runtimeRoleExists: runtimeRole.rowCount === 1,
  };
}

function adminId(username) {
  return createHash('sha256').update(`cash-user:${username.toLowerCase()}`).digest('hex');
}

async function seedAdmin(client, {username, password, displayName}) {
  const {hashBootstrapPassword} = await import('../../lib/cash-portal.ts');
  const hash = await hashBootstrapPassword(password);
  const id = adminId(username);
  await client.query(
    `INSERT INTO cash_portal_users
       (id, username, password_hash, role, display_name, must_change_password, active, created_by, capabilities)
     VALUES ($1,$2,$3,'ADMIN',$4,true,true,'installer','["workspace.admin"]'::jsonb)
     ON CONFLICT (id) DO NOTHING`,
    [id, username, hash, displayName],
  );
  return id;
}

async function verify(client, config) {
  const tables = await client.query(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = $1 AND table_type = 'BASE TABLE'`,
    [config.schema],
  );
  const present = new Set(tables.rows.map((row) => row.table_name));
  const missing = TARGET_TABLES.filter((name) => !present.has(name));
  if (missing.length) throw new InstallError('VERIFY_MISSING_TABLES', missing.join(','));
  const meter = await client.query(
    `SELECT
       (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1) AS functions,
       (SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND NOT t.tgisinternal) AS triggers,
       (SELECT count(*) FROM rate_config) AS rates,
       (SELECT value FROM schema_meta WHERE key = 'schema_version') AS version,
       (SELECT count(*) FROM schema_migrations) AS migrations`,
    [config.schema],
  );
  return {tables: present.size, ...meter.rows[0]};
}

async function main() {
  const owner = connection('owner');
  const runtimeUser = env('ALRIFAI_REVIEW_DB_USER');
  const client = new pg.Client({
    host: owner.host, port: owner.port, database: owner.database,
    user: owner.user, password: owner.password, application_name: 'al-rifai-installer',
  });
  await client.connect();
  try {
    const state = await preflight(client, owner);
    console.log(JSON.stringify({step: 'preflight', ...state}, null, 2));
    if (flag('preflight')) {
      console.log('preflight complete; nothing was changed');
      return;
    }
    if (state.alreadyInstalled && !flag('force')) {
      throw new InstallError('ALREADY_INSTALLED', `schema ${owner.schema} already has schema_meta; use --force to re-apply idempotently`);
    }
    if (!state.runtimeRoleExists) {
      throw new InstallError(
        'RUNTIME_ROLE_MISSING',
        `role ${runtimeUser} does not exist; create it first (see README §4)`,
      );
    }

    const schemaSql = readFileSync(SCHEMA_FILE, 'utf8');
    // Session-level search_path: migrations, seeding and verification all run
    // inside the target schema (dedicated database or a tenant schema).
    if (owner.schema !== 'public') {
      // Only create when absent: CREATE SCHEMA IF NOT EXISTS still requires
      // CREATE on the database, which a least-privilege owner may not have when
      // the schema was provisioned by the DBA.
      const exists = await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [owner.schema]);
      if (!exists.rows[0]?.present) {
        await client.query(`CREATE SCHEMA "${owner.schema}"`);
      }
    }
    await client.query(`SET search_path TO "${owner.schema}"`);
    await client.query('BEGIN');
    // `--force` on an installed schema means "apply additive layers and grants",
    // never "re-run the non-idempotent baseline". The baseline contains plain
    // CREATE TABLE/CREATE FUNCTION statements and cannot be replayed safely.
    if (!state.alreadyInstalled) {
      await client.query(schemaSql);
      console.log(JSON.stringify({step: 'schema', applied: SCHEMA_FILE, schema: owner.schema}));
    }
    // Record every additive layer in the same ledger the migration runner uses,
    // so a fresh install and an upgraded installation converge on the identical
    // table set and migration history.
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    for (const file of EXTRA_SCHEMA_FILES) {
      if (!existsSync(file)) continue;
      const sql = readFileSync(file, 'utf8');
      await client.query(sql);
      const name = file.split('/').pop();
      await client.query(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES ($1,$2,$3) ON CONFLICT (version) DO NOTHING`,
        [name.slice(0, 3), name, createHash('sha256').update(sql).digest('hex')],
      );
      console.log(JSON.stringify({step: 'schema', applied: file, schema: owner.schema}));
    }
    await grantRuntime(client, {schema: owner.schema, runtimeUser});
    await client.query('COMMIT');

    if (flag('admin-user') || setting('ALRIFAI_BOOTSTRAP_ADMIN_USERNAME')) {
      const username = arg('admin-user') ?? setting('ALRIFAI_BOOTSTRAP_ADMIN_USERNAME');
      const password = arg('admin-password') ?? secret('ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD');
      const displayName = arg('admin-name') ?? setting('ALRIFAI_BOOTSTRAP_ADMIN_NAME') ?? username;
      if (!username || !password) throw new InstallError('ADMIN_CREDENTIALS_REQUIRED');
      if (password.length < 8) throw new InstallError('ADMIN_PASSWORD_TOO_SHORT');
      const id = await seedAdmin(client, {username, password, displayName});
      console.log(JSON.stringify({step: 'admin', username, id}));
    }

    const result = await verify(client, owner);
    console.log(JSON.stringify({step: 'verify', ...result}));
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
    code: error?.code ?? 'INSTALL_FAILED',
    message: String(error?.message ?? error).slice(0, 500),
  }));
  process.exitCode = 1;
});
