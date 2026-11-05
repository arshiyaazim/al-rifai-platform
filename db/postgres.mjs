// PostgreSQL connection factory for the standalone edition.
//
// Every connection parameter comes from the environment; no host, port,
// database name, user name or password-file path is hard-coded. The two
// credentials keep the production role separation:
//
//   app    -> PGUSER / PGPASSWORD_FILE                (owner, read-write)
//   review -> ALRIFAI_REVIEW_DB_USER / ALRIFAI_REVIEW_PASSWORD_FILE
//             (least-privilege runtime role, read-only by default)
//   mirror -> ALRIFAI_MIRROR_WORKER_DB_USER / ALRIFAI_MIRROR_WORKER_PASSWORD_FILE
//             (optional; only used by the WhatsApp mirror tooling)
//
// Password contents are read from files and never logged, returned or included
// in an error message. Errors name the environment variable, never its value.
import pg from 'pg';
import {readFileSync, statSync} from 'node:fs';

const DEFAULT_PORT = 5432;
const DEFAULT_SCHEMA = 'public';
const DEFAULT_STATEMENT_TIMEOUT_MS = 15_000;
const DEFAULT_POOL_MAX = 5;
const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_IDLE_TIMEOUT_MS = 10_000;

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const DATABASE_NAME = /^[A-Za-z_][A-Za-z0-9_$-]*$/;

/** Role selectors understood by createPool(). */
export const DB_ROLE_APP = 'app';
export const DB_ROLE_REVIEW = 'review';
export const DB_ROLE_MIRROR = 'mirror';

// Names used by the original deployment are accepted as role selectors so the
// existing call sites keep working while the real user name stays configurable.
const ROLE_ALIASES = new Map([
  [DB_ROLE_APP, DB_ROLE_APP],
  [DB_ROLE_REVIEW, DB_ROLE_REVIEW],
  [DB_ROLE_MIRROR, DB_ROLE_MIRROR],
  ['alrifai_app', DB_ROLE_APP],
  ['ir_review_runtime', DB_ROLE_REVIEW],
  ['alrifai_mirror_worker', DB_ROLE_MIRROR],
]);

const CREDENTIALS = {
  [DB_ROLE_APP]: {userVar: 'PGUSER', fileVar: 'PGPASSWORD_FILE', defaultUser: null},
  [DB_ROLE_REVIEW]: {
    userVar: 'ALRIFAI_REVIEW_DB_USER',
    fileVar: 'ALRIFAI_REVIEW_PASSWORD_FILE',
    defaultUser: null,
  },
  [DB_ROLE_MIRROR]: {
    userVar: 'ALRIFAI_MIRROR_WORKER_DB_USER',
    fileVar: 'ALRIFAI_MIRROR_WORKER_PASSWORD_FILE',
    defaultUser: null,
  },
};

const configError = (code) => new Error(`DATABASE_CONFIG_${code}`);

function envValue(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

function requiredEnv(name) {
  const value = envValue(name);
  if (!value) throw configError(`MISSING:${name}`);
  return value;
}

function readPort() {
  const raw = envValue('PGPORT');
  if (!raw) return DEFAULT_PORT;
  if (!/^\d{1,5}$/.test(raw)) throw configError('INVALID:PGPORT');
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw configError('INVALID:PGPORT');
  return port;
}

function readSchema() {
  const schema = envValue('PGSCHEMA') || DEFAULT_SCHEMA;
  if (!IDENTIFIER.test(schema)) throw configError('INVALID:PGSCHEMA');
  return schema;
}

function readDatabase() {
  const database = requiredEnv('PGDATABASE');
  if (database.length > 63 || !DATABASE_NAME.test(database)) throw configError('INVALID:PGDATABASE');
  return database;
}

function readHost() {
  const host = requiredEnv('PGHOST');
  if (/\s/.test(host) || host.length > 255) throw configError('INVALID:PGHOST');
  return host;
}

function readUser(role) {
  const spec = CREDENTIALS[role];
  if (!spec) throw configError(`UNKNOWN_ROLE:${role}`);
  const user = envValue(spec.userVar);
  if (!user) throw configError(`MISSING:${spec.userVar}`);
  if (!IDENTIFIER.test(user)) throw configError(`INVALID:${spec.userVar}`);
  return user;
}

/** Read a password from a file. The contents are never echoed anywhere. */
function readPassword(role) {
  const spec = CREDENTIALS[role];
  const file = envValue(spec.fileVar);
  if (!file) throw configError(`MISSING:${spec.fileVar}`);
  let stats;
  try {
    stats = statSync(file);
  } catch {
    throw configError(`UNREADABLE:${spec.fileVar}`);
  }
  if (!stats.isFile()) throw configError(`NOT_A_FILE:${spec.fileVar}`);
  let password;
  try {
    password = readFileSync(file, 'utf8').trim();
  } catch {
    throw configError(`UNREADABLE:${spec.fileVar}`);
  }
  if (!password) throw configError(`EMPTY:${spec.fileVar}`);
  return password;
}

/** Map a role selector or an explicit user name to a known role. */
function resolveRole({role, user}) {
  const selector = role ?? user ?? DB_ROLE_APP;
  const resolved = ROLE_ALIASES.get(String(selector));
  if (resolved) return resolved;
  // Allow an explicit user name that matches one of the configured roles.
  for (const candidate of [DB_ROLE_APP, DB_ROLE_REVIEW, DB_ROLE_MIRROR]) {
    const spec = CREDENTIALS[candidate];
    const configured = envValue(spec.userVar);
    if (configured && configured === selector) return candidate;
  }
  throw configError(`UNKNOWN_ROLE:${selector}`);
}

function positiveInteger(value, fallback, code) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < 1) throw configError(`INVALID:${code}`);
  return value;
}

/**
 * Resolve the full connection settings including the password.
 * Internal: the password is only ever handed to the driver.
 */
function resolveConnection({role, user, schema} = {}) {
  const resolvedRole = resolveRole({role, user});
  const resolvedSchema = schema ?? readSchema();
  if (!IDENTIFIER.test(resolvedSchema)) throw configError('INVALID:PGSCHEMA');
  return {
    role: resolvedRole,
    host: readHost(),
    port: readPort(),
    database: readDatabase(),
    schema: resolvedSchema,
    user: readUser(resolvedRole),
    password: readPassword(resolvedRole),
  };
}

/**
 * Resolve the connection settings without opening a connection and without
 * returning the password. Validates every required setting, so a misconfigured
 * install fails at startup rather than on the first query.
 */
export function databaseConfig(options = {}) {
  const {password, ...safe} = resolveConnection(options);
  void password;
  return safe;
}

/**
 * Create a pool.
 *
 * @param {object} [options]
 * @param {boolean} [options.readOnly=true]  run with default_transaction_read_only
 * @param {string}  [options.role]           'app' | 'review' | 'mirror' (or a legacy alias)
 * @param {string}  [options.user]           explicit role selector; same table as role
 * @param {string}  [options.schema]         overrides PGSCHEMA
 * @param {number}  [options.max]
 * @param {number}  [options.connectionTimeoutMillis]
 * @param {number}  [options.idleTimeoutMillis]
 * @param {number}  [options.statementTimeout] statement_timeout in ms
 * @param {string}  [options.applicationName]
 */
export function createPool(options = {}) {
  const {
    readOnly = true,
    role,
    user,
    schema,
    max = DEFAULT_POOL_MAX,
    connectionTimeoutMillis = DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis = DEFAULT_IDLE_TIMEOUT_MS,
    statementTimeout = DEFAULT_STATEMENT_TIMEOUT_MS,
    applicationName,
  } = options;
  const config = resolveConnection({role, user, schema});
  const timeout = positiveInteger(statementTimeout, DEFAULT_STATEMENT_TIMEOUT_MS, 'STATEMENT_TIMEOUT');
  const poolMax = positiveInteger(max, DEFAULT_POOL_MAX, 'POOL_MAX');
  const connectTimeout = positiveInteger(
    connectionTimeoutMillis,
    DEFAULT_CONNECT_TIMEOUT_MS,
    'CONNECT_TIMEOUT',
  );
  const idleTimeout = positiveInteger(idleTimeoutMillis, DEFAULT_IDLE_TIMEOUT_MS, 'IDLE_TIMEOUT');
  return new pg.Pool({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    password: config.password,
    max: poolMax,
    connectionTimeoutMillis: connectTimeout,
    idleTimeoutMillis: idleTimeout,
    options: `-c search_path=${config.schema} -c statement_timeout=${timeout} -c default_transaction_read_only=${readOnly ? 'on' : 'off'}`,
    application_name: applicationName ?? `al-rifai-${config.role}`,
  });
}
