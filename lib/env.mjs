// AL-RIFA'I — single configuration source.
//
// The whole application reads its settings from one file: `.env` at the project
// root (next to package.json). This module is the only place that parses it.
//
//   * the web application loads it at boot (instrumentation + deploy entry),
//   * the installer, the importer and the sync worker load it explicitly,
//   * inside a container the same keys arrive as environment variables, so a
//     value already present in `process.env` always wins over the file.
//
// Secrets are never logged, echoed or returned. Errors name the key, never its
// value.
import {existsSync, readFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

/** Absolute path of the configuration file (override with ALRIFAI_ENV_FILE). */
export function envFilePath() {
  return process.env.ALRIFAI_ENV_FILE || join(ROOT, '.env');
}

/**
 * Parse the small subset of dotenv syntax this project uses:
 *   KEY=value
 *   export KEY=value
 *   KEY="value"   KEY='value'
 *   # comment
 * A `#` inside an unquoted value starts a comment; inside quotes it does not.
 */
export function parseEnv(text) {
  const result = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Load `.env` into process.env without overwriting anything already set.
 * Returns the file used and how many keys it contributed — never the values.
 */
export function loadEnv({file = envFilePath(), override = false} = {}) {
  if (!existsSync(file)) return {file, found: false, loaded: 0};
  let parsed;
  try {
    parsed = parseEnv(readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`ENV_FILE_UNREADABLE:${file}`);
  }
  let loaded = 0;
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && process.env[key] !== undefined) continue;
    process.env[key] = value;
    loaded += 1;
  }
  return {file, found: true, loaded};
}

/** Read one value, trimmed. Returns '' when the key is absent or blank. */
export function setting(name) {
  const raw = process.env[name];
  return typeof raw === 'string' ? raw.trim() : '';
}

/** Read a secret either inline (KEY) or from a file (KEY_FILE). Never logged. */
export function secret(name) {
  const inline = setting(name);
  if (inline) return inline;
  const file = setting(`${name}_FILE`);
  if (file && existsSync(file)) {
    const value = readFileSync(file, 'utf8').trim();
    if (value) return value;
  }
  return '';
}
