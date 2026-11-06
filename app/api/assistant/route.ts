import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {row, rows, mobile, text} from '@/lib/standalone/db';
import {jidFromPhone} from '@/lib/ai/policy';
import {recordAudit} from '@/lib/standalone/audit';
import {runAdminQuery} from '@/lib/ai/engine';
import {approveOutbound, createOutboundDraft, getOutbound, listOutbound, sendOutbound} from '@/lib/ai/store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'ai.read');
    const [conversations, applicants, outbound, escalations, orders] = await Promise.all([
      row<{n: string}>('SELECT count(*)::text AS n FROM ai_conversations'),
      row<{n: string}>('SELECT count(*)::text AS n FROM ai_applicant_drafts'),
      row<{n: string}>('SELECT count(*)::text AS n FROM ai_outbound_messages'),
      row<{n: string}>('SELECT count(*)::text AS n FROM ai_escalations WHERE status = \'OPEN\''),
      row<{n: string}>('SELECT count(*)::text AS n FROM ai_order_drafts'),
    ]);
    return ok({
      status: 'ok',
      wa02Worker: process.env.AI_WA02_ENABLED === '1',
      outboundEnabled: process.env.AI_OUTBOUND_ENABLED === '1',
      conversations: Number(conversations?.n ?? 0),
      applicants: Number(applicants?.n ?? 0),
      outbound: Number(outbound?.n ?? 0),
      openEscalations: Number(escalations?.n ?? 0),
      orderDrafts: Number(orders?.n ?? 0),
      role: actor.role,
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    const action = String(body.action ?? '');

    if (action === 'query') {
      assertCapability(actor as never, 'ai.use');
      return ok(await runAdminQuery(actor as never, String(body.query ?? '')));
    }

    if (action === 'draft.create') {
      assertCapability(actor as never, 'ai.use');
      if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
      const phone = mobile(body.recipientJid, 'recipientJid');
      const recipient = jidFromPhone(phone);
      if (!recipient) return ok({error: 'INVALID_RECIPIENT'}, 400);
      const content = text(body.content, 'content', {max: 4000});
      const draft = await createOutboundDraft({
        conversationId: null,
        accountId: 'wa-02',
        chatJid: recipient,
        recipientJid: recipient,
        content,
        sourceRef: body.sourceRef ? String(body.sourceRef).slice(0, 500) : null,
      });
      await recordAudit({actor: actor as never, action: 'AI_DRAFT_CREATED', entity: 'ai_outbound',
        entityId: String((draft as {id?: string})?.id), detail: {recipient, sourceRef: body.sourceRef ?? null}});
      return ok(draft, 201);
    }

    if (action === 'draft.preview') {
      assertCapability(actor as never, 'ai.use');
      if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
      const draft = await getOutbound(String(body.id ?? ''));
      if (!draft) return ok({error: 'AI_DRAFT_NOT_FOUND'}, 404);
      await row("UPDATE ai_outbound_messages SET state='PREVIEW', updated_at=now() WHERE id=$1 AND state='DRAFT'", [String(body.id)]);
      return ok({...draft, state: 'PREVIEW', sent: false});
    }

    if (action === 'draft.forward') {
      assertCapability(actor as never, 'ai.use');
      if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
      const sourceMessageId = String(body.sourceMessageId ?? '');
      const source = await row<{text_content: string | null; account_id: string; chat_jid: string}>(
        'SELECT text_content, account_id, chat_jid FROM whatsapp_messages WHERE message_id=$1 LIMIT 1', [sourceMessageId],
      );
      if (!source) return ok({error: 'SOURCE_MESSAGE_NOT_FOUND'}, 404);
      const phone = mobile(body.recipientJid, 'recipientJid');
      const recipient = jidFromPhone(phone);
      if (!recipient) return ok({error: 'INVALID_RECIPIENT'}, 400);
      const draft = await createOutboundDraft({
        conversationId: null, accountId: 'wa-02', chatJid: recipient, recipientJid: recipient,
        content: String(body.content ?? source.text_content ?? '').slice(0, 4000),
        sourceRef: sourceMessageId,
      });
      await recordAudit({actor: actor as never, action: 'AI_FORWARD_DRAFT_CREATED', entity: 'ai_outbound',
        entityId: String((draft as {id?: string})?.id), detail: {sourceMessageId, recipient}});
      return ok(draft, 201);
    }

    if (action === 'draft.approve') {
      assertCapability(actor as never, 'ai.send');
      return ok(await approveOutbound(actor as never, String(body.id ?? '')));
    }

    if (action === 'draft.send') {
      assertCapability(actor as never, 'ai.send');
      return ok(await sendOutbound(actor as never, String(body.id ?? '')));
    }

    if (action === 'draft.status') {
      assertCapability(actor as never, 'ai.read');
      return ok(await getOutbound(String(body.id ?? '')));
    }

    if (action === 'draft.list') {
      assertCapability(actor as never, 'ai.read');
      return ok({rows: await listOutbound(Number(body.limit) || 50)});
    }

    if (action === 'applicant.list') {
      assertCapability(actor as never, 'ai.admin');
      return ok({rows: await rows(
        `SELECT id, conversation_id, chat_jid, full_name, phone, job_category, status, created_at, updated_at
           FROM ai_applicant_drafts ORDER BY created_at DESC LIMIT 100`,
      )});
    }

    if (action === 'applicant.decide') {
      assertCapability(actor as never, 'ai.admin');
      if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
      const decision = body.decision === 'REJECTED' ? 'REJECTED' : body.decision === 'APPROVED' ? 'APPROVED' : 'REVIEW';
      const id = String(body.id ?? '');
      await row('UPDATE ai_applicant_drafts SET status=$2, updated_at=now() WHERE id=$1', [id, decision]);
      await recordAudit({actor: actor as never, action: `AI_APPLICANT_${decision}`, entity: 'ai_applicant',
        entityId: id, detail: {reason: body.reason ?? null}});
      return ok({id, status: decision});
    }

    if (action === 'order.list') {
      assertCapability(actor as never, 'ai.admin');
      return ok({rows: await rows(
        `SELECT id, conversation_id, chat_jid, mother_vessel, lighter_vessel, master_mobile, destination,
                start_date, start_shift, status, source_message_id, created_at
           FROM ai_order_drafts ORDER BY created_at DESC LIMIT 100`,
      )});
    }

    if (action === 'escalation.list') {
      assertCapability(actor as never, 'ai.admin');
      return ok({rows: await rows(
        `SELECT id, conversation_id, reason, status, created_at FROM ai_escalations ORDER BY created_at DESC LIMIT 100`,
      )});
    }

    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
