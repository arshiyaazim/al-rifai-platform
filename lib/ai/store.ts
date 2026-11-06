import {row, rows, tx, type Actor} from '../standalone/db.ts';
import {newId, stableId} from '../standalone/audit.ts';
import {assertCapability} from '../standalone/authz.ts';
import {recordAudit} from '../standalone/audit.ts';
import {jidsMatch} from '../whatsapp-identity.mjs';
import type {AiCategory, AiIntent} from './policy.ts';

export type AiContact = {
  category: AiCategory;
  employeeMobile: string | null;
  personRef: string | null;
  verificationRef: string | null;
};

export type AiConversation = {
  id: string;
  account_id: string;
  chat_jid: string;
  contact_jid: string | null;
  category: AiCategory;
  employee_mobile: string | null;
  state: string;
  summary: string | null;
  last_intent: string | null;
};

export async function resolveContact(accountId: string, chatJid: string, senderJid: string | null): Promise<AiContact> {
  if (accountId !== 'wa-02') {
    return {category: 'UNAUTHORIZED', employeeMobile: null, personRef: null, verificationRef: null};
  }
  const contacts = await rows<{
    chat_jid: string;
    person_ref: string | null;
    category: AiCategory;
    employee_mobile: string | null;
    verified_by: string | null;
  }>(
    `SELECT chat_jid, person_ref, category, employee_mobile, verified_by
       FROM ai_contacts WHERE account_id = $1 AND active = true
      ORDER BY updated_at DESC`,
    [accountId],
  );
  const matched = contacts.find((contact) => jidsMatch(contact.chat_jid, chatJid) || jidsMatch(contact.chat_jid, senderJid));
  if (matched) {
    return {
      category: matched.category,
      employeeMobile: matched.employee_mobile,
      personRef: matched.person_ref,
      verificationRef: matched.verified_by,
    };
  }
  const admins = await rows<{jid: string; verified_by: string | null}>(
    `SELECT jid, verified_by FROM ai_admin_jids WHERE account_id = $1 AND active = true`,
    [accountId],
  );
  const admin = admins.find((entry) => jidsMatch(entry.jid, senderJid) || jidsMatch(entry.jid, chatJid));
  if (admin) {
    return {category: 'VERIFIED_ADMIN', employeeMobile: null, personRef: null, verificationRef: admin.verified_by};
  }
  return {category: 'UNKNOWN_CONTACT', employeeMobile: null, personRef: null, verificationRef: null};
}

export async function ensureConversation(input: {
  accountId: string; chatJid: string; contactJid: string | null; category: AiCategory; employeeMobile: string | null;
}): Promise<AiConversation> {
  const id = stableId('aic', [input.accountId, input.chatJid]);
  const created = await row<AiConversation>(
    `INSERT INTO ai_conversations (id, account_id, chat_jid, contact_jid, category, employee_mobile, last_message_at)
     VALUES ($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (account_id, chat_jid) DO UPDATE
       SET contact_jid = EXCLUDED.contact_jid,
           category = EXCLUDED.category,
           employee_mobile = EXCLUDED.employee_mobile,
           last_message_at = now(),
           updated_at = now()
     RETURNING *`,
    [id, input.accountId, input.chatJid, input.contactJid, input.category, input.employeeMobile],
  );
  if (!created) throw new Error('AI_CONVERSATION_WRITE_FAILED');
  return created;
}

export async function appendAiMessage(input: {
  conversationId: string;
  accountId: string;
  chatJid: string;
  sourceMessageId: string | null;
  direction: 'INCOMING' | 'OUTGOING';
  senderJid: string | null;
  content: string;
  role: 'CONTACT' | 'ASSISTANT' | 'SYSTEM';
  intent?: AiIntent | null;
  classification?: string | null;
}) {
  const id = input.sourceMessageId ? stableId('aim', ['source', input.accountId, input.sourceMessageId]) : newId('aim');
  return row(
    `INSERT INTO ai_messages
       (id, conversation_id, account_id, chat_jid, source_message_id, direction, sender_jid, content, role, intent, classification)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (account_id, source_message_id) DO NOTHING
     RETURNING *`,
    [id, input.conversationId, input.accountId, input.chatJid, input.sourceMessageId, input.direction,
      input.senderJid, input.content.slice(0, 8000), input.role, input.intent ?? null, input.classification ?? null],
  );
}

export async function logToolRun(input: {
  conversationId: string | null;
  actorRef: string | null;
  accountId: string;
  tool: string;
  allowed: boolean;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  error?: string | null;
}) {
  await row(
    `INSERT INTO ai_tool_runs (id, conversation_id, actor_ref, account_id, tool, allowed, input, output, error)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9)`,
    [newId('ait'), input.conversationId || null, input.actorRef, input.accountId, input.tool, input.allowed,
      JSON.stringify(input.input), JSON.stringify(input.output), input.error ?? null],
  );
}

export async function escalate(input: {
  conversationId: string | null;
  reason: string;
  details?: Record<string, unknown>;
  actor?: Actor | null;
}) {
  const id = newId('aie');
  await row(
    `INSERT INTO ai_escalations (id, conversation_id, reason, details)
     VALUES ($1,$2,$3,$4::jsonb)`,
    [id, input.conversationId, input.reason.slice(0, 500), JSON.stringify(input.details ?? {})],
  );
  if (input.actor) {
    await recordAudit({
      actor: input.actor,
      action: 'AI_ESCALATION_CREATED',
      entity: 'ai_escalation',
      entityId: id,
      detail: {reason: input.reason, ...input.details},
    });
  }
  return {id, reason: input.reason};
}

export async function getJobCatalog() {
  return rows<{key: string; label_bn: string; label_en: string; public_description: string}>(
    `SELECT key, label_bn, label_en, public_description FROM ai_job_catalog
      WHERE active = true ORDER BY display_order, key`,
  );
}

export async function createApplicantDraft(input: {
  conversationId: string;
  accountId: string;
  chatJid: string;
  fullName: string | null;
  phone: string | null;
  jobCategory: string | null;
  payload: Record<string, unknown>;
}) {
  const dedupe = stableId('aiad', [input.accountId, input.chatJid, input.phone ?? '', input.fullName ?? '', input.jobCategory ?? '']);
  return row(
    `INSERT INTO ai_applicant_drafts
       (id, conversation_id, account_id, chat_jid, full_name, phone, job_category, payload, dedupe_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)
     ON CONFLICT (dedupe_hash) DO UPDATE
       SET full_name = COALESCE(EXCLUDED.full_name, ai_applicant_drafts.full_name),
           phone = COALESCE(EXCLUDED.phone, ai_applicant_drafts.phone),
           job_category = COALESCE(EXCLUDED.job_category, ai_applicant_drafts.job_category),
           payload = ai_applicant_drafts.payload || EXCLUDED.payload,
           updated_at = now()
     RETURNING *`,
    [newId('aia'), input.conversationId, input.accountId, input.chatJid, input.fullName, input.phone,
      input.jobCategory, JSON.stringify(input.payload), dedupe],
  );
}

export async function createOrderDraft(input: {
  conversationId: string;
  accountId: string;
  chatJid: string;
  motherVessel: string | null;
  lighterVessel: string | null;
  masterMobile: string | null;
  destination: string | null;
  startDate: string | null;
  startShift: 'D' | 'N' | null;
  payload: Record<string, unknown>;
  sourceMessageId: string | null;
}) {
  const dedupe = stableId('aiod', [input.accountId, input.chatJid, input.sourceMessageId ?? '', input.motherVessel ?? '', input.lighterVessel ?? '', input.startDate ?? '']);
  return row(
    `INSERT INTO ai_order_drafts
       (id, conversation_id, account_id, chat_jid, mother_vessel, lighter_vessel, master_mobile,
        destination, start_date, start_shift, payload, dedupe_hash, source_message_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
     ON CONFLICT (dedupe_hash) DO UPDATE
       SET mother_vessel = COALESCE(EXCLUDED.mother_vessel, ai_order_drafts.mother_vessel),
           lighter_vessel = COALESCE(EXCLUDED.lighter_vessel, ai_order_drafts.lighter_vessel),
           master_mobile = COALESCE(EXCLUDED.master_mobile, ai_order_drafts.master_mobile),
           destination = COALESCE(EXCLUDED.destination, ai_order_drafts.destination),
           start_date = COALESCE(EXCLUDED.start_date, ai_order_drafts.start_date),
           start_shift = COALESCE(EXCLUDED.start_shift, ai_order_drafts.start_shift),
           payload = ai_order_drafts.payload || EXCLUDED.payload,
           updated_at = now()
     RETURNING *`,
    [newId('aio'), input.conversationId, input.accountId, input.chatJid, input.motherVessel, input.lighterVessel,
      input.masterMobile, input.destination, input.startDate, input.startShift, JSON.stringify(input.payload),
      dedupe, input.sourceMessageId],
  );
}

export async function createOutboundDraft(input: {
  conversationId: string | null;
  accountId: string;
  chatJid: string;
  recipientJid: string;
  content: string;
  sourceRef?: string | null;
}) {
  return row(
    `INSERT INTO ai_outbound_messages
       (id, conversation_id, account_id, chat_jid, recipient_jid, content, state, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6,'DRAFT',$7) RETURNING *`,
    [newId('aio'), input.conversationId, input.accountId, input.chatJid, input.recipientJid,
      input.content.slice(0, 4000), input.sourceRef ?? null],
  );
}

export async function approveOutbound(actor: Actor, id: string) {
  assertCapability(actor, 'ai.send');
  if (actor.role !== 'ADMIN') throw new Error('ADMIN_REQUIRED');
  return tx(async (client) => {
    const found = await client.query<{state: string; content: string}>(
      'SELECT state, content FROM ai_outbound_messages WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new Error('AI_DRAFT_NOT_FOUND');
    if (!['DRAFT', 'PREVIEW'].includes(found.rows[0].state)) throw new Error('AI_DRAFT_NOT_PENDING');
    await client.query(
      `UPDATE ai_outbound_messages SET state='APPROVED', approval_by=$2, approved_at=now(), updated_at=now() WHERE id=$1`,
      [id, actor.id],
    );
    await recordAudit({actor, action: 'AI_OUTBOUND_APPROVED', entity: 'ai_outbound', entityId: id,
      detail: {preview: found.rows[0].content.slice(0, 160)}}, client);
    return {id, state: 'APPROVED', sent: false};
  });
}

/**
 * Sending is deliberately not implemented in this release. The queue can be
 * approved, but no bridge send adapter exists and AI_OUTBOUND_ENABLED is off by
 * default. This prevents a draft from being reported as delivered.
 */
export async function sendOutbound(actor: Actor, id: string) {
  assertCapability(actor, 'ai.send');
  if (process.env.AI_OUTBOUND_ENABLED !== '1') throw new Error('AI_OUTBOUND_DISABLED');
  const found = await row<{state: string}>('SELECT state FROM ai_outbound_messages WHERE id = $1', [id]);
  if (!found) throw new Error('AI_DRAFT_NOT_FOUND');
  if (found.state !== 'APPROVED') throw new Error('AI_DRAFT_NOT_APPROVED');
  throw new Error('AI_SENDER_NOT_CONFIGURED');
}

export async function getOutbound(id: string) {
  return row('SELECT * FROM ai_outbound_messages WHERE id = $1', [id]);
}

export async function listOutbound(limit = 50) {
  return rows(
    `SELECT id, conversation_id, account_id, chat_jid, recipient_jid, state, source_ref,
            approval_by, approved_at, sent_at, delivery_state, error, created_at
       FROM ai_outbound_messages ORDER BY created_at DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 50, 1), 200)],
  );
}
