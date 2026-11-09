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
