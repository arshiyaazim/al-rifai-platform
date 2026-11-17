/**
 * Date-aware deterministic summaries (W4).
 *
 * Parses a date phrase, runs the read-only query layer and formats a compact
 * Bengali answer with real navigation chips. Runs BEFORE the planner/LLM, so
 * "গতকালে ক্যাশ সামারি দাও" can never fall back to dashboard totals.
 */
import {parseDateExpression, formatBnDate, toBengaliDigits, type ParsedDateRange} from './ai-assistant-dates.ts';
import {encodeContext} from './ai-assistant-context.ts';
import {
  attendanceSummary, cashSummary, employeeAttendance, employeeCashSummary, vesselPrograms,
} from './ai-assistant-queries.ts';
import {guessName} from './ai-assistant-functions.ts';
import {searchEmployees} from './employees.ts';

export type SummaryDomain = 'cash' | 'attendance' | 'vessel';

export type DatedIntent = {
  domain: SummaryDomain;
  range: ParsedDateRange;
};

export const DATE_HELP = [
  'তারিখ এভাবে লিখুন: "গতকাল", "গত ৩ দিন", "গত সপ্তাহ", "গত মাস", "এই মাস",',
  'অথবা 2026-11-01 থেকে 2026-11-07।',
].join(' ');

const MOBILE = /(?:\+?88)?(01[3-9]\d{8})/;
const DOMAIN_CASH = /(ক্যাশ|লেনদেন|\bcash\b|\btransactions?\b)/i;
const DOMAIN_ATTENDANCE = /(হাজিরা|উপস্থিতি|\battendance\b)/i;
const DOMAIN_VESSEL = /(ভেসেল|জাহাজ|লাইটার|\bvessel\b|\blighter\b|এসকর্ট|\bescort\b)/i;
const INTENT = /(সামারি|সারসংক্ষেপ|\bsummary\b|মোট|\btotal\b|দেখাও|হিস্ট্রি|\bhistory\b|কে\s*গেছ|কে\s*গেছিল|\bwho\s+went\b|কত|হাজিরা|উপস্থিতি)/i;

/** Domain + intent + parseable date → dated summary; otherwise null. */
export function detectDatedIntent(message: string, now: Date = new Date()): DatedIntent | null {
  const text = message ?? '';
  if (!INTENT.test(text)) return null;
  const range = parseDateExpression(text, now);
  if (!range) return null;
  const domain: SummaryDomain | null = DOMAIN_ATTENDANCE.test(text) ? 'attendance'
    : DOMAIN_VESSEL.test(text) ? 'vessel'
      : DOMAIN_CASH.test(text) ? 'cash' : null;
  return domain ? {domain, range} : null;
}

const n = (value: number) => toBengaliDigits(value);
const NAME_STOP = /(ক্যাশ|cash|হাজিরা|উপস্থিতি|attendance|ভেসেল|vessel|লাইটার|lighter|প্রোগ্রাম|program|এসকর্ট|escort|সামারি|summary|মোট|total|হিস্ট্রি|history|দেখাও|গেছিলো|গেছে|কে|কত|who|went|how|much)/gi;

function personQuery(message: string): string {
  return guessName(message.replace(NAME_STOP, ' ')).trim();
}

async function resolveByName(query: string) {
  if (!query) return [] as Array<{employee_mobile: string; preferred_name: string}>;
  return searchEmployees(query, 3);
}

type EmployeeResolution =
  | {kind: 'one'; mobile: string; name: string}
  | {kind: 'ambiguous'; query: string; matches: Array<{employee_mobile: string; preferred_name: string}>}
  | {kind: 'none'};

async function resolveEmployee(message: string): Promise<EmployeeResolution> {
  const mobile = message.match(MOBILE)?.[1];
  if (mobile) {
    const stored = `+88${mobile}`;
    const [person] = await searchEmployees(stored, 1);
    return {kind: 'one', mobile: stored, name: person?.preferred_name ?? stored};
  }
  const query = personQuery(message);
  if (!query) return {kind: 'none'};
  const matches = await resolveByName(query);
  if (matches.length === 1) return {kind: 'one', mobile: matches[0].employee_mobile, name: matches[0].preferred_name};
  if (matches.length > 1) return {kind: 'ambiguous', query, matches};
  return {kind: 'none'};
}

function ambiguousAnswer(found: Extract<EmployeeResolution, {kind: 'ambiguous'}>): SummaryAnswer {
  return {
    text: `"${found.query}" — ${n(found.matches.length)} জন কর্মী মিলেছে: ${found.matches.map((m) => m.preferred_name).join(', ')}। মোবাইল নম্বর বললে নির্দিষ্ট হিসাব দেব।`,
    actions: [{label: 'Open Employees', href: '/employees'}],
    suggestions: ['Search an employee..', 'এই মাসের ক্যাশ সামারি'],
    context: null,
  };
}
const money = (minor: number) => {
  const value = Number(minor || 0) / 100;
  const digits = Number.isInteger(value) ? 0 : 2;
  return `৳${new Intl.NumberFormat('bn-BD', {minimumFractionDigits: digits, maximumFractionDigits: digits}).format(value)}`;
};

export type SummaryAnswer = {
  text: string;
  actions: Array<{label: string; href: string}>;
  suggestions: string[];
  context: string | null;
};

export async function answerDatedSummary(message: string, intent: DatedIntent): Promise<SummaryAnswer> {
  const {range} = intent;
  const ledger = `/cash/transactions?from=${range.from}&to=${range.to}`;

  if (intent.domain === 'cash') {
    const found = await resolveEmployee(message);
    if (found.kind === 'ambiguous') return ambiguousAnswer(found);
    if (found.kind === 'one') {
      const total = await employeeCashSummary(found.mobile, range.from, range.to);
      return {
        text: `${found.name} — ${range.labelBn}:\n• মোট: ${money(total.totalMinor)}\n• লেনদেন: ${n(total.count)} টি\n• হিসাব শুধু POSTED এন্ট্রির; রিভিউ-অপেক্ষমাণ এন্ট্রি বাদে।`,
        actions: [
          {label: 'Open ledger', href: `${ledger}&employee_mobile=${encodeURIComponent(found.mobile)}`},
          {label: 'Open profile', href: `/employees/${encodeURIComponent(found.mobile)}`},
        ],
        suggestions: ['এই মাসের ক্যাশ সামারি', 'Add Hotel Bill..', 'Search an employee..'],
        context: encodeContext({domain: 'employee', employeeMobile: found.mobile, from: range.from, to: range.to}),
      };
    }
    const summary = await cashSummary(range.from, range.to);
    const methods = summary.byMethod.map((entry) => `${entry.method} ${n(entry.count)}`).join(' · ') || '—';
    const top = summary.top.map((entry) => `${entry.employee} ${money(entry.amountMinor)}`).join(', ');
    return {
      text: [
        `${range.labelBn} ক্যাশ সামারি:`,
        `• মোট লেনদেন: ${n(summary.postedCount)}`,
        `• মোট: ${money(summary.totalMinor)}`,
        `• মাধ্যম: ${methods}`,
        top ? `• শীর্ষ: ${top}` : '',
        summary.reviewCount ? `⚠️ রিভিউ-অপেক্ষমাণ ${n(summary.reviewCount)}টি এন্ট্রি হিসাবের বাইরে।` : '',
      ].filter(Boolean).join('\n'),
      actions: [
        {label: 'Open ledger', href: ledger},
        {label: 'Review queue', href: '/review?category=CASH'},
      ],
      suggestions: ['এই মাসের ক্যাশ সামারি', 'Open ledger', 'Add Hotel Bill..'],
      context: encodeContext({domain: 'cash', from: range.from, to: range.to}),
    };
  }

  if (intent.domain === 'attendance') {
    const found = await resolveEmployee(message);
    if (found.kind === 'ambiguous') return ambiguousAnswer(found);
    if (found.kind === 'one') {
      const summary = await employeeAttendance(found.mobile, range.from, range.to);
      return {
        text: `${found.name} — ${range.labelBn}:\n• উপস্থিত দিন: ${n(summary.days)}\n• রেকর্ড: ${n(summary.records)}`,
        actions: [
          {label: 'Open profile', href: `/employees/${encodeURIComponent(found.mobile)}`},
          {label: 'Open attendance', href: '/attendance'},
        ],
        suggestions: ['এই মাসের হাজিরা সামারি', 'Add Attendance..', 'Search an employee..'],
        context: encodeContext({domain: 'employee', employeeMobile: found.mobile, from: range.from, to: range.to}),
      };
    }
    const summary = await attendanceSummary(range.from, range.to);
    const shifts = summary.byShift.map((entry) => `${entry.shift} ${n(entry.count)}`).join(' · ') || '—';
    const places = summary.byLocation.map((entry) => `${entry.location} ${n(entry.count)}`).join(' · ') || '—';
    return {
      text: [
        `${range.labelBn} হাজিরা সামারি:`,
        `• মোট রেকর্ড: ${n(summary.records)}`,
        `• উপস্থিত দিন: ${n(summary.days)}`,
        `• কর্মচারী: ${n(summary.employees)} জন`,
        `• শিফট: ${shifts}`,
        `• লোকেশন: ${places}`,
      ].join('\n'),
      actions: [{label: 'Open attendance', href: '/attendance'}],
      suggestions: ['এই মাসের হাজিরা সামারি', 'Add Attendance..', 'Search an employee..'],
      context: encodeContext({domain: 'attendance', from: range.from, to: range.to}),
    };
  }

  const name = personQuery(message);
  const vessels = await vesselPrograms({q: name, from: range.from, to: range.to, limit: 20});
  if (!vessels.length) {
    return {
      text: `${range.labelBn}: কোনো ভেসেল প্রোগ্রাম পাওয়া যায়নি${name ? ` ("${name}")` : ''}।`,
      actions: [{label: 'Open vessel', href: `/vessel?from=${range.from}&to=${range.to}`}],
      suggestions: ['Add lighter program..', 'Add Release Info..'],
      context: encodeContext({domain: 'vessel', from: range.from, to: range.to}),
    };
  }
  const lines = vessels.slice(0, 5).map((entry) =>
    `• ${entry.mother} → ${entry.lighter} · ${entry.escortName ?? 'এসকর্ট নেই'} · ${formatBnDate(entry.startDate)}`);
  return {
    text: `${range.labelBn} ভেসেল সামারি: ${n(vessels.length)} টি প্রোগ্রাম\n${lines.join('\n')}`,
    actions: [
      {label: 'Open vessel', href: `/vessel?from=${range.from}&to=${range.to}${name ? `&q=${encodeURIComponent(name)}` : ''}`},
    ],
    suggestions: ['Add lighter program..', 'Add Release Info..'],
    context: encodeContext({domain: 'vessel', from: range.from, to: range.to}),
  };
}
