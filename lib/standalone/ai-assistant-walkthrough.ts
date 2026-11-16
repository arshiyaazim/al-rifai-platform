/**
 * Conversational walkthrough knowledge base.
 *
 * Every label/step was verified on the live UI (2026-11-16). Answers are
 * deterministic so the model can never invent a button or a field.
 */
export type FlowId =
  | 'employees-create'
  | 'cash-payment'
  | 'attendance-add'
  | 'vessel-program'
  | 'vessel-release-edit'
  | 'release-ocr';

export type WalkthroughStep = {
  label: string;
  required?: boolean;
  input: string;
  value: string;
};

export type Walkthrough = {
  id: FlowId;
  title: string;
  entry: string;
  steps: WalkthroughStep[];
  save: string;
  cancel: string;
  mistakes: string;
  actions: Array<{label: string; href: string}>;
};

export const WALKTHROUGHS: Record<FlowId, Walkthrough> = {
  'employees-create': {
    id: 'employees-create',
    title: 'নতুন কর্মচারী যোগ',
    entry: '/employees পেইজে "Add New Employee" বাটনে ক্লিক করুন — ডান দিকে সাইডবার খুলবে।',
    steps: [
      {label: 'Employee Name', required: true, input: 'text', value: 'পূর্ণ নাম'},
      {label: 'Employee ID / Mobile', required: true, input: 'tel', value: '01XXXXXXXXX (এটাই employee ID)'},
      {label: 'Secondary Mobile', input: 'tel', value: 'ঐচ্ছিক'},
      {label: 'Family Member Mobile', input: 'tel', value: 'ঐচ্ছিক'},
      {label: 'Date of Joining', input: 'date', value: 'জয়েন তারিখ'},
      {label: 'National ID', input: 'text', value: 'NID নম্বর (ঐচ্ছিক)'},
      {label: 'Designation', input: 'select', value: 'পদবি'},
      {label: 'Duty Type', input: 'select', value: 'ডিউটির ধরন'},
      {label: 'State', input: 'select', value: 'ACTIVE রাখুন'},
      {label: 'Salary (৳)', input: 'number', value: 'মাসিক বেতন'},
    ],
    save: '"Save" চাপুন — সফল হলে "Employee created." টোস্ট দেখাবে। ছবি/ডকুমেন্ট পরে ডিটেইল সাইডবার থেকে আপলোড করবেন।',
    cancel: '"Cancel" চাপলে কিছুই সেভ হয় না এবং সাইডবার বন্ধ হয়।',
    mistakes: 'ভুল তথ্য সেভ হলে সরাসরি ডিলিট করা যায় না; সাইডবারে State → INACTIVE করে দিন এবং অ্যাডমিনকে জানান।',
    actions: [{label: 'Open Employees', href: '/employees'}],
  },
  'cash-payment': {
    id: 'cash-payment',
    title: 'ক্যাশ পেমেন্ট / হোটেল বিল',
    entry: '/cash পেইজে "Add New Payment" চাপুন — পেমেন্ট ফর্ম খুলবে।',
    steps: [
      {label: 'Employee Name / Mobile', required: true, input: 'lookup', value: 'যে কর্মচারীর নামে পেমেন্ট'},
      {label: 'Payout number', input: 'tel', value: 'টাকা যাবে যে নম্বরে'},
      {label: 'Method', input: 'select', value: 'bKash / Nagad / Rocket / Bank / Cash'},
      {label: 'Amount (BDT)', required: true, input: 'number', value: 'টাকার পরিমাণ'},
      {label: 'Pay from', input: 'select', value: 'যে অ্যাকাউন্ট থেকে যাবে'},
      {label: 'Purpose', input: 'text', value: 'হোটেল বিল হলে: "নুরুর হোটেল — হোটেল বিল"'},
    ],
    save: '"Create (review)" চাপুন — "Payment instruction created for review." দেখাবে। এন্ট্রি REVIEW অবস্থায় রিভিউ কিউতে যাবে এবং অ্যাডমিন Approve করার আগে কোনো টোটালে যোগ হবে না।',
    cancel: 'ফর্ম বন্ধ করলেই বাতিল — কিছুই সেভ হয় না।',
    mistakes: 'সেভ হয়ে গেলে ইউজার নিজে ডিলিট করতে পারবে না; ভুল হলে অ্যাডমিনকে /review?category=CASH থেকে Decline করতে বলুন — REVIEW এন্ট্রি হিসাবের বাইরে থাকে।',
    actions: [{label: 'Open Cash', href: '/cash'}, {label: 'Open Review Queue', href: '/review?category=CASH'}],
  },
  'attendance-add': {
    id: 'attendance-add',
    title: 'উপস্থিতি যোগ',
    entry: '/attendance পেইজে "Add New Attendance" চাপুন — মোডাল খুলবে।',
    steps: [
      {label: 'Employee Name / Mobile', required: true, input: 'lookup', value: 'কর্মচারী খুঁজে সিলেক্ট করুন'},
      {label: 'Date', required: true, input: 'date', value: 'উপস্থিতির তারিখ'},
      {label: 'Shift', required: true, input: 'select', value: 'D / N / FULL'},
      {label: 'Location', input: 'text', value: 'যেমন Chittagong Port / Mongla Ghat'},
      {label: 'Client Name', input: 'text', value: 'ক্লায়েন্টের নাম'},
      {label: 'Remarks', input: 'text', value: 'ঐচ্ছিক নোট'},
    ],
    save: '"Save" চাপুন — রেকর্ড যোগ হবে।',
    cancel: '"Cancel" চাপলে মোডাল বন্ধ হবে, কিছুই সেভ হবে না।',
    mistakes: 'ভুল সেভ হলে পেন্সিল (Edit) আইকনে ঠিক করুন; ডিলিট শুধু attendance.manage অনুমতিতে অ্যাডমিন করতে পারেন।',
    actions: [{label: 'Open Attendance', href: '/attendance'}],
  },
  'vessel-program': {
    id: 'vessel-program',
    title: 'নতুন লাইটার প্রোগ্রাম',
    entry: '/vessel পেইজে "New Program" চাপুন।',
    steps: [
      {label: 'Mother Vessel', required: true, input: 'text', value: 'মাদার ভেসেলের নাম'},
      {label: 'Lighter Vessel', required: true, input: 'text', value: 'লাইটারের নাম'},
      {label: 'Master Mobile', input: 'tel', value: 'মাস্টারের নম্বর'},
      {label: 'Start Date', required: true, input: 'date', value: 'শুরুর তারিখ'},
      {label: 'Shift', input: 'select', value: 'D / N'},
      {label: 'Escort Name (optional)', input: 'text', value: 'এসকর্টের নাম'},
      {label: 'Escort Mobile (optional)', input: 'tel', value: 'এসকর্টের নম্বর'},
      {label: 'Notes', input: 'text', value: 'ঐচ্ছিক'},
    ],
    save: '"Create program" চাপুন — প্রোগ্রাম তালিকায় যোগ হবে।',
    cancel: '"Cancel" চাপলে কিছুই তৈরি হবে না।',
    mistakes: 'ভুল প্রোগ্রাম ডিলিট শুধু vessel.command অনুমতিতে হয়; না পারলে অ্যাডমিনকে জানান।',
    actions: [{label: 'Open Vessel', href: '/vessel'}],
  },
  'vessel-release-edit': {
    id: 'vessel-release-edit',
    title: 'রিলিজ তথ্য যোগ (ভেসেল)',
    entry: '/vessel পেইজে ভেসেলের নাম দিয়ে খুঁজুন, তারপর প্রোগ্রাম রো-এর "View" আইকনে ক্লিক করুন।',
    steps: [
      {label: 'View', required: true, input: 'button', value: 'প্রোগ্রাম রো-এর আইকন — সাইডবার খুলবে'},
      {label: 'Edit', required: true, input: 'button', value: 'সাইডবারের Edit বাটন (vessel.submit দরকার)'},
      {label: 'End', required: true, input: 'date + select', value: 'রিলিজের তারিখ ও শিফট (—/D/N)'},
      {label: 'Notes', input: 'text', value: 'প্রয়োজনে নোট'},
    ],
    save: '"Save" চাপুন — End তারিখ ও শিফট সেভ হবে। Release ফিল্ডের জন্য vessel.release অনুমতি লাগে।',
    cancel: '"Cancel" চাপলে এডিট বাতিল হবে, আগের মান অপরিবর্তিত থাকবে।',
    mistakes: 'শেষ তারিখ ভুল হলে আবার Edit করে ঠিক করুন; প্রোগ্রাম ডিলিট শুধু vessel.command-এ।',
    actions: [{label: 'Open Vessel', href: '/vessel'}, {label: 'Open Release', href: '/release'}],
  },
  'release-ocr': {
    id: 'release-ocr',
    title: 'রিলিজ স্লিপ OCR',
    entry: '/release পেইজে স্লিপের তালিকা দেখুন।',
    steps: [
      {label: 'Image', input: 'link', value: 'স্লিপের ছবি খুলে দেখুন'},
      {label: 'OCR', required: true, input: 'button', value: 'ছবি পড়ে ফিল্ডগুলো বসিয়ে দেবে'},
      {label: 'যাচাই', required: true, input: 'manual', value: 'নাম, তারিখ, শিফট মিলিয়ে দেখুন'},
      {label: 'Approve / Decline', required: true, input: 'button', value: 'ঠিক থাকলে Approve, নাহলে Decline'},
    ],
    save: '"Approve" চাপলে রিলিজ প্রোগ্রামে প্রয়োগ হবে ("Release applied.")।',
    cancel: 'ভুল হলে Decline করুন — স্লিপ বাতিল হবে, প্রোগ্রাম অপরিবর্তিত থাকবে।',
    mistakes: 'OCR কখনো অনুমান করে না; ফাঁকা/ভুল ফিল্ড থাকলে Decline করে সঠিক তথ্য দিন।',
    actions: [{label: 'Open Release', href: '/release'}],
  },
};

export const FLOW_IDS = Object.keys(WALKTHROUGHS) as FlowId[];

export function flowFromContext(context: unknown): FlowId | null {
  if (!context) return null;
  const value = typeof context === 'string'
    ? context
    : typeof context === 'object' && context !== null && 'flow' in context
      ? String((context as {flow?: unknown}).flow ?? '')
      : '';
  return (FLOW_IDS as string[]).includes(value) ? (value as FlowId) : null;
}

const NEXT = ['পরের ধাপ কী?', 'Cancel কিভাবে?', 'আবার শুরুতে'];
const SAVE = ['সেভ হচ্ছে না', 'Cancel কিভাবে?', 'পরের ধাপ কী?'];

export type WalkthroughAnswer = {text: string; context: FlowId; suggestions: string[]};

export function walkthroughAnswer(flow: FlowId, message: string): WalkthroughAnswer {
  const guide = WALKTHROUGHS[flow];
  const text = message.toLowerCase();
  const steps = guide.steps.map((step, index) =>
    `${index + 1}. ${step.label}${step.required ? ' *' : ''} — ${step.value}`).join('\n');

  if (/(ক্যান্সেল|cancel|বাতিল|ফিরে)/i.test(text)) {
    return {text: `${guide.title}: ${guide.cancel}`, context: flow, suggestions: NEXT};
  }
  if (/(ডিলিট|delete|মুছে|মুছব)/i.test(message)) {
    return {text: `${guide.title}: ${guide.mistakes}`, context: flow, suggestions: ['Cancel কিভাবে?', 'পরের ধাপ কী?']};
  }
  if (/(সেভ|save|হচ্ছে না|error|এরর|সমস্যা)/i.test(message)) {
    return {text: `${guide.title}: ${guide.save}\n${guide.mistakes}`, context: flow, suggestions: SAVE};
  }
  if (/(আপলোড|upload|ছবি|ডকুমেন্ট|document)/i.test(message)) {
    return {
      text: flow === 'release-ocr'
        ? `${guide.title}: ${guide.steps[1].value} — ছবি পড়ার পর ${guide.steps[2].value}, শেষে Approve/Decline।`
        : 'ছবি/ডকুমেন্ট: Employees → কর্মচারী খুঁজুন → ডিটেইল সাইডবার → Documents/ছবি আপলোড। নতুন কর্মচারীর ক্ষেত্রে আগে "Save" করে কর্মচারী তৈরি করুন।',
      context: flow,
      suggestions: NEXT,
    };
  }
  if (/(পরের|next|এখন কী|কিরুম|কি করব)/i.test(message)) {
    return {text: `${guide.title} — ধাপগুলো:\n${steps}\n\n${guide.save}`, context: flow, suggestions: NEXT};
  }
  return {
    text: `${guide.title}\n${guide.entry}\n${steps}\n\n${guide.save}`,
    context: flow,
    suggestions: NEXT,
  };
}

/** Keyword fallback when the client has no context token yet. */
export function flowFromMessage(message: string): FlowId | null {
  if (/(হোটেল|hotel|পেমেন্ট|payment|ক্যাশ এন্ট্রি)/i.test(message)) return 'cash-payment';
  if (/(উপস্থিতি|attendance|হাজিরা)/i.test(message)) return 'attendance-add';
  if (/(রিলিজ|release|স্লিপ|slip|ocr)/i.test(message)) return 'release-ocr';
  if (/(লাইটার|ভেসেল|vessel|প্রোগ্রাম|program)/i.test(message)) return 'vessel-program';
  if (/(কর্মচারী যোগ|employee|এমপ্লোয়ি|নতুন কর্মী)/i.test(message)) return 'employees-create';
  return null;
}

/** Compact rules injected into the LLM fallback prompt (no internals). */
export function walkthroughDigest(): string {
  return [
    'FLOW RULES (verified):',
    '- Cash "Create (review)" saves state REVIEW and lands in /review?category=CASH; REVIEW rows are excluded from totals until an admin approves.',
    '- Users cannot delete saved entries. A wrong cash entry stays in REVIEW; ask an admin to Decline it from the review queue.',
    '- Employee docs/photos are uploaded later from the detail sidebar, not in the create form.',
    '- Vessel release info: row View → Edit → End date+shift → Save (needs vessel.release). Release slips use OCR → verify → Approve/Decline.',
    '- Attendance is edited with the row pencil; deletion needs attendance.manage.',
    'Template flows: ' + FLOW_IDS.join(', ') + '.',
  ].join('\n');
}
