import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {dashboardCounts, dashboardToday} from '@/lib/standalone/dashboard';
import {searchEmployees} from '@/lib/standalone/employees';
import {assistantEnabled} from '@/lib/standalone/assistant-settings';
import {composeReply} from '@/lib/ai/llm';
import {ASSISTANT_DENIAL, getSystemPrompt} from '@/lib/standalone/ai-assistant-prompt';
import {
  hasExplicitDateRange, isBlockedQuestion, guideFor, planAssistantCall, fallbackMessage,
  intentForCall, suggestionsForIntent,
} from '@/lib/standalone/ai-assistant-functions';
import {matchTemplateByLabel, resolveTemplateActions} from '@/lib/standalone/ai-assistant-templates';
import {answerDatedSummary, detectDatedIntent, DATE_HELP} from '@/lib/standalone/ai-assistant-summaries';
import {flowFromContext, flowFromMessage, walkthroughAnswer, WALKTHROUGHS} from '@/lib/standalone/ai-assistant-walkthrough';
import {
  classifyPersonMessage, inheritedAnswer, inheritedIntent, personAnswer,
} from '@/lib/standalone/ai-assistant-person';
import {decodeContext, encodeContext} from '@/lib/standalone/ai-assistant-context';
import {parseDateExpression} from '@/lib/standalone/ai-assistant-dates';
import {answerSqlQuestion, writeIntentAnswer} from '@/lib/standalone/ai-sql-engine';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Floating assistant — read-only by construction.
 *
 * It calls the same functions that back the dashboard cards (no HTTP hop, no
 * tools, no write path). The language model may only rephrase the verified
 * digest, and every failure returns the digest verbatim.
 */
const IN_SCOPE = /(employee|staff|worker|attendance|present|absent|vessel|ship|program|programme|cash|payment|paid|taka|salary|today|yesterday|this month|summary|dashboard|report|কর্ম|কর্মচারী|এমপ্লোয়ি|উপস্থিত|অনুপস্থিত|জাহাজ|প্রোগ্রাম|টাকা|বেতন|আজ|গতকাল|মাস|কত|হিসাব)/i;

/** Remember the last navigated domain so a bare follow-up name has meaning. */
function navContext(call: ReturnType<typeof planAssistantCall>): string | null {
  if (!call || call.name !== 'navigateToPage') return null;
  const page = String(call.arguments?.page ?? '');
  const filters = (call.arguments?.filters ?? {}) as Record<string, string>;
  const domain = page.startsWith('cash') ? 'cash'
    : page === 'vessel' ? 'vessel'
      : page === 'attendance' ? 'attendance'
        : page === 'employees' ? 'employee' : null;
  if (!domain) return null;
  return encodeContext({domain: domain as 'cash' | 'attendance' | 'vessel' | 'employee', from: filters.from, to: filters.to});
}

const PAGE_LABEL: Record<string, string> = {  '/home': 'Home dashboard',
  '/insights': 'Insights',
  '/employees': 'Employees / Escorts',
  '/vessel': 'Vessel Register',
  '/release': 'Escort Release',
  '/attendance': 'Attendance',
  '/cash': 'Cash & Accounts',
  '/payroll': 'Payroll',
  '/review': 'Review Queue',
  '/reports': 'Reports & Archive',
  '/settings': 'Settings',
};

const HOUR_MS = 3_600_000;
const hits = new Map<string, number[]>();

/** Per-user hourly limit. In-process, which is enough for a single app container. */
function takeSlot(actorId: string): {allowed: boolean; remaining: number} {
  const max = Math.min(Math.max(Math.floor(Number(process.env.AI_ASSISTANT_MAX_PER_HOUR ?? 20)) || 20, 1), 500);
  const now = Date.now();
  if (hits.size > 5_000) hits.clear();
  const recent = (hits.get(actorId) ?? []).filter((at) => now - at < HOUR_MS);
  if (recent.length >= max) {
    hits.set(actorId, recent);
    return {allowed: false, remaining: 0};
  }
  recent.push(now);
  hits.set(actorId, recent);
  return {allowed: true, remaining: max - recent.length};
}

const n = (value: number) => Number(value || 0).toLocaleString('en-US');

function digest(counts: Awaited<ReturnType<typeof dashboardCounts>>, page: string): string {
  return [
    `Business date: ${dashboardToday()} (Asia/Dhaka)`,
    `Screen the user is looking at: ${PAGE_LABEL[page] ?? (page || 'unknown')}`,
    '',
    'VERIFIED DASHBOARD TOTALS (live tables, ready data only — pending review rows excluded)',
    `Employees — all time ${n(counts.employeesTotal)}, this month ${n(counts.employeesThisMonth)}, today ${n(counts.employeesToday)}`,
    `Attendance days — all time ${n(counts.attendanceTotal)}, this month ${n(counts.attendanceThisMonth)}, today ${n(counts.attendanceToday)}`,
    `Cash payments — all time ${n(counts.paymentsTotal)}, this month ${n(counts.paymentsThisMonth)}, today ${n(counts.paymentsToday)}`,
    `Vessel programmes — all time ${n(counts.vesselsTotal)}, this month ${n(counts.vesselsThisMonth)}, today ${n(counts.vesselsToday)}`,
  ].join('\n');
}

export async function POST(request: Request) {
  try {
    // Every authenticated account may use the helper; it is not an admin tool.
    const actor = await actorFor(request);
    if (!(await assistantEnabled())) {
      return ok({ok: false, error: 'ASSISTANT_DISABLED'}, 403);
    }

    const body = await bodyOf<{message?: string; page?: string; context?: string}>(request);
    const message = String(body.message ?? '').trim().slice(0, 500);
    const page = String(body.page ?? '').slice(0, 120);
    const flowContext = String(body.context ?? '').slice(0, 60);
    if (!message) return ok({ok: false, error: 'MESSAGE_REQUIRED'}, 400);

    const slot = takeSlot(String(actor.id ?? 'unknown'));
    if (!slot.allowed) return ok({ok: false, error: 'RATE_LIMITED'}, 429);

    const mobile = message.match(/(?:\+?88)?(01[3-9]\d{8})/)?.[1] ?? null;

    // Deterministic templates win over the model: the label already carries the
    // verified steps, so no LLM call and no drift.
    const template = matchTemplateByLabel(message);
    if (template) {
      return ok({
        ok: true,
        answer: template.response,
        template: {id: template.id, label: template.label},
        actions: resolveTemplateActions(template),
        suggestions: template.followUps.slice(0, 4),
        context: template.context,
        used: false, model: null, remaining: slot.remaining,
      });
    }

    // Hard deny list runs before the model, so the refusal never depends on it.
    if (isBlockedQuestion(message)) {
      return ok({
        ok: true, answer: ASSISTANT_DENIAL, blocked: true, used: false, model: null,
        suggestions: suggestionsForIntent('blocked'),
        remaining: slot.remaining,
      });
    }

    // Date-aware summaries (deterministic, SELECT-only). This is why
    // "গতকালে ক্যাশ সামারি দাও" no longer falls back to dashboard totals.
    const dated = detectDatedIntent(message);
    if (dated) {
      const summary = await answerDatedSummary(message, dated);
      return ok({
        ok: true, answer: summary.text, actions: summary.actions,
        suggestions: summary.suggestions, context: summary.context,
        used: false, model: null, remaining: slot.remaining,
      });
    }

    // Person-aware intents (search / "হিসাব") run before the generic date guard
    // so a name with a date never loses its subject.
    const personIntent = classifyPersonMessage(message);
    if (personIntent) {
      if (hasExplicitDateRange(message) && !parseDateExpression(message)) {
        return ok({
          ok: true, answer: DATE_HELP, unsupported_range: true, used: false, model: null,
          suggestions: suggestionsForIntent('unsupported_date_range'), remaining: slot.remaining,
        });
      }
      const answer = await personAnswer(personIntent, message);
      return ok({
        ok: true, answer: answer.text, actions: answer.actions, chips: answer.chips,
        suggestions: answer.suggestions, context: answer.context || null,
        used: false, model: null, remaining: slot.remaining,
      });
    }

    // Edit/delete requests never reach SQL — explain the UI path instead.
    const writeAnswer = writeIntentAnswer(message);
    if (writeAnswer) {
      return ok({
        ok: true, answer: writeAnswer.text, actions: writeAnswer.actions,
        suggestions: writeAnswer.suggestions, context: null,
        used: false, model: null, remaining: slot.remaining,
      });
    }

    // Universal read-only search for unanticipated data questions. Skipped when
    // a date-like phrase cannot be parsed (it would become an all-time total).
    if (!(hasExplicitDateRange(message) && !parseDateExpression(message))) {
      const sqlAnswer = await answerSqlQuestion(message, decodeContext(flowContext));
      if (sqlAnswer) {
        return ok({
          ok: true, answer: sqlAnswer.text, actions: sqlAnswer.actions,
          suggestions: sqlAnswer.suggestions, context: sqlAnswer.context,
          used: false, model: null, remaining: slot.remaining,
        });
      }
    }

    // A date-like phrase we cannot parse must not become an all-time total.
    if (hasExplicitDateRange(message)) {
      return ok({
        ok: true, answer: DATE_HELP, unsupported_range: true,
        used: false, model: null,
        suggestions: suggestionsForIntent('unsupported_date_range'),
        remaining: slot.remaining,
      });
    }

    // Context memory: pronouns and bare names inherit the previous domain.
    const prior = decodeContext(flowContext);
    if (prior?.domain === 'employee' && prior.employeeMobile && /^(হ্যাঁ|হা|yes\b|y\b|ok\b|okay\b)/i.test(message)) {
      const answer = await inheritedAnswer({domain: 'cash', mobile: prior.employeeMobile, from: prior.from, to: prior.to});
      return ok({
        ok: true, answer: answer.text, actions: answer.actions, chips: answer.chips,
        suggestions: answer.suggestions, context: answer.context || null,
        used: false, model: null, remaining: slot.remaining,
      });
    }
    if (prior?.domain === 'employee' && /^(না|ন\b|no\b|n\b|cancel)/i.test(message)) {
      return ok({
        ok: true, answer: 'ঠিক আছে — নামের বানান বা মোবাইল নম্বর বলুন।',
        suggestions: ['Search an employee..', 'Today\'s cash..'],
        context: null, used: false, model: null, remaining: slot.remaining,
      });
    }
    const inherited = inheritedIntent(prior, message);
    if (inherited) {
      const answer = await inheritedAnswer(inherited);
      return ok({
        ok: true, answer: answer.text, actions: answer.actions, chips: answer.chips,
        suggestions: answer.suggestions, context: answer.context || null,
        used: false, model: null, remaining: slot.remaining,
      });
    }

    // Mid-flow questions resolve against the walkthrough KB before any model.
    const MIDFLOW = /(সেভ|save|ক্যান্সেল|cancel|ডিলিট|delete|আপলোড|upload|ধাপ|step|কিরুম|কি\s*করব|কিভাবে|কোথায়|error|এরর|সমস্যা|next|পরের)/i;
    if (MIDFLOW.test(message)) {
      const flow = flowFromContext(flowContext) ?? flowFromMessage(message);
      if (flow) {
        const reply = walkthroughAnswer(flow, message);
        return ok({
          ok: true, answer: reply.text, actions: WALKTHROUGHS[flow].actions,
          suggestions: reply.suggestions, context: reply.context,
          used: false, model: null, remaining: slot.remaining,
        });
      }
    }

    const call = planAssistantCall(message);
    const guide = guideFor(message);

    if (!IN_SCOPE.test(message) && !mobile && !call && !guide) {
      return ok({
        ok: true, answer: fallbackMessage(message), used: false, model: null,
        suggestions: suggestionsForIntent('free_chat'),
        remaining: slot.remaining,
      });
    }

    // Tool intents get a short, number-free base so the model cannot drift from
    // a dashboard digest it does not need. General questions keep the digest.
    let context: string;
    if (guide) {
      context = guide;
    } else if (call) {
      context = 'নিচে অনুরোধকৃত তথ্য দেখানো হচ্ছে।';
    } else {
      context = digest(await dashboardCounts(), page);
    }

    if (mobile) {
      const matches = await searchEmployees(mobile, 3);
      if (matches.length) {
        const rows = matches.map((entry) => {
          const alias = Array.isArray(entry.name_aliases) && entry.name_aliases.length
            ? ` (aliases: ${entry.name_aliases.slice(0, 3).join(', ')})`
            : '';
          return `- ${entry.preferred_name ?? 'Unnamed'}${alias} · ${entry.employee_mobile} · ${entry.designation ?? 'no designation'} · ${entry.state}`;
        });
        context += `\n\nEMPLOYEE LOOKUP (directory fields only):\n${rows.join('\n')}`;
      } else {
        context += '\n\nEMPLOYEE LOOKUP: no directory match for that number.';
      }
    }

    const composed = await composeReply({
      deterministicAnswer: context,
      userText: message,
      category: 'DASHBOARD_READONLY',
      intent: 'DASHBOARD_QUERY',
      conversationId: `assistant:${actor.id}`,
      history: [],
      systemPrompt: getSystemPrompt(),
    }, {purpose: 'platform-assistant'});

    return ok({
      ok: true,
      answer: composed.text,
      used: composed.used,
      model: composed.model,
      reason: composed.reason,
      remaining: slot.remaining,
      function_call: call,
      context: navContext(call),
      suggestions: suggestionsForIntent(call ? intentForCall(call) : 'free_chat'),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
