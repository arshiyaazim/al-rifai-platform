#!/usr/bin/env node
// One-off mother-vessel spelling normaliser. Dry-run by default.
//
// Only a unique fuzzy match against the `vessels` reference directory is
// accepted (TURAN → TOURAN, BULK BEQUA → BULK BEQUIA). Ambiguous names are
// reported and never rewritten. Lighter names are deliberately out of scope.

import {loadEnv} from '../lib/env.mjs';
import {rows} from '../lib/standalone/db.ts';
import {compareVesselNames} from '../lib/vessel-match.ts';

loadEnv();

const APPLY = process.argv.includes('--apply');
const vessels = await rows<{vessel_name: string}>(
  "SELECT vessel_name FROM vessels WHERE vessel_type = 'mother'",
);
const programs = await rows<{id: string; mother_vessel: string}>(
  "SELECT id, mother_vessel FROM programs WHERE state <> 'VOIDED'",
);

const candidatesFor = (name: string) => [...new Set(
  vessels
    .filter((vessel) => compareVesselNames(vessel.vessel_name, name) !== 'DIFFERENT')
    .map((vessel) => vessel.vessel_name),
)];

const changes: Array<{id: string; from: string; to: string}> = [];
const ambiguous: Array<{id: string; name: string; candidates: string[]}> = [];

for (const program of programs) {
  const matches = candidatesFor(program.mother_vessel);
  if (!matches.length) continue;
  if (matches.length > 1) {
    ambiguous.push({id: program.id, name: program.mother_vessel, candidates: matches});
    continue;
  }
  if (matches[0] === program.mother_vessel) continue;
  changes.push({id: program.id, from: program.mother_vessel, to: matches[0]});
}

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY_RUN',
  programs: programs.length,
  changes: changes.length,
  change_list: changes,
  ambiguous: ambiguous.length,
  ambiguous_list: ambiguous,
}, null, 2));

if (APPLY && changes.length) {
  for (const change of changes) {
    await rows(
      `UPDATE programs SET mother_vessel = $2, updated_at = now() WHERE id = $1`,
      [change.id, change.to],
    );
  }
  console.error(`Updated ${changes.length} mother vessel spelling(s).`);
}
