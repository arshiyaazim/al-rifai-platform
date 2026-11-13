import type {PoolClient} from 'pg';
import {row, rows, tx, text, optionalText, isoDate, shift, mobile, optionalMobile, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';
import {assertCapability} from './authz.ts';
import {vesselKey, withinEditDistance} from '../vessel-match.ts';
import {evaluateSixFieldDedup, type SixFieldCandidate} from '../pipelines/vessel/six-field-dedup.ts';
import {ensureVessel} from '../pipelines/vessel/vessels.ts';
import {handleEscortChangeOn} from '../pipelines/vessel/escort-change.ts';
import {resolveMotherVesselAlias} from '../vessel-alias.ts';
import {emitDomainEvent} from '../realtime/server.ts';

export type ProgramInput = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile?: string | null;
  masterName?: string | null;
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
  master_name?: string | null;
  source_type?: string;
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
  source_chat_jid?: string | null;
  confirmation_message_id: string | null;
  confirmation_chat_jid?: string | null;
  confirmation_sender_jid?: string | null;
  confirmation_account_id?: string | null;
  confirmation_timestamp?: string | null;
  release_message_id?: string | null;
  release_chat_jid?: string | null;
  release_sender_jid?: string | null;
  release_account_id?: string | null;
  release_timestamp?: string | null;
  notes: string | null;
  created_by?: string;
  created_at: string;
  updated_at?: string;
  event_at?: string | null;
};

export type ProgramListRow = ProgramRow & {
  pay_state: 'CALCULATED' | 'UNRESOLVED' | null;
  shifts: number | null;
  total_minor: string | null;
  salary_minor: string | null;
  conveyance_minor: string | null;
};

const programId = (mother: string, lighter: string, startDate: string, startShift: string) =>
  stableId('prog', ['vessel-program', mother.toLowerCase(), lighter.toLowerCase(), startDate, startShift]);

/** Same rule as public.normalize_vessel_name(): strip MV, collapse spaces, uppercase. */
export function normalizeVesselName(value: string): string {
  return String(value ?? '')
    .replace(/^m\.?\s*v\.?\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/**
 * ±1 calendar day potential-duplicate check (never blocks; it warns).
 *
 * Vessel comparison uses the shared normalized key (`vesselKey`), so prefix,
 * punctuation, spacing and case differences ("M.V. Banglar-Modhumoti-1" vs
 * "MV Banglar Modhumoti 1") describe one vessel. Raw values are never rewritten
 * on the stored row.
 */
export async function potentialDuplicates(input: {motherVessel: string; lighterVessel: string; startDate: string; excludeId?: string}) {
  const candidates = await rows<{id: string; start_date: string; mother_vessel: string; lighter_vessel: string}>(
    `SELECT id, start_date::text AS start_date, mother_vessel, lighter_vessel FROM programs
      WHERE abs(start_date - $1::date) <= 1
        AND state <> 'VOIDED'
        AND ($2::text IS NULL OR id <> $2)`,
    [input.startDate, input.excludeId ?? null],
  );
  const mother = vesselKey(input.motherVessel);
  const lighter = vesselKey(input.lighterVessel);
  return candidates
    .filter((candidate) => vesselKey(candidate.mother_vessel) === mother && vesselKey(candidate.lighter_vessel) === lighter)
    .map((candidate) => ({id: candidate.id, start_date: candidate.start_date}));
}

/**
 * Candidate window for the Owner-approved six-field engine. Ninety days is
 * enough to cover a delayed confirmation or an escort change while keeping the
 * scan bounded; the register has a few hundred rows, not millions.
 */
async function loadSixFieldCandidates(
  client: Pick<PoolClient, 'query'>,
  startDate: string,
): Promise<SixFieldCandidate[]> {
  const found = await client.query<SixFieldCandidate & {start_date: string; start_shift: string}>(`
    SELECT id, mother_vessel AS "motherVessel", lighter_vessel AS "lighterVessel",
           master_mobile AS "masterMobile", escort_mobile AS "escortMobile",
           start_date::text AS "startDate", start_shift AS "startShift", state
      FROM programs
     WHERE state NOT IN ('VOIDED','WITHDRAWN')
       AND start_date BETWEEN $1::date - 90 AND $1::date + 90
     ORDER BY start_date DESC
     LIMIT 500`, [startDate]);
  return found.rows;
}

export type ProgramSource = {  channel?: 'WEB' | 'WHATSAPP' | 'IMPORT';
  sourceType?: 'MANUAL' | 'WHATSAPP_ORDER';
  messageId?: string | null;
  chatJid?: string | null;
  commandKey?: string | null;
};

async function createProgramOn(client: Pick<PoolClient, 'query'>, actor: Actor, input: ProgramInput, source: ProgramSource) {
  const commandKey = source.commandKey ?? null;
  const channel = source.channel ?? 'WEB';
  const sourceType = source.sourceType ?? (channel === 'WHATSAPP' ? 'WHATSAPP_ORDER' : 'MANUAL');
  const motherVessel = await resolveMotherVesselAlias(normalizeVesselName(text(input.motherVessel, 'motherVessel', {max: 120})), client);
  const lighterVessel = normalizeVesselName(text(input.lighterVessel, 'lighterVessel', {max: 120}));
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
  const masterName = optionalText(input.masterName, 'masterName', 150);
  const destination = optionalText(input.destination, 'destination', 160);
  const notes = optionalText(input.notes, 'notes', 2000);
  const escortMobile = optionalMobile(input.escortMobile, 'escortMobile');

  const duplicates = await potentialDuplicates({motherVessel, lighterVessel, startDate});
  const candidates = await loadSixFieldCandidates(client, startDate);
  const decision = evaluateSixFieldDedup({
    motherVessel, lighterVessel, masterMobile, escortMobile: escortMobile ?? null,
    startDate, startShift,
  }, candidates);

  if (decision.action === 'DUPLICATE') {
    throw new DomainError('DUPLICATE_PROGRAM', 409, decision.candidateId ?? undefined);
  }

  if (decision.action === 'UPDATE' && decision.candidateId) {
    const updated = await client.query<ProgramRow>(
      `UPDATE programs
          SET start_date = $2, start_shift = $3, end_date = $4, end_shift = $5,
              revision = revision + 1, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [decision.candidateId, startDate, startShift, endDate, endShift],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, command_key, actor, payload)
       VALUES ($1,'PROGRAM_WINDOW_UPDATED',$2,$3,$4::jsonb)`,
      [decision.candidateId, commandKey ? `window:${commandKey}` : null, actor.id,
        JSON.stringify({startDate, startShift, endDate, endShift, reason: 'LATEST_ASSIGNMENT_WINS'})],
    );
    await recordAudit({actor, action: 'VESSEL:PROGRAM_WINDOW_UPDATED', entity: 'program',
      entityId: decision.candidateId, detail: {startDate, startShift, endDate, endShift}}, client);
    return {program: updated.rows[0], potentialDuplicates: [], decision};
  }

  if (decision.action === 'ESCORT_CHANGE' && decision.candidateId && escortMobile) {
    const changed = await handleEscortChangeOn(client, actor, decision.candidateId, {
      name: optionalText(input.escortName, 'escortName', 150) ?? escortMobile,
      mobile: escortMobile,
      shift: startShift,
      eventAt: new Date().toISOString(),
    }, startDate);
    const created = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1', [changed.programId]);
    return {program: created.rows[0], potentialDuplicates: [], decision};
  }

  const id = programId(motherVessel, lighterVessel, startDate, startShift);
  const state = escortMobile ? 'ASSIGNED' : 'DRAFT';

  if (escortMobile) {
      const name = optionalText(input.escortName, 'escortName', 150) ?? escortMobile;
    await client.query(
      `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
       VALUES ($1,$2,'escort','escort',$3) ON CONFLICT (employee_mobile) DO NOTHING`,
      [escortMobile, name, actor.id],
    );
  }
  const inserted = await client.query<ProgramRow>(
      `INSERT INTO programs
         (id, mother_vessel, lighter_vessel, master_mobile, master_name, destination, escort_name, escort_mobile,
          start_date, start_shift, end_date, end_shift, state, source_channel, source_type, source_message_id,
          source_chat_jid, created_by, notes, event_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20::date)
     RETURNING *`,
    [id, motherVessel, lighterVessel, masterMobile, masterName, destination,
      optionalText(input.escortName, 'escortName', 150), escortMobile,
      startDate, startShift, endDate, endShift, state, channel, sourceType,
      source.messageId ?? null, source.chatJid ?? null, actor.id, notes, startDate],
  );
  await ensureVessel(client, motherVessel, 'mother');
  await ensureVessel(client, lighterVessel, 'lighter');
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
  return {program: inserted.rows[0], potentialDuplicates: duplicates, decision};
}

/**
 * Connect the optional draft-delivery queue after a committed DRAFT program.
 * No recipient approval means no queue record. Queue failure never rolls back
 * or hides the business program; it is logged for operator follow-up.
 */
async function enqueueDraftIfApproved(program: ProgramRow): Promise<void> {
  if (program.state !== 'DRAFT') return;
  try {
    const {runtimeDeliveryConfig, enqueueDraftForProgram} = await import('./vessel-draft-delivery-store.ts');
    const config = await runtimeDeliveryConfig();
    // The store resolves either the explicit Owner pin or the authorised Admin
    // from the original order conversation. No approval means no queue row.
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
  try {
    const {enqueueDraftDeliveries} = await import('../pipelines/vessel/draft-delivery.ts');
    await enqueueDraftDeliveries(result.program as never);
  } catch (error) {
    const code = error instanceof Error ? error.message.slice(0, 120) : 'DRAFT_DELIVERY_HOOK_FAILED';
    console.error(`Vessel draft delivery hook failed (${code}).`);
  }
  emitDomainEvent('VESSEL', 'PROGRAM_CREATED', result.program.id);
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
    if (current.state === 'WITHDRAWN') throw new DomainError('PROGRAM_WITHDRAWN', 409);
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
    // Owner rule P: a different escort mobile is a new program row linked to
    // the previous one; the previous row is WITHDRAWN, never overwritten.
    const currentEscort = String(current.escort_mobile ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');
    const nextEscort = employeeMobile.replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');
    if (currentEscort && currentEscort !== nextEscort) {
      const changed = await handleEscortChangeOn(client, actor, current.id, {
        name, mobile: nextEscort, shift: startShift, eventAt: new Date().toISOString(),
      }, startDate);
      return {programId: changed.programId, assignmentId: changed.assignmentId};
    }
    await client.query(
      `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
       VALUES ($1,$2,'escort','escort',$3) ON CONFLICT (employee_mobile) DO NOTHING`,
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
  return tx((txClient) => assignEscortOn(txClient, actor, programIdValue, input)).then((result) => {
    emitDomainEvent('VESSEL', 'ESCORT_ASSIGNED', programIdValue);
    return result;
  });
}

async function releaseProgramOn(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  programIdValue: string,
  input: {
    endDate: string;
    endShift: string;
    note?: string;
    release?: {
      messageId?: string | null;
      chatJid?: string | null;
      senderJid?: string | null;
      accountId?: string | null;
      timestamp?: string | null;
    } | null;
  },
) {
  const endDate = isoDate(input.endDate, 'endDate');
  const endShift = shift(input.endShift, 'endShift');
  const release = input.release ?? null;
  {
    const program = await client.query<ProgramRow>('SELECT * FROM programs WHERE id = $1 FOR UPDATE', [programIdValue]);
    if (!program.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
    const current = program.rows[0];
    if (current.state === 'VOIDED') throw new DomainError('PROGRAM_VOIDED', 409);
    if (current.state === 'COMPLETED') throw new DomainError('PROGRAM_COMPLETED', 409);
    // DATE is returned as a Date object by `SELECT *`; compare the text form.
    const dates = await client.query<{start_date: string; end_date: string | null}>(
      'SELECT start_date::text AS start_date, end_date::text AS end_date FROM programs WHERE id = $1',
      [programIdValue],
    );
    const startDate = dates.rows[0]?.start_date ?? String(current.start_date);
    const currentEnd = dates.rows[0]?.end_date ?? null;
    if (endDate < startDate) throw new DomainError('END_BEFORE_START');
    // Re-applying the same release is idempotent: no new revision, event or
    // duplicate release record. A correction with different values is still an
    // explicit authorised update.
    if (current.state === 'RELEASED' && currentEnd === endDate && current.end_shift === endShift) {
      return {programId: current.id, idempotent: true};
    }
    await client.query(
      `UPDATE programs
          SET end_date = $2,
              end_shift = $3,
              state = 'RELEASED',
              revision = revision + 1,
              release_message_id = COALESCE($4, release_message_id),
              release_chat_jid = COALESCE($5, release_chat_jid),
              release_sender_jid = COALESCE($6, release_sender_jid),
              release_account_id = COALESCE($7, release_account_id),
              release_timestamp = COALESCE($8, release_timestamp)
        WHERE id = $1`,
      [
        current.id, endDate, endShift,
        release?.messageId ?? null, release?.chatJid ?? null, release?.senderJid ?? null,
        release?.accountId ?? null, release?.timestamp ?? null,
      ],
    );
    await client.query(
      `UPDATE program_assignments SET end_date = $2, end_shift = $3
        WHERE program_id = $1 AND end_date IS NULL`,
      [current.id, endDate, endShift],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload)
       VALUES ($1,'RELEASE_PROGRAM',$2,$3::jsonb)`,
      [current.id, actor.id, JSON.stringify({
        endDate, endShift, note: optionalText(input.note, 'note', 500),
        releaseMessageId: release?.messageId ?? null,
        releaseChatJid: release?.chatJid ?? null,
        releaseSenderJid: release?.senderJid ?? null,
        releaseAccountId: release?.accountId ?? null,
        releaseTimestamp: release?.timestamp ?? null,
      })],
    );
    await recordAudit({actor, action: 'PROGRAM_RELEASED', entity: 'program', entityId: current.id,
      detail: {
        endDate, endShift,
        releaseMessageId: release?.messageId ?? null,
        releaseChatJid: release?.chatJid ?? null,
        releaseSenderJid: release?.senderJid ?? null,
        releaseAccountId: release?.accountId ?? null,
      }}, client);
    return {programId: current.id, idempotent: false};
  }
}

export async function releaseProgram(
  actor: Actor,
  programIdValue: string,
  input: {
    endDate: string;
    endShift: string;
    note?: string;
    release?: {
      messageId?: string | null;
      chatJid?: string | null;
      senderJid?: string | null;
      accountId?: string | null;
      timestamp?: string | null;
    } | null;
  },
  client?: Pick<PoolClient, 'query'>,
) {
  assertCapability(actor, 'vessel.release');
  if (client) return releaseProgramOn(client, actor, programIdValue, input);
  return tx((txClient) => releaseProgramOn(txClient, actor, programIdValue, input)).then((result) => {
    emitDomainEvent('VESSEL', 'PROGRAM_RELEASED', programIdValue);
    return result;
  });
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
  return tx((txClient) => voidProgramOn(txClient, actor, programIdValue, reason)).then((result) => {
    emitDomainEvent('VESSEL', 'PROGRAM_VOIDED', programIdValue);
    return result;
  });
}

export type ProgramUpdateInput = {
  motherVessel?: string;
  lighterVessel?: string;
  masterMobile?: string | null;
  masterName?: string | null;
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

    const motherVessel = input.motherVessel === undefined ? current.mother_vessel
      : await resolveMotherVesselAlias(normalizeVesselName(text(input.motherVessel, 'motherVessel', {max: 120})), client);
    const lighterVessel = input.lighterVessel === undefined ? current.lighter_vessel : normalizeVesselName(text(input.lighterVessel, 'lighterVessel', {max: 120}));
    const startDate = input.startDate === undefined ? current.start_date : isoDate(input.startDate, 'startDate');
    const startShift = input.startShift === undefined ? current.start_shift : shift(input.startShift, 'startShift');
    const masterName = input.masterName === undefined ? (current.master_name ?? null) : optionalText(input.masterName, 'masterName', 150);
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
          SET mother_vessel=$2, lighter_vessel=$3, master_mobile=$4, master_name=$5, destination=$6,
              start_date=$7, start_shift=$8, notes=$9, revision=revision+1
        WHERE id=$1
        RETURNING *, start_date::text AS start_date, end_date::text AS end_date`,
      [current.id, motherVessel, lighterVessel, masterMobile, masterName, destination, startDate, startShift, notes],
    );
    await client.query(
      `INSERT INTO program_events (program_id, action, actor, payload)
       VALUES ($1,'UPDATE_PROGRAM',$2,$3::jsonb)`,
      [current.id, actor.id, JSON.stringify({before: {
        motherVessel: current.mother_vessel, lighterVessel: current.lighter_vessel,
        masterMobile: current.master_mobile, destination: current.destination,
        startDate: current.start_date, startShift: current.start_shift,
      }, after: {motherVessel, lighterVessel, masterMobile, masterName, destination, startDate, startShift}})],
    );
    await recordAudit({actor, action: 'PROGRAM_UPDATED', entity: 'program', entityId: current.id,
      detail: {startDate, startShift, destination}}, client);
    return {program: updated.rows[0]};
  }).then((result) => {
    emitDomainEvent('VESSEL', 'PROGRAM_UPDATED', programIdValue);
    return result;
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
  }).then((result) => {
    emitDomainEvent('VESSEL', 'PROGRAM_IN_DUTY', result.programId);
    return result;
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
  }).then((result) => {
    emitDomainEvent('VESSEL', 'PROGRAM_COMPLETED', result.programId);
    return result;
  });
}

function lower(value: string): string {
  return value.trim().toLowerCase();
}

export type ProgramListFilters = {
  q?: string;
  state?: string;
  escort?: string;
  escortMobile?: string;
  mother?: string;
  from?: string;
  to?: string;
  limit?: number;
  offset?: number;
};

function programFilterSql(
  filters: ProgramListFilters,
  searchKeys: string[] = [],
  qKey = '',
): {clause: string; values: unknown[]} {
  const q = (filters.q ?? '').trim().toLowerCase();
  // Stored vessel names are canonical, so a search must compare on the same
  // projection the canonicaliser produces (vesselKey): case, dots, dashes,
  // spaces and the MV prefix are ignored. The raw clauses stay for names and
  // mobiles that are not vessel keys.
  const keyOf = (column: string) => `regexp_replace(upper(${column}), '[^A-Z0-9]', '', 'g')`;
  return {
    clause: `WHERE (
        ($1 = '' AND $8 = '' AND cardinality($9::text[]) = 0)
        OR ($1 <> '' AND (
             lower(p.mother_vessel) LIKE '%' || $1 || '%'
             OR lower(p.lighter_vessel) LIKE '%' || $1 || '%'
             OR lower(coalesce(p.escort_name,'')) LIKE '%' || $1 || '%'
             OR p.master_mobile LIKE '%' || $1 || '%'
             OR ($8 <> '' AND (${keyOf('p.mother_vessel')} LIKE '%' || $8 || '%'
                           OR ${keyOf('p.lighter_vessel')} LIKE '%' || $8 || '%'))
        ))
        OR (cardinality($9::text[]) > 0 AND (${keyOf('p.mother_vessel')} = ANY($9::text[])
                                          OR ${keyOf('p.lighter_vessel')} = ANY($9::text[])))
      )
        AND ($2::text IS NULL OR p.state = $2)
        AND ($3::text IS NULL OR p.escort_mobile = $3)
        AND ($4::date IS NULL OR p.start_date >= $4)
        AND ($5::date IS NULL OR p.start_date <= $5)
        AND ($6::text IS NULL OR lower(btrim(p.mother_vessel)) = lower(btrim($6)))
        AND ($7::text IS NULL OR p.escort_mobile = $7)`,
    values: [q, filters.state ?? null, filters.escort ?? null, filters.from ?? null, filters.to ?? null, filters.mother ?? null, filters.escortMobile ?? null, qKey, searchKeys],
  };
}

export type VesselSearchResolution = {
  keys: string[];
  ambiguous: boolean;
  tolerant: boolean;
  reason: 'NO_QUERY' | 'SHORT_KEY' | 'NONE' | 'UNIQUE' | 'AMBIGUOUS';
};

/**
 * Spelling-tolerant vessel search (operator rule: up to 3 letters).
 *
 * Normalisation reuses `vesselKey()` — the same function that produces the key
 * for a stored name — so "MV Page", "mv-page", "M.V. Page" and "mV pAgE" all
 * reduce to PAGE. When that key has no exact/substring match, a bounded
 * Levenshtein distance of at most 3 is applied to the normalised key, with two
 * guards: the query key must be at least 5 characters (too little signal
 * below that), and only an unambiguous single candidate may be used. Two or
 * more candidates are returned together and flagged `ambiguous` so callers can
 * show both instead of silently merging them.
 */
export async function resolveVesselSearchKeys(
  q: string,
  filters: ProgramListFilters = {},
): Promise<VesselSearchResolution> {
  const key = vesselKey(q).toUpperCase();
  if (!key) return {keys: [], ambiguous: false, tolerant: false, reason: 'NO_QUERY'};
  if (key.length < 5) return {keys: [], ambiguous: false, tolerant: false, reason: 'SHORT_KEY'};
  const keyOf = (column: string) => `regexp_replace(upper(${column}), '[^A-Z0-9]', '', 'g')`;
  const candidates = await rows<{vkey: string}>(
    `SELECT DISTINCT ${keyOf('p.mother_vessel')} AS vkey FROM programs p
      WHERE ${keyOf('p.mother_vessel')} <> ''
        AND ($1::text IS NULL OR p.state = $1)
        AND ($2::date IS NULL OR p.start_date >= $2)
        AND ($3::date IS NULL OR p.start_date <= $3)
     UNION
     SELECT DISTINCT ${keyOf('p.lighter_vessel')} AS vkey FROM programs p
      WHERE ${keyOf('p.lighter_vessel')} <> ''
        AND ($1::text IS NULL OR p.state = $1)
        AND ($2::date IS NULL OR p.start_date >= $2)
        AND ($3::date IS NULL OR p.start_date <= $3)
     LIMIT 2000`,
    [filters.state ?? null, filters.from ?? null, filters.to ?? null],
  );
  const matches = candidates
    .map((candidate) => candidate.vkey)
    .filter((candidate) => withinEditDistance(key, candidate, 3));
  if (matches.length === 0) return {keys: [], ambiguous: false, tolerant: true, reason: 'NONE'};
  if (matches.length === 1) return {keys: matches, ambiguous: false, tolerant: true, reason: 'UNIQUE'};
  return {keys: matches, ambiguous: true, tolerant: true, reason: 'AMBIGUOUS'};
}

export async function listPrograms(filters: ProgramListFilters = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const resolved = filters.mother
    ? {...filters, mother: await resolveMotherVesselAlias(normalizeVesselName(filters.mother))}
    : filters;
  const qKey = vesselKey(filters.q ?? '').toUpperCase();
  const select = (clause: string, values: unknown[]) =>
    rows<ProgramListRow>(
      `SELECT p.*, p.start_date::text AS start_date, p.end_date::text AS end_date,
              pp.state AS pay_state, pp.shifts, pp.total_minor::text, pp.salary_minor::text, pp.conveyance_minor::text
         FROM programs p LEFT JOIN program_pay pp ON pp.program_id = p.id
         ${clause}
        ORDER BY p.start_date DESC, p.created_at DESC
        LIMIT $10 OFFSET $11`,
      [...values, limit, offset],
    );
  let {clause, values} = programFilterSql(resolved, [], qKey);
  const found = await select(clause, values);
  if (found.length || qKey.length < 5) return found;
  // No literal match: fall back to the bounded spelling tolerance, which only
  // ever widens the result when the match is unambiguous.
  const tolerance = await resolveVesselSearchKeys(filters.q ?? '', filters);
  if (!tolerance.keys.length) return found;
  ({clause, values} = programFilterSql(resolved, tolerance.keys, qKey));
  return select(clause, values);
}

export async function countPrograms(filters: ProgramListFilters = {}) {
  const resolved = filters.mother
    ? {...filters, mother: await resolveMotherVesselAlias(normalizeVesselName(filters.mother))}
    : filters;
  const qKey = vesselKey(filters.q ?? '').toUpperCase();
  const count = (clause: string, values: unknown[]) =>
    row<{count: string}>(`SELECT count(*)::text AS count FROM programs p ${clause}`, values);
  let {clause, values} = programFilterSql(resolved, [], qKey);
  const counted = await count(clause, values);
  if (Number(counted?.count ?? 0) > 0 || qKey.length < 5) return Number(counted?.count ?? 0);
  const tolerance = await resolveVesselSearchKeys(filters.q ?? '', filters);
  if (!tolerance.keys.length) return 0;
  ({clause, values} = programFilterSql(resolved, tolerance.keys, qKey));
  const widened = await count(clause, values);
  return Number(widened?.count ?? 0);
}

/**
 * Mother-vessel facet counts for the current search/state filter. The mother
 * filter is intentionally excluded so the list still shows every choice.
 */
export async function motherFacets(filters: {q?: string; state?: string} = {}) {
  const {clause, values} = programFilterSql({q: filters.q, state: filters.state});
  const facets = await rows<{name: string; count: string}>(
    `SELECT p.mother_vessel AS name, count(*)::text AS count
       FROM programs p ${clause}
      GROUP BY p.mother_vessel
      ORDER BY lower(p.mother_vessel)`,
    values,
  );
  return facets.map((facet) => ({name: facet.name, count: Number(facet.count)}));
}

export async function getProgram(programIdValue: string) {
  const program = await row<ProgramRow>(
    `SELECT id, revision, mother_vessel, lighter_vessel, master_mobile, master_name, source_type, destination,
            escort_name, escort_mobile, start_date::text AS start_date, start_shift,
            end_date::text AS end_date, end_shift, state, source_channel,
            source_message_id, source_chat_jid, confirmation_message_id,
            confirmation_chat_jid, confirmation_sender_jid, confirmation_account_id,
            confirmation_timestamp, release_message_id, release_chat_jid,
            release_sender_jid, release_account_id, release_timestamp, notes,
            created_by, created_at, updated_at, event_at
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
