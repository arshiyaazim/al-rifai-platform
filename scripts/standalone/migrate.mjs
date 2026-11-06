#!/usr/bin/env node
// AL-RIFA'I — incremental, checksum-tracked migration runner.
//
// Applies the additive `db/standalone/00N_*.sql` layers to an existing
// installation. It never re-runs the non-idempotent baseline `schema.sql`; a
// fresh installation is created by scripts/standalone/install.mjs.
//
//   node --experimental-strip-types scripts/standalone/migrate.mjs --preflight
//   node --experimental-strip-types scripts/standalone/migrate.mjs
//   node --experimental-strip-types scripts/standalone/migrate.mjs --dry-run
//
// The ledger lives in `schema_migrations` inside the target schema. Each file is
// hashed before it is applied. Re-running is a no-op; changing an already
// applied file requires the explicit --allow-checksum-change flag.
import {createHash} from 'node:crypto';
import {existsSync, readdirSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';
import {grantRuntime} from './grants.mjs';

loadEnv();

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = join(HERE, '..', '..');
const MIGRATION_DIR = join(APP_ROOT, 'db', 'standalone');
const IDENT = /^[A-Za-z_][A-Za-z0-9_$]*$/;

class MigrationError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

const env = (name) => (process.env[name] ?? '').trim();
const flag = (name) => process.argv.includes(`--${name}`);

function connection(role) {
  const host = env('PGHOST');
  const database = env('PGDATABASE');
  const port = Number(env('PGPORT') || 5432);
  const schema = env('PGSCHEMA') || 'public';
  if (!host) throw new MigrationError('DATABASE_CONFIG_MISSING:PGHOST');
  if (!database) throw new MigrationError('DATABASE_CONFIG_MISSING:PGDATABASE');
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new MigrationError('DATABASE_CONFIG_INVALID:PGPORT');
  }
  if (!IDENT.test(schema)) throw new MigrationError('DATABASE_CONFIG_INVALID:PGSCHEMA');
  const user = role === 'runtime' ? env('ALRIFAI_REVIEW_DB_USER') : env('PGUSER');
  if (!user) {
    throw new MigrationError(`DATABASE_CONFIG_MISSING:${role === 'runtime' ? 'ALRIFAI_REVIEW_DB_USER' : 'PGUSER'}`);
  }
  const password = secret(role === 'runtime' ? 'ALRIFAI_REVIEW_PASSWORD' : 'PGPASSWORD');
  if (!password) {
    throw new MigrationError(`DATABASE_CONFIG_MISSING:${role === 'runtime' ? 'ALRIFAI_REVIEW_PASSWORD' : 'PGPASSWORD'}`);
  }
  return {host, port, database, schema, user, password};
}

function migrationFiles() {
  return readdirSync(MIGRATION_DIR)
    .filter((name) => /^\d{3}_.+\.sql$/.test(name))
    .filter((name) => !name.startsWith('001_'))
    .sort()
    .map((name) => ({
      name,
      version: name.slice(0, 3),
      path: join(MIGRATION_DIR, name),
      checksum: createHash('sha256').update(readFileSync(join(MIGRATION_DIR, name))).digest('hex'),
    }));
}

async function main() {
  const owner = connection('owner');
  const runtimeUser = env('ALRIFAI_REVIEW_DB_USER');
  if (!runtimeUser) throw new MigrationError('DATABASE_CONFIG_MISSING:ALRIFAI_REVIEW_DB_USER');

  const client = new pg.Client({
    host: owner.host,
    port: owner.port,
    database: owner.database,
    user: owner.user,
    password: owner.password,
    application_name: 'al-rifai-migrate',
  });
  await client.connect();
  try {
    if (owner.schema !== 'public') {
      const exists = await client.query('SELECT to_regnamespace($1) IS NOT NULL AS present', [owner.schema]);
      if (!exists.rows[0]?.present) throw new MigrationError('SCHEMA_NOT_FOUND', owner.schema);
    }
    await client.query(`SET search_path TO "${owner.schema}"`);

    const installed = await client.query("SELECT to_regclass('schema_meta') IS NOT NULL AS present");
    if (!installed.rows[0]?.present) {
      throw new MigrationError('BASELINE_REQUIRED', 'run scripts/standalone/install.mjs first');
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        name       text NOT NULL,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const files = migrationFiles();
    const applied = await client.query('SELECT version, name, checksum FROM schema_migrations ORDER BY version');
    const byVersion = new Map(applied.rows.map((row) => [row.version, row]));
    const plan = files.map((file) => {
      const prior = byVersion.get(file.version);
      if (!prior) return {...file, action: 'APPLY'};
      if (prior.checksum !== file.checksum) {
        return {...file, action: flag('allow-checksum-change') ? 'REAPPLY' : 'CHECKSUM_CHANGED', prior: prior.checksum};
      }
      return {...file, action: 'SKIP'};
    });

    console.log(JSON.stringify({
      step: 'preflight',
      database: owner.database,
      schema: owner.schema,
      currentVersion: (await client.query("SELECT value FROM schema_meta WHERE key='schema_version'")).rows[0]?.value ?? null,
      pending: plan.filter((item) => item.action !== 'SKIP').map((item) => ({version: item.version, name: item.name, action: item.action})),
    }, null, 2));

    if (flag('preflight') || flag('dry-run')) {
      console.log('preflight complete; nothing was changed');
      return;
    }

    for (const item of plan) {
      if (item.action === 'SKIP') continue;
      if (item.action === 'CHECKSUM_CHANGED') {
        throw new MigrationError('MIGRATION_CHECKSUM_CHANGED', `${item.name} (${item.prior} -> ${item.checksum})`);
      }
      if (!existsSync(item.path)) throw new MigrationError('MIGRATION_FILE_MISSING', item.name);
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(item.path, 'utf8'));
        if (item.action === 'REAPPLY') {
          await client.query(
            `UPDATE schema_migrations SET name=$2, checksum=$3, applied_at=now() WHERE version=$1`,
            [item.version, item.name, item.checksum],
          );
        } else {
          await client.query(
            `INSERT INTO schema_migrations (version, name, checksum) VALUES ($1,$2,$3)`,
            [item.version, item.name, item.checksum],
          );
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new MigrationError('MIGRATION_FAILED', `${item.name}: ${String(error?.message ?? error).slice(0, 400)}`);
      }
      console.log(JSON.stringify({step: 'migration', applied: item.name, version: item.version}));
    }

    await grantRuntime(client, {schema: owner.schema, runtimeUser});
    const version = await client.query("SELECT value FROM schema_meta WHERE key='schema_version'");
    const counts = await client.query(
      `SELECT
         (SELECT count(*) FROM information_schema.tables WHERE table_schema=$1 AND table_type='BASE TABLE') AS tables,
         (SELECT count(*) FROM schema_migrations) AS migrations`,
      [owner.schema],
    );
    console.log(JSON.stringify({
      step: 'verify',
      schemaVersion: version.rows[0]?.value ?? null,
      tables: Number(counts.rows[0]?.tables ?? 0),
      migrations: Number(counts.rows[0]?.migrations ?? 0),
    }, null, 2));
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    status: 'FAILED',
    code: error?.code ?? 'MIGRATION_FAILED',
    message: String(error?.message ?? error).slice(0, 500),
  }));
  process.exitCode = 1;
});
