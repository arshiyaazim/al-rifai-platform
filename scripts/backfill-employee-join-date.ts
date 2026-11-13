#!/usr/bin/env node
// AL-RIFA'I — one-off backfill: employee join date from real evidence.
//
// Operator-approved rule:
//   A = the WhatsApp timestamp of the message that carried the employee's
//       first cash payment (cash_instructions.source_message_id ->
//       whatsapp_messages.source_timestamp).
//   B = the duty start date of the employee's first vessel assignment
//       (program_assignments.start_date); the assignment/confirmation message
//       timestamp is only a fallback.
//   join date = the earlier of A and B, as an Asia/Dhaka calendar date.
//
// created_at, updated_at, import time and backfill-run time are NEVER used.
//
// Safety:
//   * DRY RUN by default. Nothing is written unless `--apply` is passed.
//   * Only employees whose date_of_join AND joined_on are both NULL are touched.
//   * Writes both columns, exactly like the employee edit form
//     (lib/standalone/employees.ts updateEmployee sets date_of_join = joined_on).
//   * Idempotent: re-running after an apply updates zero rows.
//   * Refuses to apply when a safety gate fails (see reportGates).
//
// Usage:
//   node --experimental-strip-types scripts/backfill-employee-join-date.ts
//   node --experimental-strip-types scripts/backfill-employee-join-date.ts --apply
//
// Environment: the usual PG* keys (ALRIFAI_ENV_FILE is honoured by lib/env).

import {loadEnv} from '../lib/env.mjs';
import {rows, tx} from '../lib/standalone/db.ts';
import {recordAudit} from '../lib/standalone/audit.ts';
import type {Actor} from '../lib/standalone/db.ts';

loadEnv();

const APPLY = process.argv.includes('--apply');
const actor: Actor = {id: 'system:join-date-backfill', role: 'ADMIN'};
const DHAKA = 'Asia/Dhaka';

type Evidence = {
  employee_mobile: string;
  preferred_name: string;
  cash_at: string | null;
  vessel_start: string | null;
};

type Derived = {
  mobile: string;
  name: string;
  date: string;
  source: 'CASH' | 'VESSEL' | 'BOTH';
};

const dhakaDate = (value: string | null | undefined): string | null => {
  if (!value) return null;
  const at = new Date(value);
  if (!Number.isFinite(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-CA', {timeZone: DHAKA, year: 'numeric', month: '2-digit', day: '2-digit'})
    .format(at);
};

const evidence = await rows<Evidence>(
  `WITH cash AS (
     SELECT i.employee_mobile, min(w.source_timestamp) AS first_at
       FROM cash_instructions i
       JOIN whatsapp_messages w ON w.message_id = i.source_message_id AND w.deleted_at IS NULL
      WHERE i.source_message_id IS NOT NULL
        AND i.employee_mobile IS NOT NULL
      GROUP BY i.employee_mobile
   ), vessel AS (
     SELECT pa.employee_mobile, min(pa.start_date) AS first_start
       FROM program_assignments pa
      GROUP BY pa.employee_mobile
   )
   SELECT e.employee_mobile,
          e.preferred_name,
          c.first_at::text AS cash_at,
          v.first_start::text AS vessel_start
     FROM employees e
     LEFT JOIN cash c ON c.employee_mobile = e.employee_mobile
     LEFT JOIN vessel v ON v.employee_mobile = e.employee_mobile
    WHERE e.date_of_join IS NULL AND e.joined_on IS NULL
    ORDER BY e.employee_mobile`,
);

const derived: Derived[] = [];
const noEvidence: Evidence[] = [];
for (const item of evidence) {
  const cashDate = dhakaDate(item.cash_at);
  const vesselDate = item.vessel_start ? String(item.vessel_start).slice(0, 10) : null;
  if (!cashDate && !vesselDate) {
    noEvidence.push(item);
    continue;
  }
  const date = cashDate && vesselDate ? (cashDate < vesselDate ? cashDate : vesselDate) : (cashDate ?? vesselDate) as string;
  const source = cashDate && vesselDate ? 'BOTH' : cashDate ? 'CASH' : 'VESSEL';
  derived.push({mobile: item.employee_mobile, name: item.preferred_name, date, source});
}

// Cash instructions with no usable WhatsApp evidence (office / legacy rows).
const orphanCash = await rows<{employee_mobile: string; rows: string; earliest: string | null; latest: string | null}>(
  `SELECT i.employee_mobile,
          count(*)::text AS rows,
          min(coalesce(i.event_at, i.created_at))::text AS earliest,
          max(coalesce(i.event_at, i.created_at))::text AS latest
     FROM cash_instructions i
     LEFT JOIN whatsapp_messages w ON w.message_id = i.source_message_id AND w.deleted_at IS NULL
    WHERE i.source_message_id IS NULL OR w.message_id IS NULL
    GROUP BY i.employee_mobile
    ORDER BY count(*) DESC`,
);

const dateCounts = new Map<string, number>();
for (const item of derived) dateCounts.set(item.date, (dateCounts.get(item.date) ?? 0) + 1);
const topDates = [...dateCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);

const oldestMessage = await rows<{oldest: string | null}>(
  "SELECT min(source_timestamp)::text AS oldest FROM whatsapp_messages WHERE deleted_at IS NULL",
);
const oldestDate = dhakaDate(oldestMessage[0]?.oldest);
const today = dhakaDate(new Date().toISOString());

// Bulk-creation dates: days on which many employee rows were inserted. A derived
// join date that matches one of these is treated as a backfill artefact, not
// real evidence.
const createdClusters = await rows<{day: string; count: string}>(
  `SELECT to_char(created_at AT TIME ZONE '${DHAKA}', 'YYYY-MM-DD') AS day, count(*)::text AS count
     FROM employees GROUP BY 1 HAVING count(*) >= 20 ORDER BY count(*) DESC`,
);

const gates: Array<{name: string; ok: boolean; detail: string}> = [];
const total = evidence.length;
const biggest = topDates[0];
gates.push({
  name: 'single-date share <= 15%',
  ok: !biggest || biggest[1] <= Math.ceil(total * 0.15),
  detail: biggest ? `${biggest[0]} = ${biggest[1]}/${total} (${(biggest[1] / Math.max(total, 1) * 100).toFixed(1)}%)` : 'no derived dates',
});
const outOfRange = derived.filter((item) => (today && item.date > today) || (oldestDate && item.date < oldestDate));
gates.push({
  name: 'dates inside WhatsApp history window',
  ok: outOfRange.length === 0,
  detail: `oldest message ${oldestDate ?? '—'}, today ${today ?? '—'}, out-of-range ${outOfRange.length}`,
});
const clusterDays = new Set(createdClusters.map((cluster) => cluster.day));
const clustered = derived.filter((item) => clusterDays.has(item.date));
gates.push({
  name: 'no derived date matches a bulk created_at cluster',
  ok: clustered.length === 0,
  detail: clustered.length
    ? `${clustered.length} rows match clusters: ${[...new Set(clustered.map((item) => item.date))].join(', ')}`
    : `bulk-created days checked: ${createdClusters.map((cluster) => `${cluster.day}(${cluster.count})`).join(', ') || 'none'}`,
});

console.log(JSON.stringify({
  mode: APPLY ? 'APPLY' : 'DRY-RUN',
  employeesMissingJoinDate: total,
  derived: derived.length,
  noEvidence: noEvidence.length,
  orphanCashEmployees: orphanCash.length,
  sources: derived.reduce<Record<string, number>>((acc, item) => ({...acc, [item.source]: (acc[item.source] ?? 0) + 1}), {}),
  gates,
}, null, 2));

console.log('\n--- per employee (mobile | name | date | source) ---');
for (const item of derived) console.log(`${item.mobile} | ${item.name} | ${item.date} | ${item.source}`);

console.log('\n--- no evidence (stay NULL) ---');
for (const item of noEvidence) console.log(`${item.employee_mobile} | ${item.preferred_name}`);

console.log('\n--- cash rows without WhatsApp evidence (office/legacy) ---');
for (const item of orphanCash) console.log(`${item.employee_mobile} | rows=${item.rows} | ${item.earliest} -> ${item.latest}`);

console.log('\n--- top 10 derived dates ---');
for (const [date, count] of topDates) console.log(`${date} | ${count}`);

const failed = gates.filter((gate) => !gate.ok);
if (failed.length) {
  console.log(`\nGATES FAILED (${failed.map((gate) => gate.name).join('; ')}). Nothing was written.`);
  process.exitCode = 2;
} else if (!APPLY) {
  console.log('\nDry run only. Re-run with --apply to write.');
} else {
  const updated = await tx(async (client) => {
    let count = 0;
    for (const item of derived) {
      const result = await client.query(
        `UPDATE employees
            SET date_of_join = $2, joined_on = $2, revision = revision + 1
          WHERE employee_mobile = $1 AND date_of_join IS NULL AND joined_on IS NULL`,
        [item.mobile, item.date],
      );
      if (!result.rowCount) continue;
      count += 1;
      await recordAudit({
        actor,
        action: 'EMPLOYEE_JOIN_DATE_BACKFILLED',
        entity: 'employee',
        entityId: item.mobile,
        detail: {joinDate: item.date, source: item.source, rule: 'earlier(first cash message, first vessel assignment)'},
      }, client);
    }
    return count;
  });
  console.log(`\nApplied. Rows updated: ${updated}`);
}
