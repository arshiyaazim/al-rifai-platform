// Vessel escort change (Step 13 / D6).
//
// Same-day change: update the original row and its open assignment.
// Different-day change: close the previous assignment at the shift before the
// change, then insert a new program linked by escort_change_from_program_id.
// The unique (mother,lighter,start_date) rule is checked before inserting.

import {createHash} from 'node:crypto';
import {row, rows, tx, type Actor} from '../../standalone/db.ts';
import {recordAudit} from '../../standalone/audit.ts';

export type NewEscort = {
  name: string;
  mobile: string;
  shift?: 'D' | 'N';
  eventAt?: string;
};

const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const previousShift = (date: string, shift: 'D' | 'N') => {
  const value = new Date(`${date}T00:00:00Z`);
  if (shift === 'D') {
    value.setUTCDate(value.getUTCDate() - 1);
    return {date: value.toISOString().slice(0, 10), shift: 'N' as const};
  }
  return {date, shift: 'D' as const};
};

const SYSTEM: Actor = {id: 'system:vessel-escort-change', role: 'ADMIN'} as Actor;

export async function handleEscortChange(
  programId: string,
  newEscort: NewEscort,
  changeDate: string,
): Promise<{programId: string; created: boolean}> {
  const mobile = digits(newEscort.mobile);
  if (!/^01[3-9]\d{8}$/.test(mobile)) throw new Error('ESCORT_MOBILE_INVALID');
  const name = String(newEscort.name ?? '').trim();
  if (!name) throw new Error('ESCORT_NAME_REQUIRED');

  return tx(async (client) => {
    const found = await client.query<Record<string, unknown>>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programId]);
    if (!found.rowCount) throw new Error('PROGRAM_NOT_FOUND');
    const current = found.rows[0] as Record<string, unknown>;
    const startDate = String(current.start_date).slice(0, 10);
    const startShift = String(current.start_shift) as 'D' | 'N';
    const shift = newEscort.shift === 'D' || newEscort.shift === 'N' ? newEscort.shift : startShift;

    if (changeDate === startDate) {
      await client.query(
        `UPDATE programs SET escort_name=$2, escort_mobile=$3, revision=revision+1 WHERE id=$1`,
        [programId, name, `+88${mobile}`],
      );
      await client.query(
        `UPDATE program_assignments SET employee_mobile=$2 WHERE program_id=$1 AND end_date IS NULL`,
        [programId, `+88${mobile}`],
      );
      await client.query(
        `INSERT INTO program_events(program_id,action,command_key,actor,payload)
         VALUES($1,'PROGRAM_ESCORT_CHANGED',$2,$3,$4::jsonb)`,
        [programId, `escort-change:${programId}:${Date.now()}`, SYSTEM.id, JSON.stringify({name, mobile, changeDate, sameDay: true})],
      );
      await recordAudit({actor: SYSTEM, action: 'PROGRAM_ESCORT_CHANGED', entity: 'program', entityId: programId,
        detail: {name, mobile, changeDate, sameDay: true}}, client);
      return {programId, created: false};
    }

    const identity = await rows<{id: string}>(
      `SELECT id FROM programs
        WHERE lower(btrim(mother_vessel))=lower(btrim($1))
          AND lower(btrim(lighter_vessel))=lower(btrim($2))
          AND start_date=$3::date
          AND state <> 'VOIDED'
          AND id <> $4
        LIMIT 1`,
      [current.mother_vessel, current.lighter_vessel, changeDate, programId],
    );
    if (identity.length) throw new Error('ESCORT_CHANGE_IDENTITY_EXISTS');

    const prev = previousShift(changeDate, shift);
    if (prev.date < startDate) throw new Error('ESCORT_CHANGE_BEFORE_START');
    await client.query(
      `UPDATE programs SET end_date=$2, end_shift=$3, revision=revision+1 WHERE id=$1`,
      [programId, prev.date, prev.shift],
    );
    await client.query(
      `UPDATE program_assignments SET end_date=$2, end_shift=$3 WHERE program_id=$1 AND end_date IS NULL`,
      [programId, prev.date, prev.shift],
    );

    const newId = `prog_${sha(JSON.stringify(['vessel-escort-change', programId, changeDate, shift])).slice(0, 40)}`;
    await client.query(
      `INSERT INTO programs(id,revision,mother_vessel,lighter_vessel,master_mobile,master_name,destination,
        escort_name,escort_mobile,start_date,start_shift,end_date,end_shift,state,source_channel,source_type,
        source_message_id,source_chat_jid,notes,created_by,event_at,source_block_key,order_key,escort_change_from_program_id)
       VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,NULL,'CONFIRMED','WHATSAPP','WHATSAPP_ORDER',
        $11,$12,$13,$14,$15,$16,$17,$18)`,
      [newId, current.mother_vessel, current.lighter_vessel, current.master_mobile, current.master_name,
        current.destination, name, `+88${mobile}`, changeDate, shift, current.source_message_id,
        current.source_chat_jid, `Escort change from ${programId}`, SYSTEM.id,
        newEscort.eventAt ?? new Date().toISOString(), `change:${newEscort.eventAt ?? changeDate}`, current.order_key, programId],
    );
    await client.query(
      `INSERT INTO program_assignments(id,program_id,revision,employee_mobile,start_date,start_shift,source,created_by)
       VALUES($1,$2,1,$3,$4,$5,'WHATSAPP',$6)`,
      [`asg_${sha(JSON.stringify([newId, mobile, changeDate, shift])).slice(0, 32)}`, newId, `+88${mobile}`, changeDate, shift, SYSTEM.id],
    );
    await client.query(
      `INSERT INTO program_events(program_id,action,command_key,actor,payload)
       VALUES($1,'ESCORT_CHANGED',$2,$3,$4::jsonb)`,
      [programId, `escort-change:${programId}:${newId}`, SYSTEM.id, JSON.stringify({newProgramId: newId, name, mobile, changeDate, shift})],
    );
    await recordAudit({actor: SYSTEM, action: 'VESSEL:ESCORT_CHANGED', entity: 'program', entityId: newId,
      detail: {fromProgramId: programId, name, mobile, changeDate, shift}}, client);
    return {programId: newId, created: true};
  });
}
