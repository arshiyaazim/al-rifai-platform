/**
 * Assistant function contract.
 *
 * The provider transport used by this app (lib/ai/provider-client.ts) accepts
 * only chat messages — it has no tool/function-calling channel. The schemas
 * below are therefore the single source of truth for what the assistant may
 * ask for, and `planAssistantCall()` maps a user message to one of them
 * deterministically. Execution always happens in the browser against the
 * existing authenticated, read-only APIs; the model never touches data.
 */
import {URL_REGISTRY, buildUrl} from './url-registry.ts';
import {BLOCKED_TOPIC_PATTERNS} from './ai-assistant-prompt.ts';

export type AssistantFunctionName =
  | 'searchEmployee'
  | 'navigateToPage'
  | 'fetchCashSummary'
  | 'fetchAttendanceSummary'
  | 'fetchVesselSummary'
  | 'openSidebar'
  | 'isBlockedQuestion';

export type FunctionArguments = Record<string, unknown>;

export type AssistantFunctionCall = {
  name: AssistantFunctionName;
  arguments: FunctionArguments;
  /** Navigation/UI actions must be confirmed by the user before running. */
  requires_confirmation?: boolean;
  /** Read-only follow-up the client may run on the top match of a search. */
  follow_up?: 'cash' | 'attendance' | 'vessel';
  /** Date range to reuse for the follow-up fetch. */
  range?: {from?: string; to?: string};
};

export type FunctionDefinition = {
  name: AssistantFunctionName;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, {type: string; description: string}>;
    required: string[];
  };
};

export const AI_FUNCTION_DEFINITIONS: FunctionDefinition[] = [
  {
    name: 'searchEmployee',
    description: 'Fuzzy employee search by name, mobile or employee ID. Bangla names are transliterated server-side.',
    parameters: {
      type: 'object',
      properties: {
        query: {type: 'string', description: 'Name (Bangla or English), mobile number or employee ID'},
      },
      required: ['query'],
    },
  },
  {
    name: 'navigateToPage',
    description: 'Build a page URL with the real filters. Ask the user for confirmation before navigating.',
    parameters: {
      type: 'object',
      properties: {
        page: {type: 'string', description: 'One of: cash, cash/transactions, vessel, attendance, employees, review'},
        filters: {type: 'object', description: 'Filter names as understood by that page'},
      },
      required: ['page'],
    },
  },
  {
    name: 'fetchCashSummary',
    description: 'Read-only cash totals for one employee over an optional date range.',
    parameters: {
      type: 'object',
      properties: {
        employee_mobile: {type: 'string', description: 'Employee mobile, e.g. +8801712345678'},
        from: {type: 'string', description: 'ISO date YYYY-MM-DD'},
        to: {type: 'string', description: 'ISO date YYYY-MM-DD'},
      },
      required: ['employee_mobile'],
    },
  },
  {
    name: 'fetchAttendanceSummary',
    description: 'Read-only attendance days for one employee over an optional date range.',
    parameters: {
      type: 'object',
      properties: {
        employee_mobile: {type: 'string', description: 'Employee mobile'},
        from: {type: 'string', description: 'ISO date YYYY-MM-DD'},
        to: {type: 'string', description: 'ISO date YYYY-MM-DD'},
      },
      required: ['employee_mobile'],
    },
  },
  {
    name: 'fetchVesselSummary',
    description: 'Read-only vessel programme list, filtered by escort, mother vessel or dates.',
    parameters: {
      type: 'object',
      properties: {
        employee_mobile: {type: 'string', description: 'Escort mobile (optional)'},
        mother_vessel: {type: 'string', description: 'Mother vessel name (optional)'},
        from: {type: 'string', description: 'ISO date YYYY-MM-DD'},
        to: {type: 'string', description: 'ISO date YYYY-MM-DD'},
      },
      required: [],
    },
  },
  {
    name: 'openSidebar',
    description: 'Open a known form/sidebar after confirmation. Employees supports add and view.',
    parameters: {
      type: 'object',
      properties: {
        page: {type: 'string', description: 'employees'},
        action: {type: 'string', description: 'add | edit | view'},
        employee_mobile: {type: 'string', description: 'Required for edit/view'},
      },
      required: ['page', 'action'],
    },
  },
  {
    name: 'isBlockedQuestion',
    description: 'True when the question asks about infrastructure, credentials, code or deployment.',
    parameters: {
      type: 'object',
      properties: {question: {type: 'string', description: 'Raw user message'}},
      required: ['question'],
    },
  },
];

export function isBlockedQuestion(question: string): boolean {
  if (!question) return false;
  return BLOCKED_TOPIC_PATTERNS.some((entry) => entry.pattern.test(question));
}

/** Localised "I did not understand" reply — never a dead end. */
export function fallbackMessage(message: string): string {
  return /[\u0980-\u09FF]/.test(message)
    ? 'বুঝতে পারিনি। কর্মচারীর নাম/মোবাইল দিন, অথবা নিচের টেমপ্লেট ব্যবহার করুন।'
    : 'I could not understand that. Give an employee name or mobile, or use a template below.';
}

export type SuggestionIntent =
  | 'employee_search_results'
  | 'employee_profile'
  | 'cash_summary'
  | 'cash_summary_range'
  | 'attendance'
  | 'attendance_summary'
  | 'vessel'
  | 'vessel_program_info'
  | 'walkthrough'
  | 'mobile_did_you_mean'
  | 'blocked'
  | 'unsupported_date_range'
  | 'free_chat';

const SUGGESTIONS: Record<SuggestionIntent, string[]> = {
  employee_search_results: ['Open profile', 'Show cash history', 'Show attendance'],
  employee_profile: ['Add payment', 'Add attendance', 'Vessel history'],
  cash_summary: ['Last 5 transactions', 'This month only', 'Open ledger'],
  cash_summary_range: ['এই মাসের ক্যাশ সামারি', 'খতিয়ানে দেখুন', 'Add Hotel Bill..'],
  attendance: ['This month', 'Open attendance', 'Employee profile'],
  attendance_summary: ['কর্মচারী অনুযায়ী দেখুন', 'Add Attendance..', 'Search an employee..'],
  vessel: ['Open program', "Escort's profile", 'Release status'],
  vessel_program_info: ['Add Release Info..', 'Add lighter program..'],
  walkthrough: ['পরের ধাপ কী?', 'Cancel কিভাবে?', 'আবার শুরুতে'],
  mobile_did_you_mean: ['Use this number', 'Search by name'],
  blocked: ['Search an employee…', "Today's cash"],
  unsupported_date_range: ['This month', 'Open dated ledger'],
  free_chat: ['Search an employee…', "Today's cash", 'Add Attendance…'],
};

/** 2–4 follow-up chips for a response; unknown intents fall back to free chat. */
export function suggestionsForIntent(intent: SuggestionIntent | string | null | undefined): string[] {
  const list = SUGGESTIONS[(intent ?? 'free_chat') as SuggestionIntent] ?? SUGGESTIONS.free_chat;
  return list.slice(0, 4);
}

/** A confirmation is rendered once by the client, never also by the model. */
export function suppressesModelBubble(
  call: {name?: string; requires_confirmation?: boolean} | null | undefined,
): boolean {
  return Boolean(call && call.requires_confirmation
    && (call.name === 'navigateToPage' || call.name === 'openSidebar'));
}

export function intentForCall(call: AssistantFunctionCall | null | undefined): SuggestionIntent {
  if (!call) return 'free_chat';
  if (call.name === 'fetchCashSummary') return 'cash_summary';
  if (call.name === 'fetchAttendanceSummary') return 'attendance';
  if (call.name === 'fetchVesselSummary') return 'vessel';
  if (call.name === 'searchEmployee') return 'employee_search_results';
  if (call.name === 'isBlockedQuestion') return 'blocked';
  if (call.name === 'navigateToPage') {
    const page = String(call.arguments?.page ?? '');
    if (page.startsWith('cash') || page === 'review') return 'cash_summary';
    if (page === 'vessel') return 'vessel';
    if (page === 'attendance') return 'attendance';
  }
  return 'free_chat';
}

export const UNSUPPORTED_DATE_RANGE = [
  'দুঃখিত — নির্দিষ্ট তারিখ-রেঞ্জ (যেমন ১৫ আগস্ট – ২৩ সেপ্টেম্বর) এখনো সমর্থিত নয়,',
  'তাই আমি ভুল করে সর্বমোট হিসাব দেব না।',
  'আপাতত "আজ", "গতকাল", "এই মাস" বা "গত মাস" বলুন, অথবা তারিখ ফিল্টারসহ Cash Transactions পেইজ খুলুন।',
].join(' ');

const BN_DIGITS = '০১২৩৪৫৬৭৮৯';
const BN_MONTH = /(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)/;
const EN_MONTH = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

/**
 * True when the message contains an explicit calendar date (not a relative
 * word). The planner cannot turn these into filters yet, so the assistant must
 * refuse instead of quietly producing an all-time total.
 */
export function hasExplicitDateRange(message: string): boolean {
  const text = message.replace(/[০-৯]/g, (digit) => String(BN_DIGITS.indexOf(digit)));
  if (/\b\d{4}-\d{2}-\d{2}\b/.test(text)) return true;
  if (/\b\d{1,2}[/\-.]\d{1,2}([/\-.]\d{2,4})?\b/.test(text)) return true;
  return (BN_MONTH.test(text) || EN_MONTH.test(text)) && /\b\d{1,2}\b/.test(text);
}

/**
 * One clear identity only. A one-digit-off mobile (`mobile_fuzzy`) is a
 * suggestion the UI may show, never an automatic match.
 */
export function isConfidentMatch(match: {match_type?: string; similarity_score: number | string}, total: number): boolean {
  if (match.match_type === 'mobile_exact') return true;
  if (match.match_type === 'mobile_fuzzy' || match.match_type === 'mobile_partial') return false;
  return total === 1 && Number(match.similarity_score) >= 0.95;
}

export const PAGE_LABELS: Record<string, string> = {
  cash: 'Cash & Accounts',
  'cash/transactions': 'Cash transactions',
  vessel: 'Vessel Register',
  attendance: 'Attendance',
  employees: 'Employees',
  review: 'Review Queue',
};

export function buildNavigation(page: string, filters: Record<string, string> = {}) {
  const label = PAGE_LABELS[page] ?? page;
  let url: string;
  try {
    url = buildUrl(page, filters);
  } catch {
    const base = (URL_REGISTRY as unknown as Record<string, {base?: string}>)[page]?.base;
    if (!base) return null;
    url = Object.keys(filters).length ? `${base}?${new URLSearchParams(filters).toString()}` : base;
  }
  const described = Object.entries(filters).filter(([, value]) => value !== '')
    .map(([key, value]) => `${key}=${value}`).join(', ');
  return {url, description: described ? `${label} (${described})` : label};
}

// ── Deterministic planner ──────────────────────────────────────────────────

const TODAY = /(আজ|today)/i;
const YESTERDAY = /(গতকাল|yesterday)/i;
const THIS_MONTH = /(এই\s*মাস|চলতি\s*মাস|\bthis\s+month\b)/i;
const LAST_MONTH = /(গত\s*মাস|\blast\s+month\b)/i;

const ADD_EMPLOYEE = /((নতুন|add|new)\s*(এমপ্লোয়ি|কর্মী|employee))|(employee\s*(যোগ|add|create))/i;
const GUIDE = /(কিভাবে|কীভাবে|how\s+(do|can|to)|কি\s*ভাবে)/i;
const NAVIGATE = /(দেখাও|দেখতে\s*চাই|দেখাবেন|নিয়ে\s*যাও|নিয়ে\s*চলো|খোলো|খুলে\s*দাও|\bopen\b|\bshow\s+me\b|take\s+me|go\s+to|navigate)/i;
const CASH = /(ক্যাশ|cash|পেমেন্ট|payment|লেনদেন|transaction)/i;
const VESSEL = /(ভেসেল|জাহাজ|vessel|ship|প্রোগ্রাম|program)/i;
const ATTENDANCE = /(উপস্থিতি|হাজিরা|attendance|present)/i;
const EMPLOYEE = /(এমপ্লোয়ি|কর্মী|employee|staff|escort|এস্কর্ট)/i;
const MONEY_SUM = /(কত|মোট|মোট\s*কত|total|how\s+much|summary|সারসংক্ষেপ|পেয়েছে|নিয়েছে|received|paid)/i;
const SEARCH = /(খুঁজে|খোঁজ|search|find|কে\b|who\s+is)/i;

const MOBILE = /(?:\+?88)?(01[3-9]\d{8})/;

const STOPWORDS = new Set([
  'কত', 'মোট', 'টাকা', 'নিয়েছে', 'পেয়েছে', 'দেখাও', 'দেখতে', 'চাই', 'থেকে', 'তারিখ', 'আজ', 'গতকাল',
  'মাস', 'এই', 'গত', 'এবং', 'কর্মী', 'এমপ্লোয়ি', 'ভেসেল', 'জাহাজ', 'প্রোগ্রাম', 'ক্যাশ', 'পেমেন্ট',
  'লেনদেন', 'উপস্থিতি', 'হাজিরা', 'সময়', 'জন্য', 'একটি', 'সব', 'কিভাবে', 'কীভাবে', 'করব', 'করতে',
  'how', 'much', 'total', 'paid', 'payment', 'cash', 'show', 'me', 'the', 'from', 'to', 'of', 'and',
  'employee', 'employees', 'vessel', 'ship', 'program', 'programme', 'attendance', 'today', 'yesterday',
  'this', 'last', 'month', 'received', 'find', 'search', 'open', 'take', 'go', 'what', 'is', 'for',
  'payments', 'joined', 'many', 'vessels', 'programs', 'programmes', 'list', 'details', 'info',
  'information', 'give', 'please', 'একটু', 'দিন', 'আজকের', 'মোট', 'কর্মীদের', 'তালিকা',
]);

const MONTHS = /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/gi;
const BN_MONTHS = /(জানুয়ারি|ফেব্রুয়ারি|মার্চ|এপ্রিল|মে|জুন|জুলাই|আগস্ট|সেপ্টেম্বর|অক্টোবর|নভেম্বর|ডিসেম্বর)/g;

function isoDay(date: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date);
}

function addDays(day: string, delta: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + delta);
  return date.toISOString().slice(0, 10);
}

export function dateRange(message: string, now: Date = new Date()): {from?: string; to?: string} {
  const today = isoDay(now);
  if (TODAY.test(message)) return {from: today, to: today};
  if (YESTERDAY.test(message)) { const day = addDays(today, -1); return {from: day, to: day}; }
  if (THIS_MONTH.test(message)) return {from: `${today.slice(0, 7)}-01`, to: today};
  if (LAST_MONTH.test(message)) {
    const first = `${today.slice(0, 7)}-01`;
    const previousEnd = addDays(first, -1);
    return {from: `${previousEnd.slice(0, 7)}-01`, to: previousEnd};
  }
  return {};
}

/** Best-effort person/vessel name: drops dates, numbers, months and intent words. */
export function guessName(message: string): string {
  const cleaned = message
    .replace(MOBILE, ' ')
    .replace(MONTHS, ' ')
    .replace(BN_MONTHS, ' ')
    .replace(/[০-৯0-9]+/g, ' ')
    .replace(/[.,?!:;"'()\[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const kept = cleaned.split(' ')
    .filter((word) => word && !STOPWORDS.has(word.toLowerCase()))
    .map((word) => word.replace(/(ের|এর|কে|তে|এ)$/u, ''))
    .filter((word) => word.length >= 2);
  return kept.slice(0, 3).join(' ').trim();
}

/** Deterministic step-by-step guide text (no model facts involved). */
export function guideFor(message: string): string | null {
  if (ADD_EMPLOYEE.test(message) && GUIDE.test(message)) {
    return [
      'কর্মী যোগ করার ধাপ:',
      '১. /employees পেইজে যান।',
      '২. উপরে ডানে "Add New Employee" চাপুন।',
      '৩. সাইডবারে মোবাইল (employee ID), নাম, ডিউটি টাইপ, পদবি, জয়েন তারিখ ও বেতন দিন।',
      '৪. Save চাপুন — যোগ হলেই তালিকায় দেখা যাবে।',
      'চাইলে আমি ফর্মটি খুলে দিতে পারি।',
    ].join('\n');
  }
  return null;
}

export function planAssistantCall(message: string, now: Date = new Date()): AssistantFunctionCall | null {
  const text = message.trim();
  if (!text) return null;
  const mobile = text.match(MOBILE)?.[1];
  const employeeMobile = mobile ? `+88${mobile}` : undefined;
  const range = dateRange(text, now);
  const name = guessName(text);

  if (isBlockedQuestion(text)) {
    return {name: 'isBlockedQuestion', arguments: {question: text}};
  }
  // A date range the planner cannot parse must never turn into an unbounded
  // money summary. The chat route returns the explicit unsupported message.
  if (hasExplicitDateRange(text)) return null;

  // 1. Open the "Add employee" sidebar — but a "how do I add…" question is a guide.
  if (ADD_EMPLOYEE.test(text) && !GUIDE.test(text)) {
    return {
      name: 'openSidebar',
      arguments: {page: 'employees', action: 'add'},
      requires_confirmation: true,
    };
  }

  // 2. Navigate with filters.
  if (NAVIGATE.test(text)) {
    const filters = (extra: Record<string, string | undefined>) =>
      Object.fromEntries(Object.entries(extra).filter(([, value]) => Boolean(value))) as Record<string, string>;
    if (CASH.test(text)) {
      // The /cash dashboard ignores from/to; only /cash/transactions applies a
      // date range, so a dated request must target that page.
      const dated = Boolean(range.from || range.to);
      return {
        name: 'navigateToPage',
        arguments: {page: dated ? 'cash/transactions' : 'cash', filters: filters({
          employee_mobile: employeeMobile,
          from: dated ? range.from : undefined,
          to: dated ? range.to : undefined,
        })},
        requires_confirmation: true,
      };
    }
    if (VESSEL.test(text)) {
      return {
        name: 'navigateToPage',
        arguments: {page: 'vessel', filters: filters({
          escort_mobile: employeeMobile,
          q: employeeMobile ? undefined : name,
          from: range.from, to: range.to,
        })},
        requires_confirmation: true,
      };
    }
    if (ATTENDANCE.test(text)) {
      return {
        name: 'navigateToPage',
        arguments: {page: 'attendance', filters: filters({
          from: range.from, to: range.to, employee_mobile: employeeMobile,
        })},
        requires_confirmation: true,
      };
    }
    if (EMPLOYEE.test(text)) {
      const pageWords = /^(পেজ|পেইজ|page|তালিকা|list|directory)$/i;
      const query = employeeMobile ? undefined : (name && !pageWords.test(name) ? name : undefined);
      return {
        name: 'navigateToPage',
        arguments: {page: 'employees', filters: filters({q: query})},
        requires_confirmation: true,
      };
    }
  }

  // 3. Read-only summaries. A mobile filters directly; a name is resolved by a
  //    search first and the client runs the follow-up on the top match.
  if (employeeMobile) {
    if (MONEY_SUM.test(text) || CASH.test(text)) {
      return {name: 'fetchCashSummary', arguments: {employee_mobile: employeeMobile, from: range.from, to: range.to}};
    }
    if (ATTENDANCE.test(text)) {
      return {name: 'fetchAttendanceSummary', arguments: {employee_mobile: employeeMobile, from: range.from, to: range.to}};
    }
    if (VESSEL.test(text)) {
      return {name: 'fetchVesselSummary', arguments: {employee_mobile: employeeMobile, from: range.from, to: range.to}};
    }
  }

  if (MONEY_SUM.test(text) && name) {
    return {name: 'searchEmployee', arguments: {query: name}, follow_up: 'cash', range};
  }

  if (name) {
    const follow = ATTENDANCE.test(text) ? 'attendance' : VESSEL.test(text) ? 'vessel' : null;
    if (follow) return {name: 'searchEmployee', arguments: {query: name}, follow_up: follow, range};
  }

  // 4. Plain search by name or number.
  if (employeeMobile || SEARCH.test(text) || (name && text.split(/\s+/).length <= 3)) {
    return {name: 'searchEmployee', arguments: {query: employeeMobile || name}};
  }

  return null;
}
