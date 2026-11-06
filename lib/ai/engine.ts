// WA-02 AI communication engine. Deterministic policy and grounded tools only.
//
// The engine never executes SQL supplied by a message. It classifies intent,
// resolves the contact from explicit WA-02 records, calls a narrow tool and
// writes an outbound DRAFT. It does not send messages, create Vessel Programs,
// post Cash, or expose records across conversations.

import {recordAudit} from '../standalone/audit.ts';
import {assertCapability} from '../standalone/authz.ts';
import type {Actor} from '../standalone/db.ts';
import {row} from '../standalone/db.ts';
import {
  adminHelpReply, classifyIntent, employeeHelpReply, extractApplicant, extractOrderFields,
  jidFromPhone, missingOrderFields, normalizePhone, publicJobMessage, safePublicReply,
  type AiCategory, type AiIntent,
} from './policy.ts';
import {
  appendAiMessage, ensureConversation, escalate, getJobCatalog, logToolRun, resolveContact,
} from './store.ts';
import {
  applicantDraftTool, cashSummaryTool, employeeFinancialsTool, employeeProfileTool,
  messageDraftTool, orderDraftTool, searchEmployeesTool, sourceConversationTool,
  vesselLookupTool, type AiContext,
} from './tools.ts';

const SYSTEM: Actor = {id: 'system:wa02-ai', role: 'ADMIN'};

function money(minor: string | number | null | undefined): string {
  if (minor === null || minor === undefined) return '—';
  return `BDT ${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
}

function compactEmployee(result: unknown): string {
  if (!result || typeof result !== 'object') return 'No matching employee record.';
  const data = result as {employee?: Record<string, unknown>};
  if (!data.employee) return 'No matching employee record.';
  const e = data.employee;
  return `Employee: ${String(e.preferred_name ?? '—')} · ${String(e.employee_mobile ?? '—')} · ${String(e.state ?? '—')}`;
}

function employeeAnswer(profile: unknown, financials: unknown, vessels: unknown): string {
  const p = profile as {employee?: Record<string, unknown>} | null;
  const f = financials as {data?: {pay?: Array<Record<string, unknown>>; instructions?: Array<Record<string, unknown>>}; pay?: Array<Record<string, unknown>>; instructions?: Array<Record<string, unknown>>} | null;
  const v = vessels as Array<Record<string, unknown>> | null;
  const employee = p?.employee;
  if (!employee) return employeeHelpReply();
  const pay = f?.data?.pay ?? f?.pay ?? [];
  const payments = f?.data?.instructions ?? f?.instructions ?? [];
  const active = (v ?? []).filter((program) => !['VOIDED', 'COMPLETED'].includes(String(program.state)));
  const payable = pay.reduce((total, entry) => total + Number(entry.total_minor ?? 0), 0);
  const paid = payments.filter((entry) => entry.state === 'POSTED').reduce((total, entry) => total + Number(entry.amount_minor ?? 0), 0);
  const lines = [
    `Assalamu alaikum ${String(employee.preferred_name ?? '')}.`,
    `Employee: ${String(employee.preferred_name ?? '—')} (${String(employee.employee_mobile ?? '—')})`,
    active.length
      ? `Current duty: ${active.map((program) => `${String(program.lighter_vessel ?? '—')} / ${String(program.mother_vessel ?? '—')} · ${String(program.state ?? '—')}`).join('; ')}`
      : 'Current duty: no active assignment is recorded.',
    `Recorded program pay: ${money(payable)}. Recorded posted payments: ${money(paid)}.`,
    'Advances, food and transport entries are shown only where the office has recorded them; missing entries are not invented.',
  ];
  return lines.join('\n');
}

async function callTool(ctx: AiContext, tool: string, input: Record<string, unknown>, fn: () => Promise<{allowed: boolean; data: unknown; error: string | null}>) {
  let result: {allowed: boolean; data: unknown; error: string | null};
  try {
    result = await fn();
  } catch (error) {
    result = {allowed: false, data: null, error: error instanceof Error ? error.message : 'TOOL_FAILED'};
  }
  await logToolRun({
    conversationId: ctx.conversationId,
    actorRef: ctx.actorRef,
    accountId: ctx.accountId,
    tool,
    allowed: result.allowed,
    input,
    output: result.allowed ? {result: result.data} : {error: result.error},
    error: result.error,
  });
  return result;
}

async function adminAnswer(ctx: AiContext, text: string) {
  const value = text.trim();
  const lower = value.toLowerCase();
  const date = /20\d{2}-\d{2}-\d{2}/.exec(value)?.[0] ?? new Date().toISOString().slice(0, 10);
  if (/(^|\s)(cash|transaction|income|expense|লেনদেন|হিসাব)/i.test(lower)) {
    const result = await callTool(ctx, 'cash_summary', {from: date, to: date}, () => cashSummaryTool(ctx, date, date));
    if (!result.allowed) return {answer: safePublicReply(), tool: 'cash_summary', data: null};
    const data = result.data as {report: {income: number; expense: number; reversals: number; net: number}; pending: unknown[]; posted: unknown[]};
    return {
      answer: `Cash ${date}: income ${money(data.report.income)}, expense ${money(data.report.expense)}, reversals ${money(data.report.reversals)}, net ${money(data.report.net)}. Pending REVIEW instructions: ${data.pending.length}; POSTED instructions: ${data.posted.length}.`,
      tool: 'cash_summary', data,
    };
  }
  if (/(vessel|lighter|mother|জাহাজ|লাইটার|মাদার)/i.test(lower)) {
    const q = value.replace(/^.*?(?:vessel|lighter|mother|জাহাজ|লাইটার|মাদার)\s*/i, '').trim();
    const result = await callTool(ctx, 'vessel_lookup', {query: q}, () => vesselLookupTool(ctx, q));
    if (!result.allowed) return {answer: safePublicReply(), tool: 'vessel_lookup', data: null};
    const rows = result.data as Array<Record<string, unknown>>;
    return {
      answer: rows.length
        ? rows.map((program) => `${String(program.lighter_vessel ?? '—')} under ${String(program.mother_vessel ?? '—')} · escort ${String(program.escort_name ?? '—')} · ${String(program.state ?? '—')} · start ${String(program.start_date ?? '—')}`).join('\n')
        : 'No matching vessel duty is recorded.',
      tool: 'vessel_lookup', data: rows,
    };
  }
  if (/(employee|কর্মী|staff)/i.test(lower)) {
    const phone = normalizePhone(value);
    const q = value.replace(/^.*?(?:employee|কর্মী|staff)\s*/i, '').trim();
    if (phone) {
      const result = await callTool(ctx, 'employee_profile', {employeeMobile: phone}, () => employeeProfileTool(ctx, phone));
      return {answer: compactEmployee(result.data), tool: 'employee_profile', data: result.data};
    }
    const result = await callTool(ctx, 'employee_search', {q}, () => searchEmployeesTool(ctx, q));
    const rows = (result.data ?? []) as Array<Record<string, unknown>>;
    return {
      answer: result.allowed
        ? (rows.length ? rows.map((employee) => `${String(employee.preferred_name ?? '—')} · ${String(employee.employee_mobile ?? '—')} · ${String(employee.state ?? '—')}`).join('\n') : 'No matching employee record.')
        : safePublicReply(),
      tool: 'employee_search', data: rows,
    };
  }
  if (/(draft message|message draft|খসড়া)/i.test(lower)) {
    const phone = normalizePhone(value);
    const recipient = jidFromPhone(value);
    const content = value.split(/[:]/).slice(1).join(':').trim();
    if (!phone || !recipient || !content) return {answer: 'Use: draft message to 01XXXXXXXXX: message text', tool: 'message_draft', data: null};
    const result = await callTool(ctx, 'message_draft', {recipientJid: recipient, content}, () => messageDraftTool(ctx, {recipientJid: recipient, content}));
    return {answer: result.allowed ? 'Message draft created. It is not sent; approval and a configured sender are required.' : safePublicReply(), tool: 'message_draft', data: result.data};
  }
  if (/(source|conversation|message)/i.test(lower)) {
    const result = await callTool(ctx, 'source_conversation', {query: value}, () => sourceConversationTool(ctx, value));
    return {answer: result.allowed ? `Found ${(result.data as unknown[])?.length ?? 0} matching source message(s).` : safePublicReply(), tool: 'source_conversation', data: result.data};
  }
  return {answer: adminHelpReply(), tool: 'admin_help', data: null};
}

export type Wa02ProcessResult = {
  conversationId: string;
  category: AiCategory;
  intent: AiIntent;
  response: string;
  outboundDraftId: string | null;
  escalationId: string | null;
  duplicate: boolean;
  tool: string | null;
};

export async function processWa02Message(input: {
  messageId: string;
  chatJid: string;
  senderJid: string | null;
  text: string;
  direction?: 'INCOMING' | 'OUTGOING';
}): Promise<Wa02ProcessResult> {
  if (!input.messageId || !input.chatJid) throw new Error('WA02_MESSAGE_REQUIRED');
  const source = await row<{id: string; account_id: string; direction: string}>(
    `SELECT id, account_id, direction FROM whatsapp_messages WHERE message_id = $1 AND chat_jid = $2 LIMIT 1`,
    [input.messageId, input.chatJid],
  );
  if (!source || source.account_id !== 'wa-02') throw new Error('WA02_SOURCE_REQUIRED');
  const existing = await row<{id: string; conversation_id: string}>(
    `SELECT id, conversation_id FROM ai_messages WHERE account_id = 'wa-02' AND source_message_id = $1`,
    [input.messageId],
  );
  if (existing) {
    return {
      conversationId: existing.conversation_id, category: 'UNKNOWN_CONTACT', intent: 'UNKNOWN',
      response: 'Already processed.', outboundDraftId: null, escalationId: null, duplicate: true, tool: null,
    };
  }
  const text = String(input.text ?? '').slice(0, 8000);
  const contact = await resolveContact('wa-02', input.chatJid, input.senderJid);
  const conversation = await ensureConversation({
    accountId: 'wa-02', chatJid: input.chatJid, contactJid: input.senderJid ?? input.chatJid,
    category: contact.category, employeeMobile: contact.employeeMobile,
  });
  const intent = classifyIntent(text);
  await appendAiMessage({
    conversationId: conversation.id, accountId: 'wa-02', chatJid: input.chatJid,
    sourceMessageId: input.messageId, direction: input.direction ?? 'INCOMING',
    senderJid: input.senderJid, content: text, role: 'CONTACT', intent,
  });

  const ctx: AiContext = {
    accountId: 'wa-02', chatJid: input.chatJid, senderJid: input.senderJid,
    category: contact.category, employeeMobile: contact.employeeMobile,
    actorRef: SYSTEM.id, conversationId: conversation.id, actor: SYSTEM,
  };

  let response = safePublicReply();
  let outboundDraftId: string | null = null;
  let escalationId: string | null = null;
  let tool: string | null = null;

  if (intent === 'PROMPT_INJECTION') {
    escalationId = (await escalate({
      conversationId: conversation.id, reason: 'PROMPT_INJECTION_ATTEMPT',
      details: {messageId: input.messageId, category: contact.category}, actor: SYSTEM,
    })).id;
  } else if (contact.category === 'VERIFIED_ADMIN') {
    const result = await adminAnswer(ctx, text);
    response = result.answer;
    tool = result.tool;
  } else if (contact.category === 'VERIFIED_EMPLOYEE' && contact.employeeMobile) {
    const [profile, financials, vessels] = await Promise.all([
      callTool(ctx, 'employee_profile', {employeeMobile: contact.employeeMobile}, () => employeeProfileTool(ctx, contact.employeeMobile as string)),
      callTool(ctx, 'employee_financials', {employeeMobile: contact.employeeMobile}, () => employeeFinancialsTool(ctx, contact.employeeMobile as string)),
      callTool(ctx, 'vessel_lookup', {query: ''}, () => vesselLookupTool(ctx, '')),
    ]);
    response = employeeAnswer(profile.data, financials.data, vessels.data as Array<Record<string, unknown>>);
    tool = 'employee_support';
  } else if (contact.category === 'JOB_APPLICANT' || contact.category === 'UNKNOWN_CONTACT') {
    const jobs = await getJobCatalog();
    const fields = extractApplicant(text);
    if (intent === 'RECRUITMENT' || contact.category === 'JOB_APPLICANT') {
      const draft = await applicantDraftTool(ctx, {...fields, rawText: text});
      response = publicJobMessage(jobs);
      if (fields.phone || fields.fullName || fields.jobCategory) {
        response += '\n\nআপনার তথ্য applicant draft-এ সংরক্ষণ করা হয়েছে; অফিস যাচাই করে যোগাযোগ করবে। / Your details are recorded as an applicant draft; the office will verify them.';
      } else {
        response += '\n\nঅনুগ্রহ করে নাম, মোবাইল নম্বর ও আগ্রহের পদ লিখুন। / Please provide your name, mobile number and preferred role.';
      }
      tool = 'applicant_draft';
      escalationId = (await escalate({
        conversationId: conversation.id, reason: 'APPLICANT_DRAFT_REVIEW_REQUIRED',
        details: {draftId: (draft.data as {id?: string})?.id, fields}, actor: SYSTEM,
      })).id;
    } else {
      response = 'আসসালামু আলাইকুম। AL-RIFA\'I recruitment, employee support ও office information-এর জন্য যোগাযোগ করুন। / Please tell us how we can help with recruitment or general company information.';
    }
  } else if (contact.category === 'ESCORT_CLIENT') {
    const fields = extractOrderFields(text);
    const missing = missingOrderFields(fields);
    if (missing.length) {
      response = `Order draft-এর জন্য প্রয়োজন: ${missing.join(', ')}. / Please provide: ${missing.join(', ')}.`;
      tool = 'order_draft_incomplete';
    } else {
      const draft = await orderDraftTool(ctx, {...fields, sourceMessageId: input.messageId, rawText: text});
      response = 'আপনার Vessel Order Draft তৈরি হয়েছে। এটি confirmed program নয়; Admin review/confirmation ছাড়া operational নয়। / Your draft is created; it is not a confirmed program until Admin review.';
      tool = 'order_draft';
      escalationId = (await escalate({
        conversationId: conversation.id, reason: 'WA02_ORDER_DRAFT_ADMIN_NOTIFICATION',
        details: {draftId: (draft.data as {id?: string})?.id, sourceMessageId: input.messageId}, actor: SYSTEM,
      })).id;
    }
  } else if (contact.category === 'UNAUTHORIZED') {
    response = safePublicReply();
    escalationId = (await escalate({
      conversationId: conversation.id, reason: 'UNAUTHORIZED_CONTACT', details: {messageId: input.messageId}, actor: SYSTEM,
    })).id;
  }

  const {createOutboundDraft} = await import('./store.ts');
  await appendAiMessage({
    conversationId: conversation.id, accountId: 'wa-02', chatJid: input.chatJid,
    sourceMessageId: null, direction: 'OUTGOING', senderJid: null, content: response,
    role: 'ASSISTANT', intent, classification: 'DRAFT_ONLY',
  });
  const outbound = await createOutboundDraft({
    conversationId: conversation.id, accountId: 'wa-02', chatJid: input.chatJid,
    recipientJid: input.senderJid ?? input.chatJid, content: response, sourceRef: input.messageId,
  });
  outboundDraftId = (outbound as {id?: string})?.id ?? null;
  await recordAudit({
    actor: SYSTEM, action: 'AI_WA02_MESSAGE_PROCESSED', entity: 'ai_conversation', entityId: conversation.id,
    detail: {category: contact.category, intent, tool, outboundDraftId, escalationId},
    source: 'WHATSAPP', sourceRef: input.messageId,
  });
  return {conversationId: conversation.id, category: contact.category, intent, response, outboundDraftId, escalationId, duplicate: false, tool};
}

export async function runAdminQuery(actor: Actor, query: string) {
  assertCapability(actor, 'ai.use');
  if (actor.role !== 'ADMIN') throw new Error('ADMIN_REQUIRED');
  const conversationId = '';
  const ctx: AiContext = {
    accountId: 'wa-02', chatJid: 'admin-assistant', senderJid: null, category: 'VERIFIED_ADMIN',
    employeeMobile: null, actorRef: actor.id, conversationId, actor,
  };
  const result = await adminAnswer(ctx, query);
  await recordAudit({actor, action: 'AI_ADMIN_QUERY', entity: 'ai_assistant', entityId: conversationId,
    detail: {tool: result.tool}});
  return result;
}
