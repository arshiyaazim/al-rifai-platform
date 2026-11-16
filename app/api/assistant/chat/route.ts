import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {dashboardCounts, dashboardToday} from '@/lib/standalone/dashboard';
import {searchEmployees} from '@/lib/standalone/employees';
import {assistantEnabled} from '@/lib/standalone/assistant-settings';
import {composeReply} from '@/lib/ai/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Floating assistant — read-only by construction.
 *
 * It calls the same functions that back the dashboard cards (no HTTP hop, no
 * tools, no write path). The language model may only rephrase the verified
 * digest, and every failure returns the digest verbatim.
 */
const FALLBACK = 'I can help you find information from your dashboards — employees, attendance, vessel programmes and cash totals. Try asking "how many employees joined this month?"';

const IN_SCOPE = /(employee|staff|worker|attendance|present|absent|vessel|ship|program|programme|cash|payment|paid|taka|salary|today|yesterday|this month|summary|dashboard|report|কর্ম|উপস্থিত|অনুপস্থিত|জাহাজ|প্রোগ্রাম|টাকা|বেতন|আজ|গতকাল|মাস|কত)/i;

const PAGE_LABEL: Record<string, string> = {
  '/home': 'Home dashboard',
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

    const body = await bodyOf<{message?: string; page?: string}>(request);
    const message = String(body.message ?? '').trim().slice(0, 500);
    const page = String(body.page ?? '').slice(0, 120);
    if (!message) return ok({ok: false, error: 'MESSAGE_REQUIRED'}, 400);

    const slot = takeSlot(String(actor.id ?? 'unknown'));
    if (!slot.allowed) return ok({ok: false, error: 'RATE_LIMITED'}, 429);

    const mobile = message.match(/(?:\+?88)?(01[3-9]\d{8})/)?.[1] ?? null;
    if (!IN_SCOPE.test(message) && !mobile) {
      return ok({ok: true, answer: FALLBACK, used: false, model: null, remaining: slot.remaining});
    }

    const counts = await dashboardCounts();
    let context = digest(counts, page);

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
    }, {purpose: 'platform-assistant'});

    return ok({
      ok: true,
      answer: composed.text,
      used: composed.used,
      model: composed.model,
      reason: composed.reason,
      remaining: slot.remaining,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
