import {rows, type Actor} from '../standalone/db.ts';
import {listEmployees, getEmployee} from '../standalone/employees.ts';
import {programsLookup} from './vessel.ts';
import {listInstructions, listLedger, incomeExpense} from '../standalone/finance.ts';
import {listAudit} from '../standalone/audit.ts';
import {canAccessEmployee, canUseAdminTools, type AiCategory} from './policy.ts';
import {createApplicantDraft, createOrderDraft, createOutboundDraft, escalate} from './store.ts';

export type AiContext = {
  accountId: string;
  chatJid: string;
  senderJid: string | null;
  category: AiCategory;
  employeeMobile: string | null;
  actorRef: string;
  conversationId: string;
  actor?: Actor;
};

function denied(tool: string, reason: string) {
  return {allowed: false, tool, error: reason, data: null};
}

export async function searchEmployeesTool(ctx: AiContext, query: string) {
  if (!canUseAdminTools(ctx.category) && ctx.category !== 'VERIFIED_EMPLOYEE') {
    return denied('employee_search', 'PRIVATE_DATA_NOT_AUTHORIZED');
  }
  const q = String(query ?? '').trim().slice(0, 100);
  if (ctx.category === 'VERIFIED_EMPLOYEE' && ctx.employeeMobile) {
    const employee = await getEmployee(ctx.employeeMobile).catch(() => null);
    return {allowed: true, tool: 'employee_search', data: employee ? [employee.employee] : [], error: null};
  }
  return {allowed: true, tool: 'employee_search', data: await listEmployees({q, limit: 20}), error: null};
}

export async function employeeProfileTool(ctx: AiContext, employeeMobile: string) {
  if (!canAccessEmployee(ctx.category, ctx.employeeMobile, employeeMobile)) {
    return denied('employee_profile', 'EMPLOYEE_RECORD_NOT_AUTHORIZED');
  }
  try {
    return {allowed: true, tool: 'employee_profile', data: await getEmployee(employeeMobile), error: null};
  } catch {
    return {allowed: true, tool: 'employee_profile', data: null, error: 'EMPLOYEE_NOT_FOUND'};
  }
}

export async function employeeFinancialsTool(ctx: AiContext, employeeMobile: string) {
  if (!canAccessEmployee(ctx.category, ctx.employeeMobile, employeeMobile)) {
    return denied('employee_financials', 'EMPLOYEE_RECORD_NOT_AUTHORIZED');
  }
  const [pay, instructions] = await Promise.all([
    rows(
      `SELECT p.id, p.mother_vessel, p.lighter_vessel, pp.state, pp.shifts,
              pp.salary_minor::text, pp.conveyance_minor::text, pp.total_minor::text
         FROM programs p JOIN program_pay pp ON pp.program_id = p.id
        WHERE p.escort_mobile = $1 ORDER BY p.start_date DESC LIMIT 30`,
      [employeeMobile],
    ),
    rows(
      `SELECT id, state, amount_minor::text, method, purpose, created_at
         FROM cash_instructions WHERE employee_mobile = $1
        ORDER BY created_at DESC LIMIT 30`,
      [employeeMobile],
    ),
  ]);
  return {allowed: true, tool: 'employee_financials', data: {pay, instructions}, error: null};
}

export async function vesselLookupTool(ctx: AiContext, query: string) {
  if (!canUseAdminTools(ctx.category) && ctx.category !== 'VERIFIED_EMPLOYEE') {
    return denied('vessel_lookup', 'PRIVATE_DATA_NOT_AUTHORIZED');
  }
  const result = await programsLookup({query: String(query ?? '').slice(0, 120), employeeMobile: ctx.employeeMobile});
  return {allowed: true, tool: 'vessel_lookup', data: result, error: null};
}

export async function cashSummaryTool(ctx: AiContext, from: string, to: string) {
  if (!canUseAdminTools(ctx.category)) return denied('cash_summary', 'ADMIN_REQUIRED');
  const report = await incomeExpense(from, to);
  const pending = await listInstructions({state: 'REVIEW', limit: 20});
  const posted = await listInstructions({state: 'POSTED', limit: 20});
  return {allowed: true, tool: 'cash_summary', data: {report, pending, posted}, error: null};
}

export async function ledgerLookupTool(ctx: AiContext, from: string, to: string) {
  if (!canUseAdminTools(ctx.category)) return denied('ledger_lookup', 'ADMIN_REQUIRED');
  return {allowed: true, tool: 'ledger_lookup', data: await listLedger({from, to, limit: 100}), error: null};
}

export async function applicantDraftTool(ctx: AiContext, fields: {
  fullName: string | null; phone: string | null; jobCategory: string | null; rawText: string;
}) {
  if (!['UNKNOWN_CONTACT', 'JOB_APPLICANT'].includes(ctx.category)) {
    return denied('applicant_draft', 'APPLICANT_CHANNEL_REQUIRED');
  }
  const draft = await createApplicantDraft({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    chatJid: ctx.chatJid,
    fullName: fields.fullName,
    phone: fields.phone,
    jobCategory: fields.jobCategory,
    payload: {rawText: fields.rawText.slice(0, 4000), source: 'WA-02'},
  });
  return {allowed: true, tool: 'applicant_draft', data: draft, error: null};
}

export async function orderDraftTool(ctx: AiContext, fields: {
  motherVessel: string | null;
  lighterVessel: string | null;
  masterMobile: string | null;
  destination: string | null;
  startDate: string | null;
  startShift: 'D' | 'N' | null;
  sourceMessageId: string;
  rawText: string;
}) {
  if (ctx.category !== 'ESCORT_CLIENT') {
    return denied('order_draft', 'ESCORT_CLIENT_REQUIRED');
  }
  const draft = await createOrderDraft({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    chatJid: ctx.chatJid,
    motherVessel: fields.motherVessel,
    lighterVessel: fields.lighterVessel,
    masterMobile: fields.masterMobile,
    destination: fields.destination,
    startDate: fields.startDate,
    startShift: fields.startShift,
    payload: {rawText: fields.rawText.slice(0, 4000), confirmed: false},
    sourceMessageId: fields.sourceMessageId,
  });
  await escalate({
    conversationId: ctx.conversationId,
    reason: 'WA02_ORDER_DRAFT_REVIEW_REQUIRED',
    details: {draftId: (draft as {id?: string})?.id, sourceMessageId: fields.sourceMessageId},
    actor: ctx.actor ?? null,
  });
  return {allowed: true, tool: 'order_draft', data: draft, error: null};
}

export async function messageDraftTool(ctx: AiContext, input: {
  recipientJid: string;
  content: string;
  sourceRef?: string | null;
}) {
  if (!canUseAdminTools(ctx.category)) return denied('message_draft', 'ADMIN_REQUIRED');
  const draft = await createOutboundDraft({
    conversationId: ctx.conversationId,
    accountId: ctx.accountId,
    chatJid: ctx.chatJid,
    recipientJid: input.recipientJid,
    content: input.content,
    sourceRef: input.sourceRef ?? null,
  });
  return {allowed: true, tool: 'message_draft', data: draft, error: null};
}

export async function sourceConversationTool(ctx: AiContext, query: string) {
  if (!canUseAdminTools(ctx.category)) return denied('source_conversation', 'ADMIN_REQUIRED');
  const q = `%${String(query ?? '').slice(0, 80)}%`;
  return {
    allowed: true,
    tool: 'source_conversation',
    data: await rows(
      `SELECT account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, left(text_content, 500) AS text
         FROM whatsapp_messages
        WHERE text_content ILIKE $1
        ORDER BY source_timestamp DESC LIMIT 20`,
      [q],
    ),
    error: null,
  };
}

export async function auditTool(ctx: AiContext) {
  if (!canUseAdminTools(ctx.category)) return denied('audit_read', 'ADMIN_REQUIRED');
  return {allowed: true, tool: 'audit_read', data: await listAudit({limit: 50}), error: null};
}

export async function conversationSummary(ctx: AiContext) {
  const messages = await rows<{role: string; content: string | null; created_at: string}>(
    `SELECT role, content, created_at FROM ai_messages WHERE conversation_id = $1 ORDER BY created_at DESC LIMIT 20`,
    [ctx.conversationId],
  );
  return messages.reverse();
}
