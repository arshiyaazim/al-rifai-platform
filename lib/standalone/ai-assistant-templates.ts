/**
 * Grounded quick templates for the platform assistant (E2.5: exactly 7, flat).
 *
 * Every label and step below was verified on the running UI (v3.3.13/v3.3.14).
 * Templates are deterministic: the chat route matches the exact label before
 * any model call and returns `response`, `actions`, `context` and `followUps`.
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
  context: string | null;
};

export const ASSISTANT_TEMPLATES: AssistantTemplate[] = [
  {
    id: 'employee-search',
    label: 'Search an employee..',
    domain: 'employees',
    response: 'কর্মচারীর নাম বা মোবাইল নম্বর লিখুন — বানান ভুল হলেও মিলিয়ে দেখব। Enter চাপলে র‍্যাঙ্ক করা ফলাফল দেখাবে।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    followUps: ['Add New Employee..', "Today's cash..", 'Add Attendance..'],
    context: null,
  },
  {
    id: 'employee-add',
    label: 'Add New Employee..',
    domain: 'employees',
    response: 'Employees পেইজ → "Add New Employee" → নাম*, মোবাইল*, Designation, Duty Type, Date of Joining, Salary পূরণ করুন → Save ("Employee created.")। ছবি/ডকুমেন্ট পরে ডিটেইল সাইডবার থেকে যোগ করবেন।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    followUps: ['Search an employee..', 'Add Attendance..'],
    context: 'employees-create',
  },
  {
    id: 'cash-hotel',
    label: 'Add Hotel Bill..',
    domain: 'cash',
    response: 'Cash পেইজ → "Add New Payment" → যে কর্মচারীর নামে বিল তাকে সিলেক্ট করুন → Payout number, Method, Amount, Pay from দিন → Purpose-এ হোটেলের নাম লিখুন (যেমন: "নুরুর হোটেল — হোটেল বিল") → "Create (review)"। এন্ট্রি REVIEW হিসেবে রিভিউ কিউতে যাবে এবং Approve না হওয়া পর্যন্ত টোটালে যোগ হবে না।',
    actions: [
      {label: 'Open Cash', href: '/cash'},
      {label: 'Open Review Queue', href: '/review?category=CASH'},
    ],
    followUps: ['এই মাসের ক্যাশ সামারি', 'Add lighter program..', 'Add Attendance..'],
    context: 'cash-payment',
  },
  {
    id: 'vessel-add',
    label: 'Add lighter program..',
    domain: 'vessel',
    response: 'Vessel পেইজ → "New Program" → Mother Vessel*, Lighter Vessel*, Master Mobile, Start Date*, Shift, Escort (optional), Notes দিন → "Create program"।',
    actions: [{label: 'Open Vessel', href: '/vessel'}],
    followUps: ['Add Release Info..', 'Search an employee..'],
    context: 'vessel-program',
  },
  {
    id: 'attendance-add',
    label: 'Add Attendance..',
    domain: 'attendance',
    response: 'Attendance পেইজ → "Add New Attendance" → কর্মচারী (নাম/মোবাইল), Date*, Shift (D/N/FULL), Location, Client Name, Remarks দিন → Save।',
    actions: [{label: 'Open Attendance', href: '/attendance'}],
    followUps: ['এই মাসের হাজিরা সামারি', 'Search an employee..', 'Add Hotel Bill..'],
    context: 'attendance-add',
  },
  {
    id: 'vessel-release',
    label: 'Add Release Info..',
    domain: 'vessel',
    response: '১. Vessel পেইজে যান ২. ভেসেলের নাম দিয়ে খুঁজুন ৩. প্রোগ্রাম রো-এর "View" আইকনে ক্লিক করুন ৪. সাইডবারে "Edit"-এ ক্লিক করুন ৫. End (তারিখ/শিফট) ও প্রয়োজনীয় তথ্য দিন ৬. "Save" চাপুন (release ফিল্ডের জন্য vessel.release দরকার)। স্লিপের ছবি থাকলে: Release পেইজ → OCR → তথ্য যাচাই → Approve।',
    actions: [
      {label: 'Open Vessel', href: '/vessel'},
      {label: 'Open Release', href: '/release'},
    ],
    followUps: ['Add lighter program..', 'Add Hotel Bill..'],
    context: 'vessel-release-edit',
  },
  {
    id: 'cash-today',
    label: "Today's cash..",
    domain: 'cash',
    response: 'আজকের লেনদেন সার্ভার-ফিল্টারসহ লেজারে দেখুন (নিচের চিপ)। /cash পেইজ তারিখ ফিল্টার নেয় না।',
    actions: [],
    followUps: ['এই মাসের ক্যাশ সামারি', 'Add Hotel Bill..', 'Search an employee..'],
    context: null,
  },
];

/** Normalises ellipsis variants and whitespace before an exact-label check. */
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
