// Central message_review_queue access for the extended /review page.
// This queue is separate from review_items; it stores raw messages that need a
// workflow decision (Vessel / Release / Issue / Ignore).

import {row, rows} from './db.ts';
import {recordAudit} from './audit.ts';
import type {Actor} from './db.ts';

export type MessageReviewRow = {
  id: string;
  source_account_id: string;
  source_chat_jid: string;
  source_message_id: string;
  source_timestamp: string;
  sender_jid: string;
  sender_display_name: string | null;
  sender_mobile: string | null;
  message_text: string;
  confusion_reason: string;
  suggested_workflow: string | null;
  resolved_workflow: string | null;
  resolved_payload: Record<string, unknown> | null;
  admin_comment: string | null;
  status: string;
  created_at: string;
};

export async function listMessageReviewQueue(input: {state?: string; limit?: number} = {}): Promise<MessageReviewRow[]> {
  const state = input.state && input.state !== 'ALL' ? input.state : 'PENDING';
  const limit = Math.min(Math.max(Number(input.limit) || 100, 1), 500);
  return rows<MessageReviewRow>(
    `SELECT * FROM message_review_queue
      WHERE status = $1
      ORDER BY created_at DESC
      LIMIT $2`,
    [state, limit],
  );
}

export async function resolveMessageReviewQueue(
  actor: Actor,
  id: string,
  decision: 'APPROVED' | 'REJECTED' | 'IGNORED' | 'SENT_BACK',
  input: {comment?: string; workflow?: string; payload?: Record<string, unknown>} = {},
): Promise<{id: string; status: string}> {
  const updated = await row<{id: string; status: string}>(
    `UPDATE message_review_queue
        SET status=$2,
            resolved_workflow=COALESCE($3,resolved_workflow),
            resolved_payload=COALESCE($4::jsonb,resolved_payload),
            admin_comment=COALESCE($5,admin_comment),
            resolved_by=$6,
            resolved_at=now()
      WHERE id=$1
      RETURNING id,status`,
    [id, decision, input.workflow ?? null, input.payload ? JSON.stringify(input.payload) : null, input.comment ?? null, actor.id],
  );
  if (!updated) throw new Error('REVIEW_ITEM_NOT_FOUND');
  await recordAudit({
    actor,
    action: `VESSEL:QUEUE_${decision}`,
    entity: 'message_review_queue',
    entityId: id,
    detail: {workflow: input.workflow ?? null, comment: input.comment ?? null},
  });
  return updated;
}

type ApproveInput = {comment?: string; workflow?: string; payload?: Record<string, unknown>};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');
const pick = (payload: Record<string, unknown>, keys: string[]) => {
  for (const key of keys) {
    const value = clean(payload[key]);
    if (value) return value;
  }
  return '';
};

/** Approve a Vessel/Release queue item and apply its resolved payload. */
export async function approveMessageReviewQueue(
  actor: Actor,
  id: string,
  input: ApproveInput = {},
): Promise<{id: string; status: string; programId: string | null}> {
  const {tx} = await import('./db.ts');
  const {vesselKey, programIdFor} = await import('../vessel-match.ts');
  const {normalizeDraftDate, normalizeDraftShift} = await import('../order-draft-from-record.ts');
  const {orderIntakeDateAndShift} = await import('../order-intake-shift.ts');
  const {renderOwnerDraftFields} = await import('../order-draft-template.ts');
  const {stableId} = await import('./audit.ts');

  return tx(async (client) => {
    const found = await client.query<Record<string, unknown>>('SELECT * FROM message_review_queue WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new Error('REVIEW_ITEM_NOT_FOUND');
    const item = found.rows[0];
    const payload = {...((item.resolved_payload as Record<string, unknown> | null) ?? {}), ...(input.payload ?? {})};
    const workflow = String(input.workflow ?? item.resolved_workflow ?? item.suggested_workflow ?? 'vessel').toLowerCase();
    let programId: string | null = null;

    if (workflow === 'vessel') {
      const mother = pick(payload, ['motherVessel', 'mother_vessel', 'mother']).replace(/^m\.?\s*v\.?\s*[:.,-]?\s*/i, '');
      const lighter = pick(payload, ['lighterVessel', 'lighter_vessel', 'lighter']).replace(/^m\.?\s*v\.?\s*[:.,-]?\s*/i, '');
      const master = digits(pick(payload, ['masterMobile', 'master_mobile', 'master']));
      if (!mother || !lighter || !master) throw new Error('REVIEW_VESSEL_FIELDS_REQUIRED');
      const eventAt = String(item.source_timestamp);
      const fallback = orderIntakeDateAndShift(eventAt, String(item.message_text ?? ''));
      const requestedStart = normalizeDraftDate(pick(payload, ['startDate', 'start_date', 'date', 'assignmentDate']));
      const lookupDate = requestedStart || fallback?.date || eventAt.slice(0, 10);
      const escortName = pick(payload, ['escortName', 'escort_name']);
      const escortMobile = digits(pick(payload, ['escortMobile', 'escort_mobile']));
      const confirmed = Boolean(escortName && escortMobile);
      if (escortMobile) {
        const employee = await client.query('SELECT 1 FROM employees WHERE employee_mobile=$1', [`+88${escortMobile}`]);
        if (!employee.rowCount) throw new Error('ESCORT_NOT_IN_EMPLOYEES');
      }
      const orderKey = `${vesselKey(mother)}|${vesselKey(lighter)}`;
      const requestedId = pick(payload, ['programId', 'program_id']);
      let existing = requestedId
        ? (await client.query<Record<string, unknown>>('SELECT * FROM programs WHERE id=$1 FOR UPDATE', [requestedId])).rows[0]
        : (await client.query<Record<string, unknown>>(
            `SELECT * FROM programs WHERE order_key=$1 AND start_date=$2::date AND state <> 'VOIDED' ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
            [orderKey, lookupDate],
          )).rows[0];
      if (!existing) {
        existing = (await client.query<Record<string, unknown>>(
          `SELECT * FROM programs WHERE lower(btrim(mother_vessel))=lower(btrim($1)) AND lower(btrim(lighter_vessel))=lower(btrim($2)) AND start_date=$3::date AND state <> 'VOIDED' LIMIT 1 FOR UPDATE`,
          [mother, lighter, lookupDate],
        )).rows[0];
      }
      const existingDate = existing ? normalizeDraftDate(existing.start_date) : '';
      const startDate = requestedStart || existingDate || lookupDate;
      const rawShift = normalizeDraftShift(pick(payload, ['shift', 'startShift', 'start_shift']))
        || (existing ? String(existing.start_shift) : fallback?.shift) || 'D';
      const shift: 'D' | 'N' = rawShift === 'N' ? 'N' : 'D';
      const existingEventAt = existing?.event_at instanceof Date ? existing.event_at.toISOString() : String(existing?.event_at ?? '');
      const eventAtValue = pick(payload, ['eventAt', 'event_at']) || existingEventAt || eventAt;
      const destination = pick(payload, ['destination']) || null;
      const draftText = renderOwnerDraftFields({
        motherVessel: mother, lighterVessel: lighter, masterMobile: master, destination,
        escortName: confirmed ? escortName : null, escortMobile: confirmed ? escortMobile : null,
        date: startDate, shift,
      });
      if (existing) {
        programId = String(existing.id);
        const nextState = existing.state === 'RELEASED' ? 'RELEASED' : confirmed ? 'CONFIRMED' : 'DRAFT';
        await client.query(
          `UPDATE programs
              SET mother_vessel=$2, lighter_vessel=$3, master_mobile=$4, destination=$5,
                  escort_name=$6, escort_mobile=$7, start_date=$8, start_shift=$9,
                  state=$10, event_at=$11, order_key=$12, draft_text=$13,
                  confirmation_message_id=COALESCE($14,confirmation_message_id),
                  confirmation_chat_jid=COALESCE($15,confirmation_chat_jid),
                  confirmation_sender_jid=COALESCE($16,confirmation_sender_jid),
                  confirmation_account_id=COALESCE($17,confirmation_account_id),
                  confirmation_timestamp=COALESCE($18,confirmation_timestamp),
                  revision=revision+1, updated_at=now()
            WHERE id=$1`,
          [programId, mother, lighter, master, destination,
            confirmed ? escortName : null, confirmed ? `+88${escortMobile}` : null,
            startDate, shift, nextState, eventAtValue, orderKey, draftText,
            confirmed ? String(item.source_message_id) : null,
            confirmed ? String(item.source_chat_jid) : null,
            confirmed ? String(item.sender_jid) : null,
            confirmed ? String(item.source_account_id) : null,
            confirmed ? eventAt : null],
        );
      } else {
        programId = `prog_${programIdFor({account: String(item.source_account_id), clientChat: String(item.source_chat_jid), mother, lighter, startDate, shift})}`;
        await client.query(
          `INSERT INTO programs(id,revision,mother_vessel,lighter_vessel,master_mobile,destination,
             escort_name,escort_mobile,start_date,start_shift,state,source_channel,source_type,
             source_message_id,source_chat_jid,notes,created_by,event_at,source_block_key,order_key,draft_text,
             confirmation_message_id,confirmation_chat_jid,confirmation_sender_jid,confirmation_account_id,confirmation_timestamp)
           VALUES($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'WHATSAPP','WHATSAPP_ORDER',$11,$12,$13,$14,$15,$16,$17,$18,
             $19,$20,$21,$22,$23)`,
          [programId, mother, lighter, master, destination,
            confirmed ? escortName : null, confirmed ? `+88${escortMobile}` : null,
            startDate, shift, confirmed ? 'CONFIRMED' : 'DRAFT',
            String(item.source_message_id), String(item.source_chat_jid),
            `Approved from message_review_queue ${id}`, actor.id, eventAt, `review:${id}`, orderKey, draftText,
            confirmed ? String(item.source_message_id) : null,
            confirmed ? String(item.source_chat_jid) : null,
            confirmed ? String(item.sender_jid) : null,
            confirmed ? String(item.source_account_id) : null,
            confirmed ? eventAt : null],
        );
        await client.query(
          `INSERT INTO program_events(program_id,action,command_key,actor,payload) VALUES($1,'CREATE_PROGRAM',$2,$3,$4::jsonb)`,
          [programId, `review-approve:${id}`, actor.id, JSON.stringify({reviewId: id, workflow})],
        );
      }
      if (confirmed) {
        const open = await client.query<{id: string}>('SELECT id FROM program_assignments WHERE program_id=$1 AND end_date IS NULL', [programId]);
        if (open.rowCount) {
          await client.query('UPDATE program_assignments SET employee_mobile=$2 WHERE id=$1', [open.rows[0].id, `+88${escortMobile}`]);
        } else {
          await client.query(
            `INSERT INTO program_assignments(id,program_id,revision,employee_mobile,start_date,start_shift,source,created_by)
             VALUES($1,$2,1,$3,$4,$5,'WHATSAPP',$6)`,
            [stableId('asg', ['review-approve', programId, escortMobile, startDate, shift]), programId, `+88${escortMobile}`, startDate, shift, actor.id],
          );
        }
        await client.query(
          `INSERT INTO program_events(program_id,action,command_key,actor,payload) VALUES($1,'CONFIRM_PROGRAM',$2,$3,$4::jsonb)`,
          [programId, `review-confirm:${id}`, actor.id, JSON.stringify({reviewId: id, escortMobile})],
        );
      }
    } else if (workflow === 'release') {
      const programIdInput = pick(payload, ['programId', 'program_id']);
      const escortMobile = digits(pick(payload, ['escortMobile', 'escort_mobile']));
      const endDate = normalizeDraftDate(pick(payload, ['endDate', 'end_date', 'releaseDate', 'release_date']));
      const endShift = normalizeDraftShift(pick(payload, ['endShift', 'end_shift', 'shift']));
      let program = programIdInput
        ? (await client.query<Record<string, unknown>>('SELECT * FROM programs WHERE id=$1 FOR UPDATE', [programIdInput])).rows[0]
        : undefined;
      if (!program && escortMobile) {
        program = (await client.query<Record<string, unknown>>(
          `SELECT * FROM programs WHERE escort_mobile=$1 AND state='CONFIRMED' ORDER BY start_date DESC LIMIT 1 FOR UPDATE`,
          [`+88${escortMobile}`],
        )).rows[0];
      }
      if (!program) throw new Error('RELEASE_PROGRAM_NOT_FOUND');
      if (!endDate || !endShift) throw new Error('RELEASE_DATE_REQUIRED');
      programId = String(program.id);
      await client.query(
        `UPDATE programs SET state='RELEASED', end_date=$2, end_shift=$3, revision=revision+1,
            release_message_id=$4, release_chat_jid=$5, release_sender_jid=$6, release_account_id=$7,
            release_timestamp=$8, updated_at=now()
          WHERE id=$1`,
        [programId, endDate, endShift, String(item.source_message_id), String(item.source_chat_jid),
          String(item.sender_jid), String(item.source_account_id), String(item.source_timestamp)],
      );
      await client.query(
        `UPDATE program_assignments SET end_date=$2, end_shift=$3 WHERE program_id=$1 AND end_date IS NULL`,
        [programId, endDate, endShift],
      );
      await client.query(
        `INSERT INTO program_events(program_id,action,command_key,actor,payload) VALUES($1,'RELEASE_PROGRAM',$2,$3,$4::jsonb)`,
        [programId, `review-release:${id}`, actor.id, JSON.stringify({reviewId: id, endDate, endShift})],
      );
    } else {
      throw new Error('REVIEW_WORKFLOW_NOT_APPLICABLE');
    }

    const updated = await client.query<{id: string; status: string}>(
      `UPDATE message_review_queue
          SET status='APPROVED', resolved_workflow=$2, resolved_payload=$3::jsonb,
              admin_comment=COALESCE($4,admin_comment), resolved_by=$5, resolved_at=now()
        WHERE id=$1 RETURNING id,status`,
      [id, workflow, JSON.stringify(payload), input.comment ?? null, actor.id],
    );
    await recordAudit({
      actor,
      action: 'REVIEW_APPROVED',
      entity: 'message_review_queue',
      entityId: id,
      detail: {workflow, programId, payload},
    }, client);
    return {id: updated.rows[0].id, status: updated.rows[0].status, programId};
  });
}
