#!/usr/bin/env node
// Mother-vessel consolidation (data-only, reversible).
//
// - Unicode code-point edit distance <= 3 after the existing MV / cargo /
//   punctuation normalization.
// - Canonical = highest program count; tie -> shorter normalized name, then
//   lexical order. Only compare to the chosen canonical, so A≈B and B≈C do not
//   merge A with C transitively.
// - Different digit runs are never merged; names shorter than 5 are kept.
// - Does not touch program_pay, program_assignments or any cash table.
//
// Usage (inside a one-off platform image container):
//   node --experimental-strip-types scripts/standalone/consolidate-mother-vessels.mjs \
//     --backup-dir /backup/2026-11-11 --apply

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import pg from 'pg';
import {buildMotherClusters} from '../../lib/vessel-canonical.ts';

const APPLY = process.argv.includes('--apply');
const backupDirArg = process.argv.indexOf('--backup-dir');
const BACKUP_DIR = backupDirArg >= 0 ? process.argv[backupDirArg + 1] : '/tmp/mother-vessel-backup';
const DB = {
  host: process.env.PGHOST, port: Number(process.env.PGPORT || 5432),
  database: process.env.PGDATABASE, user: process.env.PGUSER, password: process.env.PGPASSWORD,
  options: '-c default_transaction_read_only=off',
};

const client = new pg.Client(DB);
await client.connect();
try {
  const names = (await client.query(
    `SELECT mother_vessel AS name, count(*)::int AS count
       FROM programs WHERE state <> 'VOIDED' GROUP BY mother_vessel`,
  )).rows;
  const clusters = buildMotherClusters(names);
  const aliases = {};
  for (const cluster of clusters) for (const alias of cluster.aliases) aliases[alias] = cluster.name;
  const ambiguous = clusters.filter((c) => c.ambiguous.length);

  const programs = (await client.query(
    `SELECT id, mother_vessel FROM programs ORDER BY id`,
  )).rows;
  const vessels = (await client.query(
    `SELECT vessel_name FROM vessels WHERE vessel_type = 'mother' ORDER BY vessel_name`,
  )).rows;
  const beforePay = (await client.query(
    `SELECT count(*)::int AS pay_rows,
            coalesce(sum(total_minor),0)::text AS total_minor,
            coalesce(sum(shifts),0)::text AS shifts
       FROM program_pay`,
  )).rows[0];
  const beforePrograms = (await client.query('SELECT count(*)::int AS n FROM programs')).rows[0].n;
  const beforeAssignments = (await client.query('SELECT count(*)::int AS n FROM program_assignments')).rows[0].n;

  mkdirSync(BACKUP_DIR, {recursive: true, mode: 0o700});
  const csv = (rows) => rows.map((row) => Object.values(row).map((v) => `"${String(v ?? '').replaceAll('"', '""')}"`).join(',')).join('\n') + '\n';
  writeFileSync(join(BACKUP_DIR, 'programs-mother-before.csv'), csv(programs));
  writeFileSync(join(BACKUP_DIR, 'vessels-mother-before.csv'), csv(vessels));
  writeFileSync(join(BACKUP_DIR, 'mapping.json'), JSON.stringify({generatedAt: new Date().toISOString(), aliases, clusters, ambiguous}, null, 2));
  const rollback = ['BEGIN;',
    ...programs.filter((p) => aliases[p.mother_vessel]).map((p) =>
      `UPDATE programs SET mother_vessel = '${String(p.mother_vessel).replaceAll("'", "''")}' WHERE id = '${String(p.id).replaceAll("'", "''")}';`),
    ...vessels.filter((v) => aliases[v.vessel_name]).map((v) =>
      `INSERT INTO vessels (vessel_name, vessel_type, created_by) VALUES ('${String(v.vessel_name).replaceAll("'", "''")}','mother','rollback') ON CONFLICT DO NOTHING;`),
    `DELETE FROM app_settings WHERE key = 'vessel.mother_aliases';`,
    'COMMIT;', ''].join('\n');
  writeFileSync(join(BACKUP_DIR, 'rollback.sql'), rollback);

  console.log(JSON.stringify({mode: APPLY ? 'apply' : 'dry-run', backupDir: BACKUP_DIR,
    clusters: clusters.filter((c) => c.aliases.length || c.ambiguous.length), ambiguous,
    aliases, beforePay, beforePrograms, beforeAssignments}, null, 2));

  if (!APPLY) { console.log('dry-run only; pass --apply'); process.exit(0); }
  if (ambiguous.length) throw new Error('AMBIGUOUS_CLUSTERS_REQUIRE_REVIEW');

  await client.query('BEGIN');
  for (const [alias, canonical] of Object.entries(aliases)) {
    await client.query('UPDATE programs SET mother_vessel = $1 WHERE mother_vessel = $2', [canonical, alias]);
  }
  for (const canonical of new Set(Object.values(aliases))) {
    await client.query(`INSERT INTO vessels (vessel_name, vessel_type, created_by)
      VALUES ($1,'mother','consolidation') ON CONFLICT DO NOTHING`, [canonical]);
  }
  for (const alias of Object.keys(aliases)) {
    await client.query("DELETE FROM vessels WHERE vessel_type='mother' AND vessel_name=$1", [alias]);
  }
  await client.query(
    `INSERT INTO app_settings (key, value) VALUES ('vessel.mother_aliases', $1::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({aliases, generatedAt: new Date().toISOString()})],
  );
  await client.query('COMMIT');

  const afterPay = (await client.query(
    `SELECT count(*)::int AS pay_rows, coalesce(sum(total_minor),0)::text AS total_minor,
            coalesce(sum(shifts),0)::text AS shifts FROM program_pay`)).rows[0];
  const afterPrograms = (await client.query('SELECT count(*)::int AS n FROM programs')).rows[0].n;
  const afterAssignments = (await client.query('SELECT count(*)::int AS n FROM program_assignments')).rows[0].n;
  const remaining = (await client.query(
    `SELECT mother_vessel, count(*)::int AS n FROM programs WHERE state <> 'VOIDED' GROUP BY 1 ORDER BY 1`)).rows;
  console.log(JSON.stringify({applied: true, afterPay, afterPrograms, afterAssignments, remaining}, null, 2));
} catch (error) {
  await client.query('ROLLBACK').catch(() => undefined);
  console.error(JSON.stringify({status: 'FAILED', message: String(error?.message ?? error)}));
  process.exitCode = 1;
} finally {
  await client.end();
}
