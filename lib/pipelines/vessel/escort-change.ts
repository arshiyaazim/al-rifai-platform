// Vessel escort change (Owner rules 2026-11-10, step P).
//
// A different Escort Mobile for an otherwise identified order is always a NEW
// program row, never an in-place rewrite:
//   * the previous row becomes WITHDRAWN with a supersededBy marker,
//   * the new row links back through escort_change_from_program_id,
//   * the new escort mobile is auto-created in the employee directory,
//   * the previous open assignment is closed at the shift before the change.
//
// This function never sends WhatsApp and never touches cash tables.

import {createHash} from 'node:crypto';
import {tx, type Actor} from '../../standalone/db.ts';
import {recordAudit} from '../../standalone/audit.ts';

export type NewEscort = {
  name: string;
  mobile: string;
  shift?: 'D' | 'N';
  eventAt?: string;
};

export const ESCORT_CHANGE_STATE = 'WITHDRAWN';

const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

const previousShift = (date: string, shift: 'D' | 'N') => {
  const value = new Date(`${date}T00:00:00Z`);
  if (shift === 'D') {
    value.setUTCDate(value.getUTCDate() - 1);
    return {date: value.toISOString().slice(0, 10), shift: 'N' as const};
  }
  return {date, shift: 'D' as const};
};

export async function handleEscortChangeOn(
  client: {query: (sql: string, values?: unknown[]) => Promise<{rowCount: number | null; rows: Array<Record<string, unknown>>}>},
  actor: Actor,
  programId: string,
  newEscort: NewEscort,
  changeDate: string,
): Promise<{programId: string; assignmentId: string; created: boolean}> {
  const mobile = digits(newEscort.mobile);
  if (!/^01[3-9][0-9]{8}$/.test(mobile)) throw new Error('ESCORT_MOBILE_INVALID');
  const name = String(newEscort.name ?? '').trim();
  if (!name) throw new Error('ESCORT_NAME_REQUIRED');

  const found = await client.query('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programId]);
  if (!found.rowCount) throw new Error('PROGRAM_NOT_FOUND');
  const current = found.rows[0];
  const startDate = String(current.start_date).slice(0, 10);
  const startShift = (String(current.start_shift) === 'N' ? 'N' : 'D') as 'D' | 'N';
  const shift = newEscort.shift === 'D' || newEscort.shift === 'N' ? newEscort.shift : startShift;
  const previousEscort = digits(current.escort_mobile);
  if (previousEscort && previousEscort === mobile) {
    return {programId, assignmentId: '', created: false};
  }

  // The new escort is a first-class employee identity (mobile is the key).
  await client.query(
    `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
     VALUES ($1,$2,'escort','escort',$3)
     ON CONFLICT (employee_mobile) DO NOTHING`,
    [`+88${mobile}`, name, actor.id],
  );

  const newId = `prog_${sha(JSON.stringify(['vessel-escort-change', programId, mobile, changeDate, shift])).slice(0, 40)}`;
  const assignmentId = `asg_${sha(JSON.stringify([newId, mobile, changeDate, shift])).slice(0, 32)}`;
  const prev = previousShift(changeDate, shift);
  const closeDate = prev.date >= startDate ? prev.date : startDate;
  const closeShift = prev.date >= startDate ? prev.shift : startShift;

  await client.query(
    `UPDATE programs
        SET state = $2, end_date = $3, end_shift = $4, revision = revision + 1, updated_at = now()
      WHERE id = $1`,
    [programId, ESCORT_CHANGE_STATE, closeDate, closeShift],
  );
  await client.query(
    `UPDATE program_assignments
        SET end_date = $2, end_shift = $3
      WHERE program_id = $1 AND end_date IS NULL`,
    [programId, closeDate, closeShift],
  );

  await client.query(
    `INSERT INTO programs(id,revision,mother_vessel,lighter_vessel,master_mobile,master_name,destination,
      escort_name,escort_mobile,start_date,start_shift,end_date,end_shift,state,source_channel,source_type,
      source_message_id,source_chat_jid,notes,created_by,event_at,source_block_key,order_key,draft_text,
      escort_change_from_program_id)
     VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,'CONFIRMED','WHATSAPP','WHATSAPP_ORDER',
      $11,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [newId, current.mother_vessel, current.lighter_vessel, current.master_mobile, current.master_name,
      current.destination, name, `+88${mobile}`, changeDate, shift,
      current.source_message_id, current.source_chat_jid, `Escort change from ${programId}`,
      actor.id, newEscort.eventAt ?? new Date().toISOString(), `change:${newEscort.eventAt ?? changeDate}`,
      current.order_key, current.draft_text, programId],
  );
  await client.query(
    `INSERT INTO program_assignments(id,program_id,revision,employee_mobile,start_date,start_shift,source,created_by)
     VALUES($1,$2,1,$3,$4,$5,'WHATSAPP',$6)`,
    [assignmentId, newId, `+88${mobile}`,
      changeDate, shift, actor.id],
  );
  await client.query(
    `INSERT INTO program_events(program_id,action,command_key,actor,payload)
     VALUES($1,'PROGRAM_ESCORT_CHANGED',$2,$3,$4::jsonb)`,
    [programId, `escort-change:${programId}:${newId}`, actor.id,
      JSON.stringify({supersededBy: newId, reason: 'ESCORT_CHANGE', name, mobile, changeDate, shift})],
  );
  await client.query(
    `INSERT INTO program_events(program_id,action,command_key,actor,payload)
     VALUES($1,'ESCORT_CHANGED',$2,$3,$4::jsonb)`,
    [newId, `escort-change-new:${newId}`, actor.id,
      JSON.stringify({fromProgramId: programId, name, mobile, changeDate, shift})],
  );
  await recordAudit({actor, action: 'VESSEL:ESCORT_CHANGED', entity: 'program', entityId: newId,
    detail: {fromProgramId: programId, name, mobile, changeDate, shift}}, client as never);
  return {programId: newId, assignmentId, created: true};
}

export async function handleEscortChange(
  programId: string,
  newEscort: NewEscort,
  changeDate: string,
  actor?: Actor,
): Promise<{programId: string; assignmentId: string; created: boolean}> {
  const system: Actor = actor ?? ({id: 'system:vessel-escort-change', role: 'ADMIN'} as Actor);
  return tx((client) => handleEscortChangeOn(client, system, programId, newEscort, changeDate));
}
