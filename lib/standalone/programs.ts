import type {PoolClient} from 'pg';
import {row, rows, tx, text, optionalText, isoDate, shift, mobile, optionalMobile, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';
import {assertCapability} from './authz.ts';

export type ProgramInput = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile?: string | null;
  destination?: string | null;
  escortName?: string | null;
  escortMobile?: string | null;
  startDate: string;
  startShift: string;
  endDate?: string | null;
  endShift?: string | null;
  notes?: string | null;
};

export type ProgramRow = {
  id: string;
  revision: number;
  mother_vessel: string;
  lighter_vessel: string;
  master_mobile: string | null;
  destination: string | null;
  escort_name: string | null;
  escort_mobile: string | null;
  start_date: string;
  start_shift: 'D' | 'N';
  end_date: string | null;
  end_shift: 'D' | 'N' | null;
  state: string;
  source_channel: string;
  source_message_id: string | null;
  confirmation_message_id: string | null;
  notes: string | null;
  created_at: string;
};

export type ProgramListRow = ProgramRow & {
  pay_state: string | null;
  total_minor: string | null;
  salary_minor: string | null;
  conveyance_minor: string | null;
};

const programId = (mother: string, lighter: string, startDate: string, startShift: string) =>
  stableId('prog', ['vessel-program', mother.toLowerCase(), lighter.toLowerCase(), startDate, startShift]);

/** ±1 calendar day potential-duplicate check (never blocks; it warns). */
export async function potentialDuplicates(input: {motherVessel: string; lighterVessel: string; startDate: string; excludeId?: string}) {
  return rows<{id: string; start_date: string}>(
    `SELECT id, start_date::text AS start_date FROM programs
      WHERE lower(btrim(mother_vessel)) = lower(btrim($1))
        AND lower(btrim(lighter_vessel)) = lower(btrim($2))
        AND abs(start_date - $3::date) <= 1
        AND state <> 'VOIDED'
        AND ($4::text IS NULL OR id <> $4)`,
    [input.motherVessel, input.lighterVessel, input.startDate, input.excludeId ?? null],
  );
}

export type ProgramSource = {
  channel?: 'WEB' | 'WHATSAPP' | 'IMPORT';
  messageId?: string | null;
  chatJid?: string | null;
  commandKey?: string | null;
};

async function createProgramOn(client: Pick<PoolClient, 'query'>, actor: Actor, input: ProgramInput, source: ProgramSource) {
  const commandKey = source.commandKey ?? null;
  const channel = source.channel ?? 'WEB';
  const motherVessel = text(input.motherVessel, 'motherVessel', {max: 120});
  const lighterVessel = text(input.lighterVessel, 'lighterVessel', {max: 120});
  const startDate = isoDate(input.startDate, 'startDate');
  const startShift = shift(input.startShift, 'startShift');
  const endDate = input.endDate ? isoDate(input.endDate, 'endDate') : null;
  const endShift = endDate ? shift(input.endShift, 'endShift') : null;
  const masterMobileRaw = optionalText(input.masterMobile, 'masterMobile', 40);
  const masterMobile = masterMobileRaw
    ? masterMobileRaw.replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1')
    : null;
  if (masterMobile !== null && !/^01[3-9][0-9]{8}$/.test(masterMobile)) {
    throw new DomainError('INVALID_MASTERMOBILE');
  }
  const destination = optionalText(input.destination, 'destination', 160);
  const notes = optionalText(input.notes, 'notes', 2000);
  const escortMobile = optionalMobile(input.escortMobile, 'escortMobile');

  const duplicates = await potentialDuplicates({motherVessel, lighterVessel, startDate});
  const exact = duplicates.find((candidate) => candidate.start_date === startDate);
  if (exact) throw new DomainError('DUPLICATE_PROGRAM', 409, exact.id);

  const id = programId(motherVessel, lighterVessel, startDate, startShift);
  const state = escortMobile ? 'ASSIGNED' : 'DRAFT';

  if (escortMobile) {
      const name = optionalText(input.escortName, 'escortName', 150) ?? escortMobile;
    await client.query(
      `INSERT INTO employees (employee_mobile, preferred_name, duty_type, created_by)
       VALUES ($1,$2,'escort',$3) ON CONFLICT (employee_mobile) DO NOTHING`,
      [escortMobile, name, actor.id],
    );
  }
  const inserted = await client.query<ProgramRow>(
      `INSERT INTO programs
         (id, mother_vessel, lighter_vessel, master_mobile, destination, escort_name, escort_mobile,
          start_date, start_shift, end_date, end_shift, state, source_channel, source_message_id,
          source_chat_jid, created_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     RETURNING *`,
    [id, motherVessel, lighterVessel, masterMobile, destination,
      optionalText(input.escortName, 'escortName', 150), escortMobile,
      startDate, startShift, endDate, endShift, state, channel,
      source.messageId ?? null, source.chatJid ?? null, actor.id, notes],
  );
  if (escortMobile) {
    await client.query(
      `INSERT INTO program_assignments
         (id, program_id, employee_mobile, start_date, start_shift, source, created_by)
       VALUES ($1,$2,$3,$4,$5,'WEB',$6)`,
      [stableId('asg', ['assignment', id, escortMobile, startDate, startShift]), id, escortMobile, startDate, startShift, actor.id],
    );
  }
  await client.query(
    `INSERT INTO program_events (program_id, action, command_key, actor, payload)
     VALUES ($1,'CREATE_PROGRAM',$2,$3,$4::jsonb)`,
    [id, commandKey ? `create:${commandKey}` : null, actor.id, JSON.stringify({motherVessel, lighterVessel, startDate, startShift})],
  );
  await recordAudit({actor, action: 'PROGRAM_CREATED', entity: 'program', entityId: id,
    detail: {motherVessel, lighterVessel, startDate, startShift, escortMobile}}, client);
  return {program: inserted.rows[0], potentialDuplicates: duplicates};
}

/**
 * Connect the optional draft-delivery queue after a committed DRAFT program.
 * No recipient approval means no queue record. Queue failure never rolls back
 * or hides the business program; it is logged for operator follow-up.
 */
async function enqueueDraftIfApproved(program: ProgramRow): Promise<void> {
  if (program.state !== 'DRAFT') return;
  try {
    const {runtimeDeliveryConfig} = await import('./vessel-draft-delivery-store.ts');
    const config = await runtimeDeliveryConfig();
    if (!config.ownerApprovedRecipient) return;
    const {enqueueDraftForProgram} = await import('./vessel-draft-delivery-store.ts');
    await enqueueDraftForProgram(program, config);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'DRAFT_QUEUE_FAILED';
    console.error(`Vessel draft queue hook failed (${code}).`);
  }
}

export async function createProgram(actor: Actor, input: ProgramInput, source: ProgramSource = {}, client?: Pick<PoolClient, 'query'>) {
  assertCapability(actor, 'vessel.command');
  if (client) return createProgramOn(client, actor, input, source);
  const result = await tx((txClient) => createProgramOn(txClient, actor, input, source));
  await enqueueDraftIfApproved(result.program);
  return result;
}

async function assignEscortOn(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  programIdValue: string,
  input: {employeeMobile: string; startDate?: string; startShift?: string; employeeName?: string; replace?: boolean},
) {
  const employeeMobile = mobile(input.employeeMobile, 'employeeMobile');
  {
    const program = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!program.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = program.rows[0];
    if (current.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
    const startDate = input.startDate ? isoDate(input.startDate, 'startDate') : current.start_date;
    const startShift = input.startShift ? shift(input.startShift, 'startShift') : current.start_shift;
    // Prefer an explicit operator-supplied name. Otherwise resolve the directory
    // name for an existing employee before falling back to the mobile number, so
    // the Vessel register keeps a human-readable escort name.
    const suppliedName = optionalText(input.employeeName, 'employeeName', 150);
    const existingEmployee = suppliedName
      ? null
      : await client.query<{preferred_name: string}>(
          'SELECT preferred_name FROM employees WHERE employee_mobile = $1',
          [employeeMobile],
        );
    const name = suppliedName ?? existingEmployee?.rows[0]?.preferred_name ?? employeeMobile;
    await client.query(
      `INSERT INTO employees (employee_mobile, preferred_name, duty_type, created_by)
       VALUES ($1,$2,'escort',$3) ON CONFLICT (employee_mobile) DO NOTHING`,
      [employeeMobile, name, actor.id],
    );
    const open = await client.query<{id: string}>(
      'SELECT id FROM program_assignments WHERE program_id = $1 AND end_date IS NULL',
      [current.id],
    );
    let predecessor: string | null = null;
    if (open.rowCount) {
      predecessor = open.rows[0].id;
      await client.query(
        `UPDATE program_assignments
            SET end_date = $2, end_shift = $3
          WHERE id = $1 AND end_date IS NULL`,
        [predecessor, startDate, startShift === 'D' ? 'N' : 'D'],
      );
    }
    const assignmentId = stableId('asg', ['assignment', current.id, employeeMobile, startDate, startShift, predecessor]);
    await client.query(
      `INSERT INTO program_assignments
         (id, program_id, employee_mobile, start_date, start_shift, predecessor_id, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'WEB',$7)
       ON CONFLICT (id) DO NOTHING`,
      [assignmentId, current.id, employeeMobile, startDate, startShift, predecessor, actor.id],
    );
    await client.query(
      `UPDATE programs SET escort_mobile = $2, escort_name = $3, state = 'ASSIGNED',
              start_date = $4, start_shift = $5, revision = revision + 1
        WHERE id = $1`,
      [current.id, employeeMobile, name, startDate, startShift],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [current.id, input.replace ? 'REPLACE_ASSIGNMENT' : 'ASSIGN_ESCORT', actor.id,
        JSON.stringify({employeeMobile, startDate, startShift, predecessor})],
    );
    await recordAudit({actor, action: 'ESCORT_ASSIGNED', entity: 'program', entityId: current.id,
      detail: {employeeMobile, startDate, startShift}}, client);
    return {programId: current.id, assignmentId};
  }
}

export async function assignEscort(
  actor: Actor,
  programIdValue: string,
  input: {employeeMobile: string; startDate?: string; startShift?: string; employeeName?: string; replace?: boolean},
  client?: Pick<PoolClient, 'query'>,
) {
  assertCapability(actor, 'vessel.command');
  if (client) return assignEscortOn(client, actor, programIdValue, input);
  return tx((txClient) => assignEscortOn(txClient, actor, programIdValue, input));
}

async function releaseProgramOn(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  programIdValue: string,
  input: {endDate: string; endShift: string; note?: string},
) {
  const endDate = isoDate(input.endDate, 'endDate');
  const endShift = shift(input.endShift, 'endShift');
  {
    const program = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!program.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = program.rows[0];
    if (current.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
    if (endDate < current.start_date) throw new DomainError('END_BEFORE_START');
    await client.query(
      `UPDATE programs SET end_date = $2, end_shift = $3, state = 'RELEASED', revision = revision + 1
        WHERE id = $1`,
      [current.id, endDate, endShift],
    );
    await client.query(
      `UPDATE program_assignments SET end_date = $2, end_shift = $3
        WHERE program_id = $1 AND end_date IS NULL`,
      [current.id, endDate, endShift],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload)
       VALUES ($1,'RELEASE_PROGRAM',$2,$3::jsonb)`,
      [current.id, actor.id, JSON.stringify({endDate, endShift, note: optionalText(input.note, 'note', 500)})],
    );
    await recordAudit({actor, action: 'PROGRAM_RELEASED', entity: 'program', entityId: current.id, detail: {endDate, endShift}}, client);
    return {programId: current.id};
  }
}

export async function releaseProgram(
  actor: Actor,
  programIdValue: string,
  input: {endDate: string; endShift: string; note?: string},
  client?: Pick<PoolClient, 'query'>,
) {
  assertCapability(actor, 'vessel.release');
  if (client) return releaseProgramOn(client, actor, programIdValue, input);
  return tx((txClient) => releaseProgramOn(txClient, actor, programIdValue, input));
}

async function voidProgramOn(client: Pick<PoolClient, 'query'>, actor: Actor, programIdValue: string, reason: string) {
  const note = text(reason, 'reason', {max: 500});
  {
    const program = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!program.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    await client.query(`UPDATE programs SET state = 'VOIDED', revision = revision + 1 WHERE id = $1`, [programIdValue]);
    await client.query(`UPDATE program_assignments SET end_date = coalesce(end_date, start_date) WHERE program_id = $1 AND end_date IS NULL`, [programIdValue]);
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload) VALUES ($1,'VOID_PROGRAM',$2,$3::jsonb)`,
      [programIdValue, actor.id, JSON.stringify({reason: note})],
    );
    await recordAudit({actor, action: 'PROGRAM_VOIDED', entity: 'program', entityId: programIdValue, detail: {reason: note}}, client);
    return {programId: programIdValue};
  }
}

export async function voidProgram(actor: Actor, programIdValue: string, reason: string, client?: Pick<PoolClient, 'query'>) {
  assertCapability(actor, 'vessel.command');
  if (client) return voidProgramOn(client, actor, programIdValue, reason);
  return tx((txClient) => voidProgramOn(txClient, actor, programIdValue, reason));
}

export type ProgramUpdateInput = {
  motherVessel?: string;
  lighterVessel?: string;
  masterMobile?: string | null;
  destination?: string | null;
  startDate?: string;
  startShift?: string;
  notes?: string | null;
};

/** Edit an active program without changing its immutable identity or history. */
export async function updateProgram(actor: Actor, programIdValue: string, input: ProgramUpdateInput) {
  assertCapability(actor, 'vessel.command');
  return tx(async (client) => {
    const found = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!found.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = found.rows[0];
    if (current.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
    if (current.state === 'COMPLETED') throw new DomainError('PROGRAM_COMPLETED', 409);

    const motherVessel = input.motherVessel === undefined ? current.mother_vessel : text(input.motherVessel, 'motherVessel', {max: 120});
    const lighterVessel = input.lighterVessel === undefined ? current.lighter_vessel : text(input.lighterVessel, 'lighterVessel', {max: 120});
    const startDate = input.startDate === undefined ? current.start_date : isoDate(input.startDate, 'startDate');
    const startShift = input.startShift === undefined ? current.start_shift : shift(input.startShift, 'startShift');
    const destination = input.destination === undefined ? current.destination : optionalText(input.destination, 'destination', 160);
    const notes = input.notes === undefined ? current.notes : optionalText(input.notes, 'notes', 2000);
    const masterMobileRaw = input.masterMobile === undefined ? current.master_mobile : optionalText(input.masterMobile, 'masterMobile', 40);
    const masterMobile = masterMobileRaw
      ? masterMobileRaw.replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1')
      : null;
    if (masterMobile !== null && !/^01[3-9][0-9]{8}$/.test(masterMobile)) {
      throw new DomainError('INVALID_MASTERMOBILE');
    }

    if (startDate !== current.start_date || lower(motherVessel) !== lower(current.mother_vessel) || lower(lighterVessel) !== lower(current.lighter_vessel)) {
      const duplicates = await potentialDuplicates({motherVessel, lighterVessel, startDate, excludeId: current.id});
      if (duplicates.some((candidate) => candidate.start_date === startDate)) {
        throw new DomainError('DUPLICATE_PROGRAM', 409, duplicates.find((candidate) => candidate.start_date === startDate)?.id);
      }
    }

    const updated = await client.query<ProgramRow>(
      `UPDATE programs
          SET mother_vessel=$2, lighter_vessel=$3, master_mobile=$4, destination=$5,
              start_date=$6, start_shift=$7, notes=$8, revision=revision+1
        WHERE id=$1
        RETURNING *, start_date::text AS start_date, end_date::text AS end_date`,
      [current.id, motherVessel, lighterVessel, masterMobile, destination, startDate, startShift, notes],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload)
       VALUES ($1,'UPDATE_PROGRAM',$2,$3::jsonb)`,
      [current.id, actor.id, JSON.stringify({before: {
        motherVessel: current.mother_vessel, lighterVessel: current.lighter_vessel,
        masterMobile: current.master_mobile, destination: current.destination,
        startDate: current.start_date, startShift: current.start_shift,
      }, after: {motherVessel, lighterVessel, masterMobile, destination, startDate, startShift}})],
    );
    await recordAudit({actor, action: 'PROGRAM_UPDATED', entity: 'program', entityId: current.id,
      detail: {startDate, startShift, destination}}, client);
    return {program: updated.rows[0]};
  });
}

/** Mark an assigned/draft program as actually running. */
export async function startProgramDuty(actor: Actor, programIdValue: string) {
  assertCapability(actor, 'vessel.command');
  return tx(async (client) => {
    const found = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!found.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = found.rows[0];
    if (!['DRAFT', 'CONFIRMED', 'ASSIGNED'].includes(current.state)) {
      throw new DomainError('PROGRAM_NOT_STARTABLE', 409);
    }
    await client.query("UPDATE programs SET state='IN_DUTY', revision=revision+1 WHERE id=$1", [current.id]);
    await client.query(
      "INSERT INTO program_events (program_id, action, actor, payload) VALUES ($1,'START_DUTY',$2,'{}'::jsonb)",
      [current.id, actor.id],
    );
    await recordAudit({actor, action: 'PROGRAM_IN_DUTY', entity: 'program', entityId: current.id}, client);
    return {programId: current.id, state: 'IN_DUTY'};
  });
}

/** Close an operational program after release. */
export async function completeProgram(actor: Actor, programIdValue: string) {
  assertCapability(actor, 'vessel.release');
  return tx(async (client) => {
    const found = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!found.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = found.rows[0];
    if (current.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
    if (!['RELEASED', 'IN_DUTY'].includes(current.state)) throw new DomainError('PROGRAM_NOT_COMPLETABLE', 409);
    if (!current.end_date) throw new DomainError('RELEASE_DATE_REQUIRED', 409);
    await client.query("UPDATE programs SET state='COMPLETED', revision=revision+1 WHERE id=$1", [current.id]);
    await client.query(
      "INSERT INTO program_events (program_id, action, actor, payload) VALUES ($1,'COMPLETE_PROGRAM',$2,'{}'::jsonb)",
      [current.id, actor.id],
    );
    await recordAudit({actor, action: 'PROGRAM_COMPLETED', entity: 'program', entityId: current.id}, client);
    return {programId: current.id, state: 'COMPLETED'};
  });
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

export async function listPrograms(filters: {q?: string; state?: string; escort?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const q = (filters.q ?? '').trim().toLowerCase();
  return rows<ProgramListRow>(
    `SELECT p.*, p.start_date::text AS start_date, p.end_date::text AS end_date, pp.state AS pay_state, pp.total_minor::text, pp.salary_minor::text, pp.conveyance_minor::text
       FROM programs p LEFT JOIN program_pay pp ON pp.program_id = p.id
      WHERE ($1 = '' OR lower(p.mother_vessel) LIKE '%' || $1 || '%'
             OR lower(p.lighter_vessel) LIKE '%' || $1 || '%'
             OR lower(coalesce(p.escort_name,'')) LIKE '%' || $1 || '%')
        AND ($2::text IS NULL OR p.state = $2)
        AND ($3::text IS NULL OR p.escort_mobile = $3)
      ORDER BY p.start_date DESC, p.created_at DESC
      LIMIT $4`,
    [q, filters.state ?? null, filters.escort ?? null, limit],
  );
}

export async function getProgram(programIdValue: string) {
  const program = await row<ProgramRow>(
    `SELECT id, revision, mother_vessel, lighter_vessel, master_mobile, destination,
            escort_name, escort_mobile, start_date::text AS start_date, start_shift,
            end_date::text AS end_date, end_shift, state, source_channel,
            source_message_id, source_chat_jid, confirmation_message_id, notes,
            created_by, created_at, updated_at
       FROM programs WHERE id = $1`,
    [programIdValue],
  );
  if (!program) throw new DomainError('PROGRAM_NOT_FOUND', 404);
  const pay = await row('SELECT * FROM program_pay WHERE program_id = $1', [programIdValue]);
  const assignments = await rows(
    `SELECT a.id, a.employee_mobile, e.preferred_name, a.start_date::text AS start_date, a.start_shift, a.end_date::text AS end_date, a.end_shift
       FROM program_assignments a LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
      WHERE a.program_id = $1 ORDER BY a.start_date DESC`,
    [programIdValue],
  );
  const events = await rows(
    'SELECT action, actor, payload, created_at FROM program_events WHERE program_id = $1 ORDER BY id DESC LIMIT 50',
    [programIdValue],
  );
  return {program, pay, assignments, events};
}
