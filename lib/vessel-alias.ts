import type {PoolClient} from 'pg';
import {row} from './standalone/db.ts';

export type MotherAliasMap = Record<string, string>;

type Cache = {at: number; aliases: MotherAliasMap};
let cache: Cache | null = null;
const TTL_MS = 60_000;

const normaliseKey = (value: unknown) => String(value ?? '')
  .toUpperCase()
  .replace(/\s+/g, ' ')
  .trim();

export async function loadMotherAliases(client?: Pick<PoolClient, 'query'>): Promise<MotherAliasMap> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.aliases;
  const sql = "SELECT value FROM app_settings WHERE key = 'vessel.mother_aliases'";
  const result = client
    ? await client.query<{value: {aliases?: MotherAliasMap}}>(sql)
    : null;
  const setting = result
    ? result.rows[0]
    : await row<{value: {aliases?: MotherAliasMap}}>(sql);
  const aliases = setting?.value?.aliases ?? {};
  cache = {at: Date.now(), aliases};
  return aliases;
}

/** Resolve an already-normalised mother name to the canonical spelling. */
export async function resolveMotherVesselAlias(
  name: string,
  client?: Pick<PoolClient, 'query'>,
): Promise<string> {
  const key = normaliseKey(name);
  if (!key) return key;
  const aliases = await loadMotherAliases(client);
  return aliases[key] ?? key;
}

export function clearMotherAliasCache(): void {
  cache = null;
}
