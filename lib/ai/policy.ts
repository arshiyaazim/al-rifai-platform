// Pure AI communication policy. No database, network or framework imports.
//
// The language model may phrase an answer, but it never decides authorization.
// These functions are the deterministic policy boundary used by the tool layer
// and by tests.

export const AI_CATEGORIES = [
  'VERIFIED_ADMIN',
  'VERIFIED_EMPLOYEE',
  'JOB_APPLICANT',
  'EXISTING_CUSTOMER',
  'ESCORT_CLIENT',
  'UNKNOWN_CONTACT',
  'UNAUTHORIZED',
] as const;

export type AiCategory = (typeof AI_CATEGORIES)[number];
export type AiIntent =
  | 'PROMPT_INJECTION'
  | 'RECRUITMENT'
  | 'EMPLOYEE_SUPPORT'
  | 'ADMIN_QUERY'
  | 'ORDER_DRAFT'
  | 'MESSAGE_REQUEST'
  | 'UNKNOWN';

const INJECTION_PATTERNS = [
  /ignore (all )?(previous|prior|system) instructions?/i,
  /reveal (the )?(system|developer) prompt/i,
  /you are now (an? )?(admin|developer|system)/i,
  /show (all )?(employees|salaries|passwords|tokens)/i,
  /(drop|truncate|delete) table/i,
  /\bselect\s+\*\s+from\b/i,
  /(api key|password|session token|cookie|secret)/i,
  /jailbreak|prompt injection|developer mode/i,
];

export function normalizeText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\u0000/g, '').trim().slice(0, 8000) : '';
}

export function isPromptInjection(text: string): boolean {
  const value = normalizeText(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(value));
}

export function classifyIntent(text: string): AiIntent {
  const value = normalizeText(text).toLowerCase();
  if (!value) return 'UNKNOWN';
  if (isPromptInjection(value)) return 'PROMPT_INJECTION';
  if (/(mother\s*vessel|লাইটার\s*ভেসেল|lighter\s*vessel|master\s*mobile|destination|booking|অর্ডার)/i.test(value)) return 'ORDER_DRAFT';
  if (/(job|চাকরি|কাজ|নিয়োগ|recruit|apply|আবেদন|vacancy|ভ্যাকেন্সি|security guard|escort|supervisor|officer)/i.test(value)) return 'RECRUITMENT';
  if (/(draft|খসড়া|send|পাঠাও|forward|ফরওয়ার্ড|notify|জানাও)/i.test(value)) return 'MESSAGE_REQUEST';
  if (/(employee|কর্মী|cash|হিসাব|transaction|লেনদেন|vessel|জাহাজ|report|রিপোর্ট|show|দেখাও|salary|বেতন|advance|অগ্রিম|duty|ডিউটি)/i.test(value)) return 'ADMIN_QUERY';
  return 'UNKNOWN';
}

export function normalizePhone(value: unknown): string | null {
  const digits = String(value ?? '').replace(/[^0-9]/g, '');
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export function jidFromPhone(value: unknown): string | null {
  const phone = normalizePhone(value);
  return phone ? `${phone.slice(1)}@s.whatsapp.net` : null;
}

export function maskJid(value: string | null | undefined): string {
  const raw = String(value ?? '');
  if (!raw) return '—';
  const [local] = raw.split('@');
  if (local.length <= 6) return `${local.slice(0, 2)}…`;
  return `${local.slice(0, 4)}…${local.slice(-4)}`;
}

export function canUseAdminTools(category: AiCategory): boolean {
  return category === 'VERIFIED_ADMIN';
}

export function canAccessEmployee(
  category: AiCategory,
  ownEmployeeMobile: string | null,
  targetEmployeeMobile: string,
): boolean {
  if (category === 'VERIFIED_ADMIN') return true;
  if (category === 'VERIFIED_EMPLOYEE' && ownEmployeeMobile) {
    return normalizePhone(ownEmployeeMobile) === normalizePhone(targetEmployeeMobile);
  }
  return false;
}

export type JobCatalogItem = {
  key: string;
  label_bn: string;
  label_en: string;
  public_description: string;
};

export function publicJobMessage(items: JobCatalogItem[]): string {
  if (!items.length) {
    return 'AL-RIFA\'I-তে বর্তমানে প্রকাশযোগ্য পদ নেই। অফিসের সাথে যোগাযোগ করুন। / No public vacancy is currently published. Please contact the office.';
  }
  const lines = items.map((item, index) => `${index + 1}. ${item.label_en} / ${item.label_bn}`);
  return [
    'আসসালামু আলাইকুম। AL-RIFA\'I recruitment-এ আগ্রহের জন্য ধন্যবাদ।',
    'বর্তমানে প্রকাশিত পদসমূহ / Published role categories:',
    ...lines,
    'কোন পদে আগ্রহী, আপনার নাম, মোবাইল নম্বর ও অভিজ্ঞতা লিখুন।',
    'বর্তমান vacancy, বেতন, duty terms ও joining date অফিস নিশ্চিত করবে; AI কোনো নিশ্চিত চাকরি বা বেতনের প্রতিশ্রুতি দেয় না।',
    'Current vacancy, salary, duty terms and joining date must be confirmed by the office; the AI does not promise employment or pay.',
  ].join('\n');
}

export type ApplicantFields = {
  fullName: string | null;
  phone: string | null;
  jobCategory: string | null;
};

const CATEGORY_ALIASES: Array<[RegExp, string]> = [
  [/security\s*guard|সিকিউরিটি\s*গার্ড/i, 'security_guard'],
  [/security\s*supervisor|সিকিউরিটি\s*সুপারভাইজার/i, 'security_supervisor'],
  [/vessel\s*escort|ভেসেল\s*এস্কর্ট|এসকর্ট/i, 'vessel_escort'],
  [/survey\s*escort|সার্ভে\s*এস্কর্ট/i, 'survey_escort'],
  [/operations?\s*officer|অপারেশনস?\s*অফিসার/i, 'operations_officer'],
  [/marketing\s*officer|মার্কেটিং\s*অফিসার/i, 'marketing_officer'],
];

export function extractApplicant(text: string): ApplicantFields {
  const value = normalizeText(text);
  const phone = normalizePhone(value.match(/(?:\+?88)?0?1[3-9][0-9]{8}/)?.[0] ?? null);
  const nameMatch = value.match(/(?:my name is|name\s*[:=]|নাম\s*[:=]?|আমার নাম)\s*([A-Za-z\u0980-\u09FF][A-Za-z\u0980-\u09FF .'-]{1,60}?)(?=\.\s|\.$|\n|$)/i);
  const jobCategory = CATEGORY_ALIASES.find(([pattern]) => pattern.test(value))?.[1] ?? null;
  return {
    fullName: nameMatch?.[1]?.trim().slice(0, 120) ?? null,
    phone,
    jobCategory,
  };
}

export type OrderFields = {
  motherVessel: string | null;
  lighterVessel: string | null;
  masterMobile: string | null;
  destination: string | null;
  startDate: string | null;
  startShift: 'D' | 'N' | null;
};

export function extractOrderFields(text: string): OrderFields {
  const value = normalizeText(text);
  const pick = (pattern: RegExp): string | null => {
    const match = value.match(pattern);
    return match?.[1]?.trim().slice(0, 160) ?? null;
  };
  const dateMatch = value.match(/\b(20\d{2})[-/](\d{1,2})[-/](\d{1,2})\b/) ?? value.match(/\b(\d{1,2})[-/](\d{1,2})[-/](\d{2})\b/);
  let startDate: string | null = null;
  if (dateMatch) {
    if (dateMatch[1].length === 4) {
      startDate = `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}`;
    } else {
      startDate = `20${dateMatch[3]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[1].padStart(2, '0')}`;
    }
  }
  const shiftMatch = value.match(/\((D|N)\)|\b(day|night|দিন|রাত)\b/i);
  const shiftRaw = (shiftMatch?.[1] ?? shiftMatch?.[2] ?? '').toUpperCase();
  const startShift = shiftRaw === 'D' || shiftRaw === 'DAY' || shiftRaw === 'দিন' ? 'D'
    : shiftRaw === 'N' || shiftRaw === 'NIGHT' || shiftRaw === 'রাত' ? 'N' : null;
  return {
    motherVessel: pick(/(?:mother\s*vessel|মাদার\s*ভেসেল)\s*[:=-]\s*([^\n\r]+)/i),
    lighterVessel: pick(/(?:lighter\s*vessel|লাইটার\s*ভেসেল)\s*[:=-]\s*([^\n\r]+)/i),
    masterMobile: normalizePhone(pick(/(?:master\s*mobile|মাস্টার\s*মোবাইল)\s*[:=-]\s*([^\n\r]+)/i)),
    destination: pick(/(?:destination|গন্তব্য)\s*[:=-]\s*([^\n\r]+)/i),
    startDate,
    startShift,
  };
}

export function missingOrderFields(order: OrderFields): string[] {
  const missing: string[] = [];
  if (!order.motherVessel) missing.push('MOTHER_VESSEL');
  if (!order.lighterVessel) missing.push('LIGHTER_VESSEL');
  if (!order.masterMobile) missing.push('MASTER_MOBILE');
  return missing;
}

export function employeePrivateQuestion(text: string): boolean {
  return /(salary|বেতন|advance|অগ্রিম|payment|পেমেন্ট|duty|ডিউটি|assignment|রিলিজ|release|vessel|জাহাজ|lighter|মোবাইল|mobile|address|ঠিকানা)/i.test(text);
}

export function safePublicReply(): string {
  return 'আপনার অনুরোধটি সাধারণ তথ্যের বাইরে। ব্যক্তিগত বা আর্থিক তথ্যের জন্য অফিস যাচাই করে সহায়তা করবে। / This request needs office verification before any private information can be shared.';
}

export function employeeHelpReply(): string {
  return 'আপনার পরিচয় যাচাই করা যায়নি। অনুগ্রহ করে অফিসের সাথে যোগাযোগ করুন; ব্যক্তিগত বেতন বা ডিউটি তথ্য যাচাই ছাড়া দেওয়া হবে না। / Your identity could not be verified. Please contact the office; private salary or duty information cannot be shared without verification.';
}

export function adminHelpReply(): string {
  return [
    'Admin assistant commands (examples):',
    '- employee <name or mobile>',
    '- cash <YYYY-MM-DD> or cash <from> <to>',
    '- vessel <lighter or mother vessel>',
    '- draft message to <recipient>',
    'All answers are grounded in authorized database records; no automatic sending or posting is enabled.',
  ].join('\n');
}
