#!/usr/bin/env node
// AL-RIFA'I — legacy business-data importer (dry-run by default).
//
// Source: the historical `alrifai` PostgreSQL database (read-only).
// Target: the current Phase 3 database, normally an isolated clone first.
//
//   node --experimental-strip-types scripts/standalone/import-legacy-business.mjs
//   node ... --domains=all --apply
//
// Domains: employees, rates, programs, attendance, cash-posted, cash-review.
// The importer is idempotent (deterministic IDs / natural keys), preserves
// provenance, and never posts cash unless the cash-posted domain is explicitly
// selected. It is not wired into the web application.
import pg from 'pg';
import {loadEnv, secret} from '../../lib/env.mjs';

loadEnv();

const flag = (name) => process.argv.includes(`--${name}`);
const arg = (name) => {
  const prefix = `--${name}=`;
  const inline = process.argv.find((value) => value.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const ALL_DOMAINS = ['employees', 'rates', 'programs', 'pay', 'attendance', 'cash-posted', 'cash-review'];
const requested = (arg('domains') ?? 'employees,rates,programs,pay,attendance').split(',').map((value) => value.trim()).filter(Boolean);
const domains = requested.includes('all') ? ALL_DOMAINS : requested.filter((value) => ALL_DOMAINS.includes(value));
if (!domains.length) throw new Error('NO_VALID_DOMAINS');

const APPLY = flag('apply');
const SOURCE_DB = arg('source-db') ?? 'alrifai';
const IMPORT_ID = 'legacy-import-v1';
const ACTOR = 'import:legacy';

function connection(database, prefix = '') {
  const host = (process.env[`${prefix}PGHOST`] || process.env.PGHOST || '').trim();
  const port = Number((process.env[`${prefix}PGPORT`] || process.env.PGPORT || '5432').trim());
  const schema = (process.env[`${prefix}PGSCHEMA`] || process.env.PGSCHEMA || 'public').trim() || 'public';
  const user = (process.env[`${prefix}PGUSER`] || process.env.PGUSER || '').trim();
  const password = (process.env[`${prefix}PGPASSWORD`] || '').trim() || secret('PGPASSWORD');
  if (!host || !database || !user || !password) throw new Error('DATABASE_CONFIG_MISSING');
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(schema)) throw new Error('INVALID_SCHEMA');
  return {host, port, database, schema, user, password};
}

const sourceConfig = connection(SOURCE_DB, 'SOURCE_');
const targetConfig = connection((process.env.PGDATABASE ?? '').trim());
if (sourceConfig.database === targetConfig.database) throw new Error('SOURCE_AND_TARGET_MUST_DIFFER');

function normalizeMobile(value) {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `0${digits.slice(3)}`;
  if (/^01[3-9][0-9]{8}$/.test(digits)) return digits;
  return null;
}
function plusMobile(value) {
  const bare = normalizeMobile(value);
  return bare ? `+88${bare}` : null;
}
function isoDate(value) {
  const raw = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : raw;
}
function json(value) {
  return JSON.stringify(value);
}
function clip(value, max) {
  const text = String(value ?? '');
  return text.length > max ? text.slice(0, max) : text;
}

async function main() {
  const source = new pg.Client({...sourceConfig, application_name: 'alrifai-legacy-read'});
  const target = new pg.Client({...targetConfig, application_name: 'alrifai-legacy-import'});
  await source.connect();
  await target.connect();
  const report = {
    step: 'legacy-import',
    mode: APPLY ? 'apply' : 'dry-run',
    source: sourceConfig.database,
    target: targetConfig.database,
    domains,
    sourceCounts: {},
    results: {},
    reconciliation: {},
  };

  try {
    await target.query(`SET search_path TO "${targetConfig.schema}"`);
    await source.query('SET search_path TO "public"');
    if (APPLY) await target.query('BEGIN');

    const account = await target.query("SELECT id FROM cash_accounts WHERE code = 'CASH' LIMIT 1");
    if (!account.rowCount) throw new Error('TARGET_CASH_ACCOUNT_MISSING');
    const cashAccount = account.rows[0].id;

    // ── employees ────────────────────────────────────────────────────────────
    if (domains.includes('employees')) {
      const {rows: employees} = await source.query(`
        SELECT employee_mobile, preferred_name, name_aliases, duty_type, designation
          FROM employee_master
         WHERE state = 'CONFIRMED' AND employee_mobile ~ '^\\+8801[3-9][0-9]{8}$'
         ORDER BY employee_mobile`);
      report.sourceCounts.employees = employees.length;
      const result = {source: employees.length, inserted: 0, existing: 0};
      if (APPLY) {
        for (const employee of employees) {
          const inserted = await target.query(
            `INSERT INTO employees
               (employee_mobile, preferred_name, name_aliases, duty_type, designation,
                state, joined_on, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,'ACTIVE',NULL,$6,$7)
             ON CONFLICT (employee_mobile) DO NOTHING RETURNING employee_mobile`,
            [employee.employee_mobile, clip(employee.preferred_name, 150), employee.name_aliases ?? [],
              clip(employee.duty_type || '', 40) || null, clip(employee.designation, 120) || null,
              `Legacy employee_master import; original_state=CONFIRMED`, ACTOR],
          );
          if (inserted.rowCount) result.inserted += 1; else result.existing += 1;
        }
      }
      report.results.employees = result;
    }

    // ── rates ────────────────────────────────────────────────────────────────
    if (domains.includes('rates')) {
      const {rows: rates} = await source.query(`
        SELECT destination_key, destination_label, shift_rate_minor, conveyance_minor, effective_from
          FROM escort_rate_config WHERE active ORDER BY destination_key`);
      report.sourceCounts.rates = rates.length;
      const result = {source: rates.length, inserted: 0, existing: 0};
      if (APPLY) {
        for (const rate of rates) {
          const inserted = await target.query(
            `INSERT INTO rate_config
               (destination_key, destination_label, shift_rate_minor, conveyance_minor, effective_from, active)
             VALUES ($1,$2,$3,$4,$5,true) ON CONFLICT (destination_key) DO NOTHING`,
            [rate.destination_key, clip(rate.destination_label, 120), rate.shift_rate_minor,
              rate.conveyance_minor ?? 0, rate.effective_from ?? '2025-01-01'],
          );
          if (inserted.rowCount) result.inserted += 1; else result.existing += 1;
        }
      }
      report.results.rates = result;
    }

    // ── programs ─────────────────────────────────────────────────────────────
    if (domains.includes('programs')) {
      const {rows: programs} = await source.query(`
        SELECT id, "motherVessel", "lighterVessel", "masterMobile", destination,
               "escortName", "escortMobile", "startDate", "endDate", shift, status,
               source, notes, details
          FROM programs
         WHERE status = 'Confirmed'
           AND "startDate" ~ '^\\d{4}-\\d{2}-\\d{2}$'
           AND btrim(shift) IN ('D','N')
         ORDER BY "startDate", id`);
      report.sourceCounts.programs = programs.length;
      const result = {source: programs.length, inserted: 0, existing: 0, duplicateKeys: 0, derivedEscorts: 0};
      if (APPLY) {
        for (const program of programs) {
          const id = `lgcy-prg-${program.id}`;
          const mother = clip(program.motherVessel, 120);
          const lighter = clip(program.lighterVessel, 120);
          const startDate = isoDate(program.startDate);
          if (!mother || !lighter || !startDate) continue;
          const startShift = program.shift;
          let details = {};
          try { details = typeof program.details === 'string' ? JSON.parse(program.details) : (program.details ?? {}); } catch { details = {}; }
          const endShift = ['D', 'N'].includes(String(details.endShift ?? '').trim()) ? String(details.endShift).trim() : null;
          const endDate = endShift ? isoDate(program.endDate) : null;
          const released = Boolean(endDate && endDate >= startDate && endShift && details.releaseConfirmed === true);
          const state = released ? 'RELEASED' : 'ASSIGNED';
          const orderMessageId = String(details.orderMessageId ?? details.sourceMessageId ?? '').trim() || null;
          const confirmationMessageId = String(details.confirmationMessageId ?? '').trim() || null;
          const sourceChatJid = String(details.clientChat ?? '').trim() || null;
          const masterMobile = normalizeMobile(program.masterMobile);
          const escortMobile = plusMobile(program.escortMobile);
          if (escortMobile) {
            const derived = await target.query(
              `INSERT INTO employees
                 (employee_mobile, preferred_name, name_aliases, duty_type, state, notes, created_by)
               VALUES ($1,$2,'{}'::text[],'escort','ACTIVE',$3,$4)
               ON CONFLICT (employee_mobile) DO NOTHING RETURNING employee_mobile`,
              [escortMobile, clip(program.escortName || escortMobile, 150),
                `Derived from legacy confirmed program ${program.id}`, ACTOR],
            );
            if (derived.rowCount) result.derivedEscorts += 1;
          }
          const duplicate = await target.query(
            `SELECT id FROM programs
              WHERE lower(btrim(mother_vessel)) = lower(btrim($1))
                AND lower(btrim(lighter_vessel)) = lower(btrim($2))
                AND start_date = $3 LIMIT 1`,
            [mother, lighter, startDate],
          );
          if (duplicate.rowCount && duplicate.rows[0].id !== id) {
            result.duplicateKeys += 1;
            continue;
          }
          const inserted = await target.query(
            `INSERT INTO programs
               (id, mother_vessel, lighter_vessel, master_mobile, destination, escort_name, escort_mobile,
                start_date, start_shift, end_date, end_shift, state, source_channel, source_message_id,
                source_chat_jid, confirmation_message_id, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'IMPORT',$13,$14,$15,$16,$17)
             ON CONFLICT (id) DO NOTHING RETURNING id`,
            [id, mother, lighter, masterMobile, clip(program.destination, 160) || null,
              clip(program.escortName, 150) || null, escortMobile, startDate, startShift,
              endDate, endShift, state, orderMessageId, sourceChatJid,
              confirmationMessageId && orderMessageId ? confirmationMessageId : null,
              clip(`Legacy program ${program.id}; status=Confirmed; source=${program.source ?? ''}; details=${json(details)}`, 2000),
              ACTOR],
          );
          if (inserted.rowCount) result.inserted += 1; else result.existing += 1;
        }
      }
      report.results.programs = result;
    }

    // ── historical derived pay ───────────────────────────────────────────────
    if (domains.includes('pay')) {
      const {rows: pays} = await source.query(`
        SELECT pp.* FROM program_pay pp
          JOIN programs p ON p.id = pp.program_id
         WHERE p.status = 'Confirmed'
           AND p."startDate" ~ '^\\d{4}-\\d{2}-\\d{2}$'
         ORDER BY pp.program_id`);
      report.sourceCounts.pay = pays.length;
      const result = {source: pays.length, upserted: 0, skipped: 0};
      if (APPLY) {
        for (const pay of pays) {
          const programId = `lgcy-prg-${pay.program_id}`;
          const exists = await target.query('SELECT 1 FROM programs WHERE id = $1', [programId]);
          if (!exists.rowCount) { result.skipped += 1; continue; }
          const calculated = pay.state === 'CALCULATED' && pay.total_minor !== null;
          await target.query(
            `INSERT INTO program_pay
               (program_id, shifts, salary_minor, conveyance_minor, total_minor, state, reasons, computed_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now())
             ON CONFLICT (program_id) DO UPDATE
               SET shifts=EXCLUDED.shifts, salary_minor=EXCLUDED.salary_minor,
                   conveyance_minor=EXCLUDED.conveyance_minor, total_minor=EXCLUDED.total_minor,
                   state=EXCLUDED.state, reasons=EXCLUDED.reasons, computed_at=now()`,
            [programId, pay.shift_count, pay.salary_minor, pay.conveyance_minor,
              calculated ? pay.total_minor : null, calculated ? 'CALCULATED' : 'UNRESOLVED',
              json(pay.reasons ?? [])],
          );
          result.upserted += 1;
        }
      }
      report.results.pay = result;
    }

    // ── attendance ───────────────────────────────────────────────────────────
    if (domains.includes('attendance')) {
      const {rows: attendance} = await source.query(`
        SELECT id, employee_mobile, attendance_date, shift, status, source, source_ref
          FROM attendance_entries
         WHERE status = 'CONFIRMED'
           AND attendance_date IS NOT NULL
           AND btrim(shift) IN ('D','N')
         ORDER BY attendance_date, employee_mobile`);
      report.sourceCounts.attendance = attendance.length;
      const result = {source: attendance.length, inserted: 0, existing: 0};
      if (APPLY) {
        for (const entry of attendance) {
          const id = `lgcy-att-${entry.id}`;
          const inserted = await target.query(
            `INSERT INTO attendance (id, employee_mobile, duty_date, shift, state, hours, source, recorded_by)
             VALUES ($1,$2,$3,$4,'PRESENT',NULL,'IMPORT',$5)
             ON CONFLICT (employee_mobile, duty_date, shift) DO NOTHING RETURNING id`,
            [id, entry.employee_mobile, entry.attendance_date, entry.shift, ACTOR],
          );
          if (inserted.rowCount) {
            result.inserted += 1;
            await target.query(
              `INSERT INTO audit_events (actor, actor_role, action, entity, entity_id, detail, source)
               VALUES ($1,'SYSTEM','LEGACY_ATTENDANCE_IMPORTED','attendance',$2,$3::jsonb,'SYSTEM')`,
              [ACTOR, id, json({legacyId: entry.id, sourceRef: entry.source_ref, source: entry.source})],
            );
          } else {
            result.existing += 1;
          }
        }
      }
      report.results.attendance = result;
    }

    // ── cash ─────────────────────────────────────────────────────────────────
    if (domains.includes('cash-posted') || domains.includes('cash-review')) {
      const result = {
        postedSource: 0, postedInserted: 0, postingsInserted: 0, ledgerInserted: 0,
        reviewSource: 0, reviewInserted: 0, amountMinor: 0, balanceMinor: 0,
      };
      if (domains.includes('cash-posted')) {
        const {rows: posted} = await source.query(`
          SELECT i.*, p.id AS legacy_posting_id
            FROM cash_instructions i JOIN cash_postings p ON p.instruction_id = i.id
           WHERE i.state = 'MANUAL_READY' ORDER BY i.source_time, i.id`);
        result.postedSource = posted.length;
        if (APPLY) {
          for (const row of posted) {
            const id = `lgcy-ci-${row.id}`;
            const postingId = `lgcy-pos-${row.legacy_posting_id}`;
            const at = row.source_time ?? new Date();
            const inserted = await target.query(
              `INSERT INTO cash_instructions
                 (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose,
                  account_id, state, source_channel, source_message_id, source_block_key, source_hash,
                  approved_at, approved_by, posted_at, posted_by, created_by, created_at, updated_at, legacy)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'POSTED','IMPORT',$9,'IMPORT',$10,$11,$12,$13,$14,$15,$16,$16,true)
               ON CONFLICT (id) DO NOTHING RETURNING id`,
              [id, plusMobile(row.employee_mobile), clip(row.employee_name, 150),
                plusMobile(row.payout_mobile), row.method, row.amount_minor, clip(row.purpose, 500) || null,
                cashAccount, `legacy-ci:${row.id}`, row.payload_hash ?? row.id, at, ACTOR, at, ACTOR, ACTOR, at],
            );
            if (inserted.rowCount) result.postedInserted += 1;
            const existingPosting = await target.query(
              'SELECT id FROM cash_postings WHERE instruction_id = $1', [id],
            );
            if (!existingPosting.rowCount) {
              const ledger = await target.query(
                `INSERT INTO ledger_entries
                   (account_id, entry_date, direction, amount_minor, category, description, source,
                    instruction_id, created_by, created_at)
                 VALUES ($1,$2,'DEBIT',$3,'LEGACY_PAYMENT',$4,'IMPORT',$5,$6,$7)
                 RETURNING id::text`,
                [cashAccount, at.toISOString().slice(0, 10), row.amount_minor,
                  clip(`Legacy payment ${row.employee_name} (${row.id})`, 500), id, ACTOR, at],
              );
              result.ledgerInserted += 1;
              const posting = await target.query(
                `INSERT INTO cash_postings
                   (id, instruction_id, account_id, amount_minor, method, posted_at, posted_by, ledger_entry_id, legacy)
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,true)
                 ON CONFLICT (instruction_id) DO NOTHING`,
                [postingId, id, cashAccount, row.amount_minor, row.method, at, ACTOR, ledger.rows[0].id],
              );
              if (posting.rowCount) result.postingsInserted += 1;
            }
            result.amountMinor += Number(row.amount_minor);
          }
        }
      }
      if (domains.includes('cash-review')) {
        const {rows: review} = await source.query(`
          SELECT * FROM cash_instructions
           WHERE state = 'REVIEW' ORDER BY source_time, id`);
        result.reviewSource = review.length;
        if (APPLY) {
          for (const row of review) {
            const id = `lgcy-ci-${row.id}`;
            const at = row.source_time ?? new Date();
            const inserted = await target.query(
              `INSERT INTO cash_instructions
                 (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose,
                  account_id, state, source_channel, source_message_id, source_block_key, source_hash,
                  created_by, created_at, updated_at, legacy)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REVIEW','IMPORT',$9,'IMPORT',$10,$11,$12,$12,true)
               ON CONFLICT (id) DO NOTHING RETURNING id`,
              [id, plusMobile(row.employee_mobile), clip(row.employee_name, 150),
                plusMobile(row.payout_mobile), row.method, row.amount_minor, clip(row.purpose, 500) || null,
                cashAccount, `legacy-ci:${row.id}`, row.payload_hash ?? row.id, ACTOR, at],
            );
            if (inserted.rowCount) result.reviewInserted += 1;
          }
        }
      }
      const balance = await target.query(
        `SELECT (a.opening_balance_minor
                 + coalesce(sum(CASE WHEN l.direction='CREDIT' THEN l.amount_minor ELSE -l.amount_minor END),0))::text AS balance
           FROM cash_accounts a LEFT JOIN ledger_entries l ON l.account_id=a.id
          WHERE a.id=$1 GROUP BY a.id`,
        [cashAccount],
      );
      result.balanceMinor = Number(balance.rows[0]?.balance ?? 0);
      report.results.cash = result;
    }

    // ── reconciliation ───────────────────────────────────────────────────────
    const counts = await target.query(`
      SELECT
        (SELECT count(*) FROM employees WHERE created_by=$1)::int AS imported_employees,
        (SELECT count(*) FROM programs WHERE source_channel='IMPORT')::int AS imported_programs,
        (SELECT count(*) FROM attendance WHERE source='IMPORT')::int AS imported_attendance,
        (SELECT count(*) FROM cash_instructions WHERE legacy=true AND state='POSTED')::int AS legacy_posted,
        (SELECT count(*) FROM cash_instructions WHERE legacy=true AND state='REVIEW')::int AS legacy_review,
        (SELECT count(*) FROM cash_postings WHERE legacy=true)::int AS legacy_postings,
        (SELECT count(*) FROM ledger_entries WHERE source='IMPORT')::int AS legacy_ledger,
        (SELECT coalesce(sum(amount_minor),0)::text FROM ledger_entries WHERE source='IMPORT') AS legacy_ledger_minor`,
      [ACTOR],
    );
    report.reconciliation = counts.rows[0];

    if (APPLY) {
      for (const domain of domains) {
        const action = `LEGACY_IMPORT_${domain.toUpperCase().replace(/-/g, '_')}`;
        const exists = await target.query(
          "SELECT 1 FROM audit_events WHERE action=$1 AND entity='legacy_import' AND entity_id=$2 LIMIT 1",
          [action, IMPORT_ID],
        );
        if (!exists.rowCount) {
          await target.query(
            `INSERT INTO audit_events (actor, actor_role, action, entity, entity_id, detail, source)
             VALUES ($1,'SYSTEM',$2,'legacy_import',$3,$4::jsonb,'SYSTEM')`,
            [ACTOR, action, IMPORT_ID, json({domain, source: SOURCE_DB, target: targetConfig.database,
              result: report.results[domain === 'cash-posted' || domain === 'cash-review' ? 'cash' : domain] ?? null})],
          );
        }
      }
    }

    if (APPLY) await target.query('COMMIT');

    const output = arg('report');
    if (output && APPLY) {
      const {writeFileSync} = await import('node:fs');
      writeFileSync(output, JSON.stringify(report, null, 2));
    }
    console.log(JSON.stringify(report, null, 2));
    if (!APPLY) console.log('Dry run complete; nothing was written. Re-run with --apply on an isolated clone.');
  } catch (error) {
    if (APPLY) await target.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'IMPORT_FAILED'}));
  process.exitCode = 1;
});
