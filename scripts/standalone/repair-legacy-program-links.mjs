#!/usr/bin/env node
// AL-RIFA'I — repair legacy program integration links.
//
// The historical importer creates `programs` and `program_pay` but does not
// write assignment/source/event rows. This script fills those links
// idempotently for source_channel='IMPORT' programs. It never changes amounts,
// dates, escort identity or program state.
import {row, rows, tx} from '../../lib/standalone/db.ts';
import {recordAudit, stableId} from '../../lib/standalone/audit.ts';

const flag = (name) => process.argv.includes(`--${name}`);
const APPLY = flag('apply');
const ACTOR = 'import:legacy';

async function main() {
  const programs = await rows(`
    SELECT id, start_date::text AS start_date, start_shift, end_date::text AS end_date,
           end_shift, escort_mobile, source_message_id, source_chat_jid, confirmation_message_id,
           state, created_at
      FROM programs
     WHERE source_channel = 'IMPORT'
     ORDER BY start_date, id`);

  const report = {
    step: 'legacy-program-links',
    mode: APPLY ? 'apply' : 'dry-run',
    programs: programs.length,
    assignments_inserted: 0,
    links_inserted: 0,
    events_inserted: 0,
    skipped_existing: 0,
  };

  if (APPLY) {
    await tx(async (client) => {
      for (const program of programs) {
        if (program.escort_mobile) {
          const existing = await client.query('SELECT 1 FROM program_assignments WHERE program_id = $1', [program.id]);
          if (!existing.rowCount) {
            await client.query(
              `INSERT INTO program_assignments
                 (id, program_id, employee_mobile, start_date, start_shift, end_date, end_shift,
                  source, created_by, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,'IMPORT',$8,$9)
               ON CONFLICT (id) DO NOTHING`,
              [stableId('lgcy-asg', [program.id]), program.id, program.escort_mobile,
                program.start_date, program.start_shift, program.end_date, program.end_shift,
                ACTOR, `${program.start_date}T00:00:00Z`],
            );
            report.assignments_inserted += 1;
          } else {
            report.skipped_existing += 1;
          }
        }

        for (const [messageId, role] of [
          [program.source_message_id, 'primary'],
          [program.confirmation_message_id, 'contributor'],
        ]) {
          if (!messageId || !program.source_chat_jid) continue;
          const id = stableId('lgcy-psm', [program.id, messageId, role]);
          const inserted = await client.query(
            `INSERT INTO program_source_messages
               (id, program_id, account_id, chat_jid, message_id, source_role, created_at)
             VALUES ($1,$2,'wa-01',$3,$4,$5,$6)
             ON CONFLICT (program_id, account_id, chat_jid, message_id) DO NOTHING
             RETURNING id`,
            [id, program.id, program.source_chat_jid, messageId, role, program.created_at],
          );
          if (inserted.rowCount) report.links_inserted += 1;
          else report.skipped_existing += 1;
        }

        const eventDate = `${program.start_date}T00:00:00Z`;
        const actions = [
          ['CREATE_PROGRAM', eventDate, {legacy: true, state: program.state}],
          ['ASSIGN_ESCORT', eventDate, {legacy: true, employeeMobile: program.escort_mobile}],
          ...(program.state === 'RELEASED' && program.end_date
            ? [['RELEASE_PROGRAM', `${program.end_date}T00:00:00Z`, {legacy: true, endShift: program.end_shift}]]
            : []),
        ];
        for (const [action, at, payload] of actions) {
          const existing = await client.query(
            'SELECT 1 FROM program_events WHERE program_id = $1 AND action = $2 AND actor = $3 LIMIT 1',
            [program.id, action, ACTOR],
          );
          if (existing.rowCount) {
            report.skipped_existing += 1;
            continue;
          }
          await client.query(
            `INSERT INTO program_events (program_id, action, actor, payload, created_at)
             VALUES ($1,$2,$3,$4::jsonb,$5)`,
            [program.id, action, ACTOR, JSON.stringify(payload), at],
          );
          report.events_inserted += 1;
        }
      }

      const prior = await client.query(
        "SELECT 1 FROM audit_events WHERE action='LEGACY_PROGRAM_LINKS_REPAIRED' AND entity='legacy_program_links' AND entity_id='v1' LIMIT 1",
      );
      if (!prior.rowCount) {
        await recordAudit({
          actor: {id: ACTOR, role: 'ADMIN'},
          action: 'LEGACY_PROGRAM_LINKS_REPAIRED',
          entity: 'legacy_program_links',
          entityId: 'v1',
          detail: report,
          source: 'SYSTEM',
        }, client);
      }
    });
  } else {
    const assignments = await row("SELECT count(*)::int AS n FROM program_assignments");
    const links = await row("SELECT count(*)::int AS n FROM program_source_messages");
    const events = await row("SELECT count(*)::int AS n FROM program_events");
    report.assignments_inserted = Math.max(0, programs.filter((p) => p.escort_mobile).length - Number(assignments?.n ?? 0));
    report.links_inserted = Math.max(0, programs.length * 2 - Number(links?.n ?? 0));
    report.events_inserted = Math.max(0, programs.length * 2 - Number(events?.n ?? 0));
  }

  console.log(JSON.stringify(report, null, 2));
  if (!APPLY) console.log('Dry run complete; no assignment, link or event was written.');
}

main().catch((error) => {
  console.error(JSON.stringify({status: 'FAILED', code: error?.message ?? 'PROGRAM_LINK_REPAIR_FAILED'}));
  process.exitCode = 1;
});
