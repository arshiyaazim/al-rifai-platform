#!/usr/bin/env node
// Read-only daily audit of the escort pipeline. It never writes and never sends
// WhatsApp messages; the cron wrapper decides whether to report.
//
// Checks:
//   - client order-like messages with no matching program;
//   - office assignment templates with no active covering program;
//   - active duplicate rows (same vessel/master/escort/date/shift);
//   - active programs with an escort but no open assignment;
//   - open assignments on closed programs;
//   - closed programs without an end date.

import {loadEnv} from '../lib/env.mjs';
import {rows} from '../lib/standalone/db.ts';
import {parseEscortOrder} from '../lib/escort-intake-candidate.mjs';
import {businessDay} from '../lib/vessel-match.ts';
import {orderIntakeShift} from '../lib/order-intake-shift.ts';

loadEnv();

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const daysArg = args.find((arg) => arg.startsWith('--days='));
const DAYS = Math.min(Math.max(Number(daysArg?.split('=')[1] ?? 2), 1), 30);
const OFFICE_GROUP = process.env.ALRIFAI_OFFICE_GROUP_JID || '120363426895117693@g.us';
const CLIENT_CHATS = [
  '8801670535255@s.whatsapp.net', '166082241384593@lid',
  '8801836743754@s.whatsapp.net', '155508031901923@lid',
  '8801757622300@s.whatsapp.net', '243103839576097@lid',
  '8801923008877@s.whatsapp.net', '94107162673310@lid',
];
const ACTIVE = new Set(['DRAFT', 'ASSIGNED', 'CONFIRMED']);
const normalise = (value: unknown) => String(value ?? '')
  .replace(/^m\.?\s*v\.?\s*/i, '')
  .replace(/[^\p{L}\p{N}]/gu, '')
  .toLowerCase();
const digits = (value: unknown) => String(value ?? '').replace(/[^0-9]/g, '').replace(/^880(1[3-9]\d{8})$/, '0$1');
const serialOf = (key: string) => key.match(/(\d+)$/)?.[1] ?? '';
const baseOf = (key: string) => key.replace(/\d+$/, '');
const distance = (a: string, b: string) => {
  if (a === b) return 0;
  const prev = Array.from({length: b.length + 1}, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const temp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = temp;
    }
  }
  return prev[b.length];
};
const vesselLike = (a: string, b: string) => {
  if (!a || !b) return false;
  if (a === b) return true;
  const sa = serialOf(a);
  const sb = serialOf(b);
  if (sa && sb && sa !== sb) return false;
  return distance(baseOf(a), baseOf(b)) <= 3;
};
const mobileLike = (a: string, b: string) => {
  if (!a || !b || a === b) return true;
  if (a.length !== 11 || b.length !== 11) return false;
  let diff = 0;
  for (let i = 0; i < 11; i++) if (a[i] !== b[i]) diff++;
  return diff <= 2;
};

const programs = await rows<{
  id: string; mother_vessel: string; lighter_vessel: string; master_mobile: string | null;
  escort_mobile: string | null; state: string; start_date: string; end_date: string | null;
}>(
  `SELECT id, mother_vessel, lighter_vessel, master_mobile, escort_mobile, state,
          start_date::text AS start_date, end_date::text AS end_date
     FROM programs WHERE state <> 'VOIDED'`,
);
const matching = (mother: string, lighter: string, master: string) =>
  programs.filter((program) =>
    vesselLike(normalise(program.mother_vessel), mother)
    && vesselLike(normalise(program.lighter_vessel), lighter)
    && (!master || mobileLike(digits(program.master_mobile), master)));

const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
const clientMessages = await rows<{message_id: string; chat_jid: string; source_timestamp: string; text_content: string | null}>(
  `SELECT message_id, chat_jid, source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = 'wa-01' AND direction = 'INCOMING'
      AND chat_jid = ANY($1::text[]) AND source_timestamp >= $2::timestamptz
    ORDER BY source_timestamp`,
  [CLIENT_CHATS, since],
);
const missingOrders: Array<{messageId: string; at: string; mother: string; lighter: string; master: string}> = [];
for (const message of clientMessages) {
  const date = businessDay(message.source_timestamp) || message.source_timestamp.slice(0, 10);
  let blocks: Array<{fields?: Record<string, unknown>}> = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate: date}) as Array<{fields?: Record<string, unknown>}>;
  } catch {
    blocks = [];
  }
  for (const block of blocks) {
    const fields = block.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    const master = digits(fields.masterMobile);
    if (!mother || !lighter || !master) continue;
    const found = programs.some((program) =>
      vesselLike(normalise(program.mother_vessel), mother)
      && vesselLike(normalise(program.lighter_vessel), lighter)
      && mobileLike(digits(program.master_mobile), master));
    if (!found) missingOrders.push({
      messageId: message.message_id, at: message.source_timestamp,
      mother: String(fields.motherVessel), lighter: String(fields.lighterVessel), master: String(fields.masterMobile),
    });
  }
}

const officeMessages = await rows<{message_id: string; source_timestamp: string; text_content: string | null}>(
  `SELECT message_id, source_timestamp::text AS source_timestamp, text_content
     FROM whatsapp_messages
    WHERE account_id = 'wa-01' AND chat_jid = $1 AND direction = 'INCOMING'
      AND source_timestamp >= $2::timestamptz
      AND text_content ~* 'mother\\s*vessel'
    ORDER BY source_timestamp`,
  [OFFICE_GROUP, since],
);
const missingAssignments: Array<{messageId: string; at: string; mother: string; lighter: string}> = [];
for (const message of officeMessages) {
  const date = businessDay(message.source_timestamp) || message.source_timestamp.slice(0, 10);
  let blocks: Array<{fields?: Record<string, unknown>; assignmentDate?: string | null; shift?: string | null}> = [];
  try {
    blocks = parseEscortOrder(String(message.text_content ?? ''), {messageDate: date}) as typeof blocks;
  } catch {
    blocks = [];
  }
  for (const block of blocks) {
    const fields = block.fields ?? {};
    const mother = normalise(fields.motherVessel);
    const lighter = normalise(fields.lighterVessel);
    if (!mother || !lighter) continue;
    const dutyDate = block.assignmentDate && /^\d{4}-\d{2}-\d{2}$/.test(block.assignmentDate)
      ? block.assignmentDate : date;
    const cover = matching(mother, lighter, digits(fields.masterMobile)).filter((program) =>
      ACTIVE.has(program.state)
      && String(program.start_date) <= dutyDate
      && (!program.end_date || dutyDate <= String(program.end_date)));
    if (!cover.length) missingAssignments.push({
      messageId: message.message_id, at: message.source_timestamp,
      mother: String(fields.motherVessel), lighter: String(fields.lighterVessel),
    });
  }
}

const activeDuplicates = await rows<{n: string; detail: string}>(
  `SELECT count(*)::text AS n,
          string_agg(mother_vessel || ' / ' || lighter_vessel || ' ' || start_date::text, ' ; ') AS detail
     FROM programs
    WHERE state IN ('DRAFT','ASSIGNED','CONFIRMED')
    GROUP BY lower(regexp_replace(mother_vessel,'[^a-zA-Z0-9]','','g')),
             lower(regexp_replace(lighter_vessel,'[^a-zA-Z0-9]','','g')),
             regexp_replace(coalesce(master_mobile,''),'[^0-9]','','g'),
             regexp_replace(coalesce(escort_mobile,''),'[^0-9]','','g'),
             start_date, start_shift
   HAVING count(*) > 1`,
);
const escortWithoutAssignment = await rows<{n: string}>(
  `SELECT count(*)::text AS n FROM programs p
    WHERE p.state IN ('ASSIGNED','CONFIRMED') AND p.escort_mobile IS NOT NULL
      AND p.end_date IS NULL
      AND NOT EXISTS (SELECT 1 FROM program_assignments a WHERE a.program_id=p.id AND a.end_date IS NULL)`,
);
const assignmentOnClosed = await rows<{n: string}>(
  `SELECT count(*)::text AS n FROM programs p JOIN program_assignments a ON a.program_id=p.id
    WHERE p.state IN ('RELEASED','WITHDRAWN','VOIDED') AND a.end_date IS NULL`,
);
const closedWithoutEnd = await rows<{n: string}>(
  `SELECT count(*)::text AS n FROM programs
    WHERE state IN ('RELEASED','WITHDRAWN') AND end_date IS NULL`,
);

const result = {
  days: DAYS,
  client_messages: clientMessages.length,
  missing_orders: missingOrders.length,
  missing_order_examples: missingOrders.slice(0, 5),
  office_assignments: officeMessages.length,
  missing_assignments: missingAssignments.length,
  missing_assignment_examples: missingAssignments.slice(0, 5),
  active_duplicates: Number(activeDuplicates[0]?.n ?? 0),
  duplicate_examples: activeDuplicates.slice(0, 5).map((row) => row.detail),
  escort_without_assignment: Number(escortWithoutAssignment[0]?.n ?? 0),
  assignment_on_closed: Number(assignmentOnClosed[0]?.n ?? 0),
  closed_without_end: Number(closedWithoutEnd[0]?.n ?? 0),
};
const anomalies = result.missing_orders + result.missing_assignments
  + result.active_duplicates + result.escort_without_assignment
  + result.assignment_on_closed + result.closed_without_end;

if (JSON_MODE) {
  console.log(JSON.stringify({...result, anomalies}, null, 2));
} else if (!anomalies) {
  console.log(`এসকর্ট অডিট (গত ${DAYS} দিন): সব ঠিক আছে। ক্লায়েন্ট মেসেজ ${result.client_messages}টি, অফিস অ্যাসাইনমেন্ট ${result.office_assignments}টি—কোনো নতুন অর্ডার বা অ্যাসাইনমেন্ট বাদ পড়েনি, ডুপ্লিকেট/অ্যাসাইনমেন্ট গরমিল নেই।`);
} else {
  console.log(`এসকর্ট অডিট (গত ${DAYS} দিন): মোট ${anomalies}টি নজর করার বিষয়।\n` +
    `• প্রোগ্রামহীন অর্ডার: ${result.missing_orders}\n` +
    `• অফিস অ্যাসাইনমেন্ট মেলেনি: ${result.missing_assignments}\n` +
    `• সক্রিয় ডুপ্লিকেট: ${result.active_duplicates}\n` +
    `• এসকর্ট আছে কিন্তু অ্যাসাইনমেন্ট নেই: ${result.escort_without_assignment}\n` +
    `• বন্ধ প্রোগ্রামে খোলা অ্যাসাইনমেন্ট: ${result.assignment_on_closed}\n` +
    `• বন্ধ কিন্তু End নেই: ${result.closed_without_end}\n` +
    `বিস্তারিত দরকার হলে বলুন, আমি মেসেজ/রো দেখাবো।`);
}
