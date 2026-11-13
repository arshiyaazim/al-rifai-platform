// Vessel reference directory writer (Owner rule R).
//
// The `vessels` table is a suggestion list for the register typeaheads. It is
// never the authority for a program row: programs keep the raw source name. A
// name is added only when it is not already present under the same role, so a
// replayed message cannot create a duplicate suggestion.

import type {PoolClient} from 'pg';
import {compareVesselNames} from '../../vessel-match.ts';

export type VesselRole = 'mother' | 'lighter';

/**
 * Add a vessel name when no existing name is within the fuzzy-match tolerance.
 * Returns the exact stored name (existing or newly inserted).
 */
export async function ensureVessel(
  client: Pick<PoolClient, 'query'>,
  name: string | null | undefined,
  role: VesselRole,
): Promise<string | null> {
  const value = String(name ?? '').trim();
  if (!value) return null;
  const existing = await client.query<{vessel_name: string}>(
    `SELECT vessel_name FROM vessels WHERE vessel_type = $1 ORDER BY vessel_name`,
    [role],
  );
  const match = existing.rows.find((row) => compareVesselNames(row.vessel_name, value) !== 'DIFFERENT');
  if (match) return match.vessel_name;
  await client.query(
    `INSERT INTO vessels (vessel_name, vessel_type, created_by)
     VALUES ($1, $2, 'system')
     ON CONFLICT (vessel_name, vessel_type) DO NOTHING`,
    [value, role],
  );
  return value;
}
