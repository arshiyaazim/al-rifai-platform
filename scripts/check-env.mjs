#!/usr/bin/env node
// AL-RIFA'I — configuration check.
//
// Loads the single `.env` and reports which required keys are present. It never
// prints a value: only the key name and present/absent. Exit code 1 means at
// least one required key is missing.
//
//   node scripts/check-env.mjs
import {loadEnv, envFilePath, secret, setting} from '../lib/env.mjs';

const loaded = loadEnv();

const REQUIRED_PLAIN = [
  'PGHOST', 'PGPORT', 'PGDATABASE', 'PGSCHEMA', 'PGUSER',
  'ALRIFAI_REVIEW_DB_USER',
  'ALRIFAI_UNIFIED_AUTH_MODE',
  'ALRIFAI_UNIFIED_ORIGINS',
  'ALRIFAI_CASH_ORIGIN',
];
const REQUIRED_SECRET = ['PGPASSWORD', 'ALRIFAI_REVIEW_PASSWORD'];
const REQUIRED_SYNC = ['WA01_DB', 'WA02_DB'];

const missing = [];
for (const key of REQUIRED_PLAIN) {
  if (!setting(key)) missing.push(key);
}
for (const key of REQUIRED_SECRET) {
  if (!secret(key)) missing.push(key);
}
for (const key of REQUIRED_SYNC) {
  if (!setting(key)) missing.push(key);
}

const report = {
  file: envFilePath(),
  file_found: loaded.found,
  keys_loaded: loaded.loaded,
  environment_overrides: loaded.found ? 'existing variables win' : 'file absent',
  database: `${setting('PGDATABASE') || '?'}@${setting('PGHOST') || '?'}:${setting('PGPORT') || '?'}`,
  runtime_role: setting('ALRIFAI_REVIEW_DB_USER') || null,
  auth_mode: setting('ALRIFAI_UNIFIED_AUTH_MODE') || null,
  origins_configured: Boolean(setting('ALRIFAI_UNIFIED_ORIGINS')),
  sync_accounts: {
    wa01: Boolean(setting('WA01_DB')),
    wa02: Boolean(setting('WA02_DB')),
  },
  secrets_present: REQUIRED_SECRET.filter((key) => Boolean(secret(key))),
  missing,
};

console.log(JSON.stringify(report, null, 2));
process.exitCode = missing.length ? 1 : 0;
