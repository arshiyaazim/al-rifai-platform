// Human-readable vessel review queue.
//
// Two storage tables hold vessel review work:
//   message_review_queue (raw WhatsApp messages, status PENDING/…)
//   review_items         (router/domain review items, state PENDING/…)
//
// The UI must never show rev_…/prog_…/ACA… identifiers as the primary label.
// This module maps both sources into one row shape with a Bengali problem
// description, the sender, the chat type, the full message and editable fields.

import {parseEscortOrder} from '../escort-intake-candidate.mjs';
import {row, rows, tx, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';
import {vesselKey} from '../vessel-match.ts';
import {renderOwnerDraftFields} from '../order-draft-template.ts';
import {approveMessageReviewQueue, resolveMessageReviewQueue} from './message-review-queue.ts';
import {resolveMotherVesselAlias} from '../vessel-alias.ts';
import {correctReviewItem} from './review.ts';

export type ReviewFields = {
  motherVessel: string;
  lighterVessel: string;
  masterMobile: string;
  escortName: string;
  escortMobile: string;
  startDate: string;
  shift: '' | 'D' | 'N';
};

export type UnifiedVesselReview = {
  kind: 'message' | 'item';
  id: string;
  sender: string;
  chatType: 'Direct' | 'Group';
  chatJid: string;
  problem: string;
  reasonCode: string;
  message: string;
  timestamp: string;
  createdAt: string;
  fields: ReviewFields;
};

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();
const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9][0-9]{8})$/, '0$1');

function chatType(jid: string): 'Direct' | 'Group' {
  return String(jid ?? '').endsWith('@g.us') ? 'Group' : 'Direct';
}

function problemFor(reason: string, category: string): string {
  const code = `${reason} ${category}`.toUpperCase();
  if (code.includes('ESCORT_NOT_IN_EMPLOYEES')) return 'এস্কর্ট employee DB-তে নেই';
  if (code.includes('SHIFT_CONFLICT')) return 'শিফট দ্বন্দ্ব';
  if (code.includes('AMBIGUOUS') || code.includes('UNMATCHED')) return 'ড্রাফট তৈরি হয়েছে কিন্তু confirm হয়নি';
  if (code.includes('DUPLICATE')) return 'ডুপ্লিকেট সন্দেহ';
  if (code.includes('INCOMPLETE') || code.includes('MISSING')) return 'তারিখ/শিফট মিসিং';
  if (code.includes('EXTRACTION_FAILED') || code.includes('UNKNOWN')) return 'অস্পষ্ট বার্তা';
  if (code.includes('SCORE_')) return 'ড্রাফট তৈরি হয়েছে কিন্তু confirm হয়নি';
  return 'অস্পষ্ট বার্তা';
}

function fieldsFrom(text: string, timestamp: string): ReviewFields {
  const empty: ReviewFields = {
    motherVessel: '', lighterVessel: '', masterMobile: '', escortName: '',
    escortMobile: '', startDate: '', shift: '',
  };
  try {
    const blocks = parseEscortOrder(text, {messageDate: String(timestamp ?? '').slice(0, 10)}) as Array<Record<string, unknown>>;
    const block = blocks[0];
    if (!block) return empty;
    const fields = (block.fields ?? {}) as Record<string, unknown>;
    return {
      motherVessel: clean(fields.motherVessel),
      lighterVessel: clean(fields.lighterVessel),
      masterMobile: digits(block.masterMobile ?? fields.masterMobile),
      escortName: clean(fields.escortName),
      escortMobile: digits(block.employeeMobile ?? fields.escortMobile),
      startDate: String(block.assignmentDate ?? '').slice(0, 10),
      shift: block.shift === 'D' || block.shift === 'N' ? block.shift : '',
    };
  } catch {
    return empty;
  }
}

export async function listUnifiedVesselReview(limit = 200): Promise<UnifiedVesselReview[]> {
  const [messages, items] = await Promise.all([
    rows<Record<string, unknown>>(
      `SELECT id::text, sender_display_name, sender_mobile, sender_jid, source_chat_jid,
              source_timestamp::text AS source_timestamp, message_text, confusion_reason,
              suggested_workflow, status, created_at::text AS created_at
         FROM message_review_queue WHERE status = 'PENDING'
         ORDER BY created_at DESC LIMIT $1`, [limit]),
    rows<Record<string, unknown>>(
      `SELECT id, payload, category, state, target_ref, created_at::text AS created_at
         FROM review_items WHERE state = 'PENDING' AND domain = 'PROGRAM'
         ORDER BY created_at DESC LIMIT $1`, [limit]),
  ]);

  const mapped: UnifiedVesselReview[] = [];
  for (const item of messages) {
    const text = String(item.message_text ?? '');
    const timestamp = String(item.source_timestamp ?? '');
    mapped.push({
      kind: 'message',
      id: String(item.id),
      sender: clean(item.sender_display_name) || clean(item.sender_mobile) || clean(item.sender_jid) || 'Unknown',
      chatType: chatType(String(item.source_chat_jid ?? '')),
      chatJid: String(item.source_chat_jid ?? ''),
      problem: problemFor(String(item.confusion_reason ?? ''), ''),
      reasonCode: String(item.confusion_reason ?? ''),
      message: text,
      timestamp,
      createdAt: String(item.created_at ?? timestamp),
      fields: fieldsFrom(text, timestamp),
    });
  }
  for (const item of items) {
    const payload = (item.payload ?? {}) as Record<string, unknown>;
    const text = String(payload.rawText ?? payload.messageText ?? '');
    const timestamp = String(payload.sourceTimestamp ?? payload.source_timestamp ?? item.created_at ?? '');
    mapped.push({
      kind: 'item',
      id: String(item.id),
      sender: clean(payload.senderName) || clean(payload.senderJid) || 'Unknown',
      chatType: chatType(String(payload.sourceChatJid ?? '')),
      chatJid: String(payload.sourceChatJid ?? ''),
      problem: problemFor(String(payload.classification ?? ''), String(item.category ?? '')),
      reasonCode: String(item.category ?? ''),
      message: text,
      timestamp,
      createdAt: String(item.created_at ?? timestamp),
      fields: fieldsFrom(text, timestamp),
    });
  }
  return mapped.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))).slice(0, limit);
}

function mergeFields(payload: Record<string, unknown>): ReviewFields {
  const fields = (payload.fields ?? {}) as Record<string, unknown>;
  return {
    motherVessel: clean(payload.motherVessel ?? fields.motherVessel),
    lighterVessel: clean(payload.lighterVessel ?? fields.lighterVessel),
    masterMobile: digits(payload.masterMobile ?? fields.masterMobile),
    escortName: clean(payload.escortName ?? fields.escortName),
    escortMobile: digits(payload.escortMobile ?? fields.escortMobile),
    startDate: String(payload.startDate ?? fields.startDate ?? '').slice(0, 10),
    shift: payload.shift === 'D' || payload.shift === 'N' ? payload.shift
      : fields.shift === 'D' || fields.shift === 'N' ? fields.shift : '',
  };
}

async function decideItem(actor: Actor, id: string, decision: string,
  input: {comment?: string; payload?: Record<string, unknown>; workflow?: string}) {
  return tx(async (client) => {
    const found = await client.query<Record<string, unknown>>(
      'SELECT * FROM review_items WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new Error('REVIEW_ITEM_NOT_FOUND');
    const item = found.rows[0];
    if (item.state !== 'PENDING') throw new Error('ITEM_NOT_PENDING');
    const basePayload = (item.payload ?? {}) as Record<string, unknown>;
    const merged = {...basePayload, ...(input.payload ?? {})};
    const fields = mergeFields(merged);
    const text = String(merged.rawText ?? '');
    if (decision === 'APPROVED') {
      if (!fields.motherVessel || !fields.lighterVessel || !fields.masterMobile) {
        const parsed = fieldsFrom(text, String(merged.sourceTimestamp ?? item.created_at ?? ''));
        fields.motherVessel ||= parsed.motherVessel;
        fields.lighterVessel ||= parsed.lighterVessel;
        fields.masterMobile ||= parsed.masterMobile;
        fields.escortName ||= parsed.escortName;
        fields.escortMobile ||= parsed.escortMobile;
        fields.startDate ||= parsed.startDate;
        fields.shift ||= parsed.shift;
      }
      if (!fields.motherVessel || !fields.lighterVessel || !fields.masterMobile) {
        throw new Error('REVIEW_VESSEL_FIELDS_REQUIRED');
      }
      fields.motherVessel = await resolveMotherVesselAlias(fields.motherVessel, client);
      const date = fields.startDate || String(item.created_at ?? '').slice(0, 10);
      const shift = fields.shift || 'D';
      const escortMobile = digits(fields.escortMobile);
      if (escortMobile) {
        await client.query(
          `INSERT INTO employees (employee_mobile, preferred_name, duty_type, designation, created_by)
           VALUES ($1,$2,'escort','escort','system')
           ON CONFLICT (employee_mobile) DO NOTHING`,
          [`+88${escortMobile}`, fields.escortName || `Unknown-${escortMobile.slice(-4)}`],
        );
      }
      const existing = await client.query<Record<string, unknown>>(
        `SELECT * FROM programs
          WHERE state NOT IN ('VOIDED','WITHDRAWN')
            AND (lower(btrim(mother_vessel))=lower(btrim($1))
                 AND lower(btrim(lighter_vessel))=lower(btrim($2))
                 AND start_date=$3::date)
          ORDER BY created_at DESC LIMIT 1 FOR UPDATE`,
        [fields.motherVessel, fields.lighterVessel, date],
      );
      const confirmed = Boolean(fields.escortName && escortMobile);
      const draftText = renderOwnerDraftFields({
        motherVessel: fields.motherVessel, lighterVessel: fields.lighterVessel,
        masterMobile: fields.masterMobile, destination: String(merged.destination ?? '') || null,
        escortName: confirmed ? fields.escortName : null,
        escortMobile: confirmed ? escortMobile : null,
        date, shift,
      });
      let programId: string;
      if (existing.rowCount) {
        programId = String(existing.rows[0].id);
        await client.query(
          `UPDATE programs
              SET mother_vessel=$2, lighter_vessel=$3, master_mobile=$4,
                  escort_name=$5, escort_mobile=$6, start_date=$7, start_shift=$8,
                  state=$9, draft_text=$10, order_key=$11,
                  confirmation_message_id=COALESCE($12,confirmation_message_id),
                  confirmation_chat_jid=COALESCE($13,confirmation_chat_jid),
                  confirmation_sender_jid=COALESCE($14,confirmation_sender_jid),
                  confirmation_account_id=COALESCE($15,confirmation_account_id),
                  confirmation_timestamp=COALESCE($16::timestamptz,confirmation_timestamp),
                  revision=revision+1, updated_at=now()
            WHERE id=$1`,
          [programId, fields.motherVessel, fields.lighterVessel, fields.masterMobile,
            confirmed ? fields.escortName : null, confirmed ? `+88${escortMobile}` : null,
            date, shift, confirmed ? 'CONFIRMED' : 'DRAFT', draftText,
            `${vesselKey(fields.motherVessel)}|${vesselKey(fields.lighterVessel)}`,
            String(merged.sourceMessageId ?? '') || null,
            String(merged.sourceChatJid ?? '') || null,
            String(merged.senderJid ?? '') || null,
            String(merged.sourceAccountId ?? '') || null,
            merged.sourceTimestamp ?? null],
        );
      } else {
        programId = stableId('prog', ['vessel-review', fields.motherVessel, fields.lighterVessel, date, shift]);
        await client.query(
          `INSERT INTO programs
             (id, revision, mother_vessel, lighter_vessel, master_mobile, destination,
              escort_name, escort_mobile, start_date, start_shift, state, source_channel,
              source_type, source_message_id, source_chat_jid, notes, created_by, event_at,
              source_block_key, order_key, draft_text, confirmation_message_id,
              confirmation_chat_jid, confirmation_sender_jid, confirmation_account_id,
              confirmation_timestamp)
           VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'WHATSAPP','WHATSAPP_ORDER',$11,$12,
                   $13,'system',$14,$15,$16,$17,$18,$19,$20,$21,$22::timestamptz)`,
          [programId, fields.motherVessel, fields.lighterVessel, fields.masterMobile,
            String(merged.destination ?? '') || null,
            confirmed ? fields.escortName : null, confirmed ? `+88${escortMobile}` : null,
            date, shift, confirmed ? 'CONFIRMED' : 'DRAFT',
            String(merged.sourceMessageId ?? '') || null, String(merged.sourceChatJid ?? '') || null,
            `Approved from review item ${id}`, merged.sourceTimestamp ?? new Date().toISOString(),
            `review:${id}`, `${vesselKey(fields.motherVessel)}|${vesselKey(fields.lighterVessel)}`,
            draftText, String(merged.sourceMessageId ?? '') || null,
            String(merged.sourceChatJid ?? '') || null, String(merged.senderJid ?? '') || null,
            String(merged.sourceAccountId ?? '') || null, merged.sourceTimestamp ?? null],
        );
      }
      if (confirmed) {
        await client.query(
          `INSERT INTO program_assignments (id, program_id, revision, employee_mobile, start_date, start_shift, source, created_by)
           VALUES ($1,$2,1,$3,$4,$5,'WHATSAPP','system')
           ON CONFLICT (id) DO NOTHING`,
          [stableId('asg', ['vessel-review', programId, escortMobile, date, shift]),
            programId, `+88${escortMobile}`, date, shift],
        );
      }
      await client.query(
        `INSERT INTO program_events (program_id, action, command_key, actor, payload)
         VALUES ($1,'REVIEW_APPROVED',$2,$3,$4::jsonb)`,
        [programId, `review-approve:${id}`, actor.id, JSON.stringify({reviewItemId: id})],
      );
      await client.query(
        `UPDATE review_items SET state='APPROVED', decided_at=now(), updated_at=now(),
                payload=$2::jsonb WHERE id=$1`,
        [id, JSON.stringify(merged)],
      );
      await client.query(
        `INSERT INTO review_decisions (id, item_id, decision, reason, actor)
         VALUES ($1,$2,'APPROVED',$3,$4)
         ON CONFLICT (item_id) DO NOTHING`,
        [stableId('rvd', ['vessel-review', id]), id, input.comment ?? 'VESSEL_REVIEW_APPROVED', actor.id],
      );
      await recordAudit({actor, action: 'VESSEL:REVIEW_APPROVED', entity: 'review_item', entityId: id,
        detail: {programId, fields}}, client);
      return {id, state: 'APPROVED', programId};
    }

    const state = decision === 'SENT_BACK' ? 'SENT_BACK' : decision === 'IGNORED' ? 'IGNORED' : 'REJECTED';
    await client.query(
      `UPDATE review_items SET state=$2, decided_at=now(), updated_at=now(), payload=$3::jsonb WHERE id=$1`,
      [id, state, JSON.stringify(merged)],
    );
    await recordAudit({actor, action: `VESSEL:REVIEW_${state}`, entity: 'review_item', entityId: id,
      detail: {comment: input.comment ?? null}}, client);
    return {id, state};
  });
}

export async function decideVesselReview(actor: Actor, kind: 'message' | 'item', id: string,
  decision: string, input: {comment?: string; payload?: Record<string, unknown>; workflow?: string} = {}) {
  if (kind === 'message') {
    if (decision === 'APPROVED') {
      return approveMessageReviewQueue(actor, id, {comment: input.comment, workflow: input.workflow ?? 'Vessel', payload: input.payload});
    }
    return resolveMessageReviewQueue(actor, id, decision as 'REJECTED' | 'IGNORED' | 'SENT_BACK', input);
  }
  return decideItem(actor, id, decision, input);
}

export async function saveVesselReviewDraft(actor: Actor, kind: 'message' | 'item', id: string,
  payload: Record<string, unknown>, comment?: string) {
  if (kind === 'message') {
    const updated = await row<{id: string}>(
      `UPDATE message_review_queue
          SET resolved_payload = coalesce(resolved_payload, '{}'::jsonb) || $2::jsonb,
              admin_comment = coalesce($3, admin_comment)
        WHERE id=$1 AND status='PENDING'
        RETURNING id::text`,
      [id, JSON.stringify(payload), comment ?? null],
    );
    if (!updated) throw new Error('REVIEW_ITEM_NOT_FOUND');
    await recordAudit({actor, action: 'VESSEL:REVIEW_DRAFT_SAVED', entity: 'message_review_queue',
      entityId: id, detail: {payload}});
    return {id, status: 'PENDING'};
  }
  return correctReviewItem(actor, id, payload);
}
