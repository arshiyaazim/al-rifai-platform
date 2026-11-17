/**
 * Resilient person resolution and conversational answers (E2.6).
 *
 * Pure classification + formatting on top of the read-only employee search.
 * `resolvePerson` accepts an injectable search function so tests never touch a
 * database. Answers are Bengali and always offer a next step.
 */
import {displayMobile} from '../display-mobile.ts';
import type {EmployeeSuggestion} from '@/lib/standalone/employees';
import {generateNameVariants, type NameVariants} from './ai-assistant-names.ts';
import {parseDateExpression, toBengaliDigits, formatBnDate} from './ai-assistant-dates.ts';
import {employeeCashSummary} from './ai-assistant-queries.ts';
import {employeeAttendance, vesselPrograms} from './ai-assistant-queries.ts';
import {encodeContext, type AssistantContext} from './ai-assistant-context.ts';
import {searchEmployees} from './employees.ts';

export type PersonIntentKind = 'search' | 'money';
export type PersonIntent = {kind: PersonIntentKind; query: string};

const EMP = /(এমপ্লোয়ি|এমপ্লয়ি|কর্মচারী|কর্মী|\bemployee\b|\bstaff\b)/i;
const NAME_HINT = /(নামক|নামে|নামের|নাম\b|\bnamed\b|\bname\b)/i;
const EXIST = /(আছে|আছেন|কেউ|কোনো|\banyone\b|\bexists\b|\bfind\b|খুঁজে|\bsearch\b|\bwho\b)/i;
const MONEY = /(হিসাব|লেনদেন|ক্যাশ|\bcash\b|পেমেন্ট|\bpayment\b|কত\s*টাকা|\bpaid\b|\bdue\b|বাকি)/i;

const NAME_STOP = /(ক্যাশ|cash|হাজিরা|উপস্থিতি|attendance|ভেসেল|vessel|লাইটার|প্রোগ্রাম|এসকর্ট|escort|সামারি|summary|মোট|total|হিস্ট্রি|history|দেখাও|গেছিলো|গেছে|নামক|নামে|নামের|নাম|এমপ্লোয়ি|এমপ্লয়ি|এমপ্লোয়ির|কর্মচারী|কর্মী|আছে|আছেন|কোনো|কেউ|আমার|তার|ওর|হিসাব|লেনদেন|পেমেন্ট|জানা|দরকার|কত|টাকা|paid|due|বাকি|who|is|find|search|employee|staff|named|name|দাও|দিন|বলো|বলুন|করব|করুন|দেখাচ্ছি|বলছি)/gi;
const DATE_STOP = /(আজ|আজকে|আজকের|গতকাল|গতকালে|গতকালের|গত\s*মাসে?|গত\s*মাসের|এই\s*মাস|চলতি\s*মাস|গত\s*সপ্তাহ|গত\s*\d+\s*দিন|today|yesterday|this\s+month|last\s+(week|month)|\d{4}-\d{2}-\d{2}|\d+\s*তারিখ)/gi;

/** Best-effort person name from a sentence (Bengali or Latin). */
export function extractPersonName(message: string): string {
  const cleaned = String(message ?? '')
    .replace(DATE_STOP, ' ')
    .replace(NAME_STOP, ' ')
    .replace(/[০-৯]+/g, ' ')
    .replace(/[.,?!:;"'()\[\]{}?]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = cleaned.split(' ')
    .filter(Boolean)
    .map((word) => word.replace(/(ের|এর|কে|তে|এ)$/u, ''))
    .filter((word) => word.length >= 2);
  return kept.slice(0, 3).join(' ').trim();
}

export function classifyPersonMessage(message: string): PersonIntent | null {
  const text = String(message ?? '').trim();
  if (!text) return null;
  const query = extractPersonName(text);
  if (!query) return null;
  if (MONEY.test(text)) return {kind: 'money', query};
  if ((EMP.test(text) && (NAME_HINT.test(text) || EXIST.test(text))) || (NAME_HINT.test(text) && EXIST.test(text))) {
    return {kind: 'search', query};
  }
  return null;
}

export function isBarePersonQuery(message: string): boolean {
  const text = String(message ?? '').trim();
  if (!text) return false;
  const words = text.replace(/[?।.!]/g, '').split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 3) return false;
  if (MONEY.test(text) || EMP.test(text) || EXIST.test(text) || NAME_HINT.test(text)) return false;
  if (text.replace(DATE_STOP, ' ').trim() !== text) return false;
  const name = extractPersonName(text);
  return name.length >= 2;
}

export function isPronounQuery(message: string): boolean {
  return /^(ওর|তার|এর|এঁর|এই\s*(এমপ্লোয়ি|কর্মচারী|employee)|\bhis\b|\bher\b|\btheir\b)/i.test(String(message ?? '').trim());
}

export type PersonMatch = Pick<EmployeeSuggestion, 'employee_mobile' | 'preferred_name' | 'designation'>;

export type PersonResolution = {
  query: string;
  variants: string[];
  matches: PersonMatch[];
};

type SearchFn = (query: string, limit: number) => Promise<PersonMatch[]>;

export async function resolvePerson(
  query: string, search: SearchFn = searchEmployees as unknown as SearchFn,
): Promise<PersonResolution> {
  const variants: NameVariants = generateNameVariants(query);
  const scored = new Map<string, {match: PersonMatch; score: number}>();
  const terms = variants.all.slice(0, 10);
  const results = await Promise.all(terms.map((term) => search(term, 5).catch(() => [])));
  const needle = query.trim().toLowerCase();
  results.forEach((found, index) => {
    for (const match of found) {
      const name = match.preferred_name.trim().toLowerCase();
      const exact = name === needle ? 100
        : name.startsWith(needle) ? 50
          : name.split(/\s+/).includes(needle) ? 40 : 0;
      const score = exact + (10 - index);
      const current = scored.get(match.employee_mobile);
      if (!current || score > current.score) scored.set(match.employee_mobile, {match, score});
    }
  });
  return {
    query, variants: variants.all,
    matches: [...scored.values()].sort((a, b) => b.score - a.score || a.match.preferred_name.localeCompare(b.match.preferred_name)).map((entry) => entry.match),
  };
}

export type PersonAnswer = {
  text: string;
  actions: Array<{label: string; href: string}>;
  suggestions: string[];
  chips?: Array<{label: string; value: string}>;
  context: string;
};

const n = (value: number) => toBengaliDigits(value);
const money = (minor: number) => `৳${new Intl.NumberFormat('bn-BD', {maximumFractionDigits: 2}).format(Number(minor || 0) / 100)}`;

export function triedVariants(variants: string[]): string {
  const latin = variants.filter((value) => /^[a-z\s]+$/i.test(value.trim()));
  return (latin.length ? latin : variants).slice(0, 5).join('/');
}

export function formatNoMatch(query: string, variants: string[]): PersonAnswer {
  return {
    text: `'${query}' নামে কাউকে পাইনি (${triedVariants(variants)} সব রূপে খুঁজেছি)।\n• বানান অন্যরকম হতে পারে?\n• মোবাইল নম্বর দিন\n• অথবা Employees পেজে খুঁজুন`,
    actions: [{label: 'Open Employees', href: '/employees'}],
    suggestions: ['Search an employee..', 'Add New Employee..'],
    context: '',
  };
}

export function formatOne(query: string, match: PersonMatch): PersonAnswer {
  return {
    text: `'${match.preferred_name}' (${displayMobile(match.employee_mobile)}) পেয়েছি — এটিই কি?`,
    actions: [{label: 'Open profile', href: `/employees/${encodeURIComponent(match.employee_mobile)}`}],
    chips: [{label: 'হ্যাঁ', value: 'হ্যাঁ'}, {label: 'না, অন্য খুঁজছি', value: 'না, অন্য খুঁজছি'}],
    suggestions: [],
    context: encodeContext({domain: 'employee', employeeMobile: match.employee_mobile}),
  };
}

export function formatMany(query: string, matches: PersonMatch[]): PersonAnswer {
  const lines = matches.slice(0, 5).map((match, index) =>
    `${index + 1}. ${match.preferred_name} — ${displayMobile(match.employee_mobile)}${match.designation ? ` (${match.designation})` : ''}`);
  return {
    text: `'${query}' — ${n(matches.length)} জন মিলেছে:\n${lines.join('\n')}\nমোবাইল নম্বর বললে নির্দিষ্ট হিসাব দেব।`,
    actions: matches.slice(0, 3).map((match) => ({
      label: `View ${match.preferred_name}`, href: `/employees/${encodeURIComponent(match.employee_mobile)}`,
    })).concat({label: 'Open Employees', href: '/employees'}),
    suggestions: ['Search an employee..', "Today's cash.."],
    context: '',
  };
}

export async function personAnswer(intent: PersonIntent, message: string, now: Date = new Date()): Promise<PersonAnswer> {
  const resolution = await resolvePerson(intent.query);
  if (!resolution.matches.length) return formatNoMatch(intent.query, resolution.variants);
  if (resolution.matches.length > 1) return formatMany(intent.query, resolution.matches);
  const match = resolution.matches[0];
  if (intent.kind === 'search') return formatOne(intent.query, match);

  const parsed = parseDateExpression(message, now);
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  const from = parsed?.from ?? `${today.slice(0, 7)}-01`;
  const to = parsed?.to ?? today;
  const total = await employeeCashSummary(match.employee_mobile, from, to);
  const label = parsed?.labelBn ?? `এই মাস (${formatBnDate(from)} – ${formatBnDate(to)})`;
  return {
    text: `${match.preferred_name} — ${label}:\n• মোট: ${money(total.totalMinor)}\n• লেনদেন: ${n(total.count)} টি\n• হিসাব শুধু POSTED এন্ট্রির; রিভিউ-অপেক্ষমাণ এন্ট্রি বাদে।`,
    actions: [
      {label: 'Open ledger', href: `/cash/transactions?from=${from}&to=${to}&employee_mobile=${encodeURIComponent(match.employee_mobile)}`},
      {label: 'Open profile', href: `/employees/${encodeURIComponent(match.employee_mobile)}`},
    ],
    suggestions: ['এই মাসের ক্যাশ সামারি', 'গত মাসের ক্যাশ সামারি', 'Add Hotel Bill..'],
    context: encodeContext({domain: 'employee', employeeMobile: match.employee_mobile, from, to}),
  };
}

export type InheritedIntent = {
  domain: 'cash' | 'attendance' | 'vessel' | 'employee';
  name?: string;
  mobile?: string;
  from?: string;
  to?: string;
};

/** Does this message inherit the previous domain (pronoun or bare name)? */
export function inheritedIntent(prior: AssistantContext | null, message: string): InheritedIntent | null {
  if (!prior) return null;
  if (isPronounQuery(message) && prior.employeeMobile) {
    return {
      domain: prior.domain === 'employee' ? 'cash' : (prior.domain as InheritedIntent['domain']),
      mobile: prior.employeeMobile, from: prior.from, to: prior.to,
    };
  }
  if (['cash', 'attendance', 'vessel', 'employee'].includes(prior.domain) && isBarePersonQuery(message)) {
    const name = extractPersonName(message);
    if (!name) return null;
    return {
      domain: prior.domain === 'employee' ? 'cash' : (prior.domain as InheritedIntent['domain']),
      name, from: prior.from, to: prior.to,
    };
  }
  return null;
}

function monthBounds(now: Date) {
  const today = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit'}).format(now);
  return {from: `${today.slice(0, 7)}-01`, to: today};
}

const personByMobile = async (mobile: string): Promise<PersonMatch | null> => {
  const found = await searchEmployees(mobile, 1);
  return found[0] ?? null;
};

export async function inheritedAnswer(intent: InheritedIntent, now: Date = new Date()): Promise<PersonAnswer> {
  const bounds = intent.from && intent.to ? {from: intent.from, to: intent.to} : monthBounds(now);
  let match: PersonMatch | null;
  if (intent.mobile) match = await personByMobile(intent.mobile);
  else {
    const resolution = await resolvePerson(intent.name ?? '');
    if (!resolution.matches.length) return formatNoMatch(intent.name ?? '', resolution.variants);
    if (resolution.matches.length > 1) return formatMany(intent.name ?? '', resolution.matches);
    match = resolution.matches[0];
  }
  if (!match) return formatNoMatch(intent.name ?? intent.mobile ?? '', []);

  if (intent.domain === 'attendance') {
    const summary = await employeeAttendance(match.employee_mobile, bounds.from, bounds.to);
    return {
      text: `${match.preferred_name} — ${formatBnDate(bounds.from)} – ${formatBnDate(bounds.to)}:\n• উপস্থিত দিন: ${n(summary.days)}\n• রেকর্ড: ${n(summary.records)}`,
      actions: [
        {label: 'Open profile', href: `/employees/${encodeURIComponent(match.employee_mobile)}`},
        {label: 'Open attendance', href: '/attendance'},
      ],
      suggestions: ['এই মাসের হাজিরা সামারি', 'Add Attendance..'],
      context: encodeContext({domain: 'employee', employeeMobile: match.employee_mobile, from: bounds.from, to: bounds.to}),
    };
  }
  if (intent.domain === 'vessel') {
    const vessels = await vesselPrograms({q: intent.name ?? '', from: bounds.from, to: bounds.to, limit: 5});
    const lines = vessels.slice(0, 3).map((entry) => `• ${entry.mother} → ${entry.lighter} · ${formatBnDate(entry.startDate)}`);
    return {
      text: `${match.preferred_name} — ${formatBnDate(bounds.from)} – ${formatBnDate(bounds.to)}: ${n(vessels.length)} টি প্রোগ্রাম\n${lines.join('\n')}`,
      actions: [{label: 'Open vessel', href: '/vessel'}],
      suggestions: ['Add lighter program..', 'Add Release Info..'],
      context: encodeContext({domain: 'vessel', employeeMobile: match.employee_mobile, from: bounds.from, to: bounds.to}),
    };
  }
  const total = await employeeCashSummary(match.employee_mobile, bounds.from, bounds.to);
  return {
    text: `${match.preferred_name} — ${formatBnDate(bounds.from)} – ${formatBnDate(bounds.to)}:\n• মোট: ${money(total.totalMinor)}\n• লেনদেন: ${n(total.count)} টি\n• হিসাব শুধু POSTED এন্ট্রির; রিভিউ-অপেক্ষমাণ এন্ট্রি বাদে।`,
    actions: [
      {label: 'Open ledger', href: `/cash/transactions?from=${bounds.from}&to=${bounds.to}&employee_mobile=${encodeURIComponent(match.employee_mobile)}`},
      {label: 'Open profile', href: `/employees/${encodeURIComponent(match.employee_mobile)}`},
    ],
    suggestions: ['এই মাসের ক্যাশ সামারি', 'Add Hotel Bill..'],
    context: encodeContext({domain: 'employee', employeeMobile: match.employee_mobile, from: bounds.from, to: bounds.to}),
  };
}
