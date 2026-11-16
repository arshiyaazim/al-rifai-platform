/**
 * Grounded quick templates for the platform assistant.
 *
 * Every label and step below was verified on the running UI (v3.3.13):
 * employees sidebar, attendance modal, cash payment form, vessel sidebar and
 * the release review page. Templates are deterministic: the chat route matches
 * the exact label before any model call, so none of this text can drift.
 */
export type TemplateDomain = 'employees' | 'attendance' | 'cash' | 'vessel';

export type TemplateAction = {label: string; href: string};

export type AssistantTemplate = {
  id: string;
  label: string;
  domain: TemplateDomain;
  response: string;
  actions: TemplateAction[];
  followUps: string[];
};

const L = {
  searchEmployee: 'Search an employee…',
  addEmployee: 'Add New Employee…',
  uploadDocument: 'Upload a document…',
  addAttendance: 'Add Attendance…',
  attendanceSummary: 'Employee attendance summary',
  hotelBill: 'Add Hotel Bill…',
  todayCash: "Today's cash",
  cashSummary: 'Employee cash summary',
  cashReview: 'Pending cash review',
  addVessel: 'Add Lighter Program…',
  releaseInfo: 'Add Release Info…',
  vesselStatus: 'Vessel status by name',
} as const;

export const ASSISTANT_TEMPLATES: AssistantTemplate[] = [
  {
    id: 'employee-search',
    label: L.searchEmployee,
    domain: 'employees',
    response: 'কর্মচারীর নাম বা মোবাইল নম্বর লিখুন — বানান ভুল হলেও মিলিয়ে দেখব। Enter চাপলে র্যাঙ্ক করা ফলাফল দেখাবে।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    followUps: [L.addEmployee, L.cashSummary, L.uploadDocument],
  },
  {
    id: 'employee-add',
    label: L.addEmployee,
    domain: 'employees',
    response: 'Employees পেইজ → "Add New Employee" → নাম*, মোবাইল*, Designation, Duty Type, Date of Joining, Salary পূরণ করুন → Save। ছবি/ডকুমেন্ট পরে ডিটেইল সাইডবার থেকে যোগ করবেন।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    followUps: [L.searchEmployee, L.uploadDocument, L.addAttendance],
  },
  {
    id: 'employee-upload',
    label: L.uploadDocument,
    domain: 'employees',
    response: 'Employees পেইজ → কর্মচারী খুঁজুন → ডিটেইল সাইডবার খুলুন → Documents/ছবি আপলোড করুন (employee.manage প্রয়োজন)।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    followUps: [L.searchEmployee, L.addEmployee],
  },
  {
    id: 'attendance-add',
    label: L.addAttendance,
    domain: 'attendance',
    response: 'Attendance পেইজ → "Add New Attendance" → কর্মচারী (নাম/মোবাইল), Date*, Shift (D/N/FULL), Location, Client Name, Remarks দিন → Save।',
    actions: [{label: 'Open Attendance', href: '/attendance'}],
    followUps: [L.attendanceSummary, L.searchEmployee, L.hotelBill],
  },
  {
    id: 'attendance-summary',
    label: L.attendanceSummary,
    domain: 'attendance',
    response: 'আগে কর্মচারী খুঁজুন; প্রোফাইলের Attendance কার্ডে সারাংশ দেখুন, অথবা /attendance-এ গিয়ে From/To দিয়ে ফিল্টার করুন (URL ফিল্টার নেই, পেইজেই দিতে হবে)।',
    actions: [{label: 'Open Attendance', href: '/attendance'}],
    followUps: [L.searchEmployee, L.addAttendance],
  },
  {
    id: 'cash-hotel',
    label: L.hotelBill,
    domain: 'cash',
    response: 'Cash পেইজ → "Add New Payment" → যে কর্মচারীর নামে বিল তাকে সিলেক্ট করুন → Payout number, Method, Amount, Pay from দিন → Purpose-এ হোটেলের নাম লিখুন (যেমন: "নুরুর হোটেল — হোটেল বিল") → "Create (review)"। এন্ট্রি PENDING_REVIEW হিসেবে রিভিউ কিউতে যাবে।',
    actions: [
      {label: 'Open Cash', href: '/cash'},
      {label: 'Open Review Queue', href: '/review?category=CASH'},
    ],
    followUps: [L.todayCash, L.cashReview, L.cashSummary],
  },
  {
    id: 'cash-today',
    label: L.todayCash,
    domain: 'cash',
    response: 'আজকের লেনদেন সার্ভার-ফিল্টারসহ লেজারে দেখুন (ফিল্টার করা URL নিচে)। /cash পেইজ তারিখ ফিল্টার নেয় না।',
    actions: [],
    followUps: [L.cashSummary, L.cashReview, L.hotelBill],
  },
  {
    id: 'cash-summary',
    label: L.cashSummary,
    domain: 'cash',
    response: 'কর্মচারী খুঁজুন → প্রোফাইলে Cash কার্ডে সারাংশ, অথবা লেজারে employee_mobile ফিল্টার দিয়ে সব লেনদেন দেখুন।',
    actions: [{label: 'Open Ledger', href: '/cash/transactions'}],
    followUps: [L.searchEmployee, L.todayCash, L.hotelBill],
  },
  {
    id: 'cash-review',
    label: L.cashReview,
    domain: 'cash',
    response: 'PENDING_REVIEW ক্যাশ এন্ট্রিগুলো /review?category=CASH-এ Approve বা Decline করুন।',
    actions: [{label: 'Open Review', href: '/review?category=CASH'}],
    followUps: [L.todayCash, L.hotelBill],
  },
  {
    id: 'vessel-add',
    label: L.addVessel,
    domain: 'vessel',
    response: 'Vessel পেইজ → "New Program" → Mother Vessel*, Lighter Vessel*, Master Mobile, Start Date*, Shift, Escort (optional), Notes দিন → "Create program"।',
    actions: [{label: 'Open Vessel', href: '/vessel'}],
    followUps: [L.vesselStatus, L.releaseInfo, L.searchEmployee],
  },
  {
    id: 'vessel-release',
    label: L.releaseInfo,
    domain: 'vessel',
    response: '১. Vessel পেইজে যান ২. ভেসেলের নাম দিয়ে খুঁজুন ৩. প্রোগ্রাম রো-এর "View" আইকনে ক্লিক করুন ৪. সাইডবারে "Edit"-এ ক্লিক করুন ৫. End (তারিখ/শিফট) ও প্রয়োজনীয় তথ্য দিন ৬. "Save" চাপুন (release ফিল্ডের জন্য vessel.release দরকার)। স্লিপের ছবি থাকলে: Release পেইজ → OCR → তথ্য যাচাই → Approve।',
    actions: [
      {label: 'Open Vessel', href: '/vessel'},
      {label: 'Open Release', href: '/release'},
    ],
    followUps: [L.vesselStatus, L.addVessel],
  },
  {
    id: 'vessel-status',
    label: L.vesselStatus,
    domain: 'vessel',
    response: 'ভেসেলের নাম লিখুন — মাদার/লাইটার/এসকর্ট নাম ও মাস্টার মোবাইল ধরে খুঁজব (বাংলা নামও চলবে)।',
    actions: [{label: 'Open Vessel', href: '/vessel'}],
    followUps: [L.addVessel, L.releaseInfo],
  },
];

export const TEMPLATE_GROUPS: Array<{domain: TemplateDomain; title: string}> = [
  {domain: 'employees', title: '👤 কর্মচারী'},
  {domain: 'attendance', title: '📋 উপস্থিতি'},
  {domain: 'cash', title: '💰 ক্যাশ'},
  {domain: 'vessel', title: '🚢 ভেসেল'},
];

export function templatesForDomain(domain: TemplateDomain): AssistantTemplate[] {
  return ASSISTANT_TEMPLATES.filter((template) => template.domain === domain);
}

/** Normalises the ellipsis variants and whitespace before an exact-label check. */
function normaliseLabel(value: string): string {
  return value.trim().toLowerCase().replace(/[.…]+$/u, '').replace(/\s+/g, ' ');
}

export function matchTemplateByLabel(message: string): AssistantTemplate | null {
  const key = normaliseLabel(message);
  if (!key) return null;
  return ASSISTANT_TEMPLATES.find((template) => normaliseLabel(template.label) === key) ?? null;
}

function isoDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(now);
}

export function buildTodayLedgerUrl(now: Date = new Date()): string {
  const today = isoDay(now);
  return `/cash/transactions?from=${today}&to=${today}`;
}

export function buildMonthLedgerUrl(now: Date = new Date()): string {
  const today = isoDay(now);
  return `/cash/transactions?from=${today.slice(0, 7)}-01&to=${today}`;
}

/** Actions stay template data, except the two date-dependent ledger chips. */
export function resolveTemplateActions(template: AssistantTemplate, now: Date = new Date()): TemplateAction[] {
  if (template.id === 'cash-today') {
    return [
      {label: "Today's ledger", href: buildTodayLedgerUrl(now)},
      {label: 'This month', href: buildMonthLedgerUrl(now)},
    ];
  }
  return template.actions;
}
