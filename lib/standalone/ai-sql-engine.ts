/**
 * Read-only NL→SQL engine (E2.7).
 *
 * Design note: the provider transport has no tool/function channel, and blindly
 * executing SQL emitted by a model would weaken the read-only guarantee. The
 * "generator" therefore maps natural language to a *typed plan* and renders one
 * parameterised SELECT per plan. The guard, the 5s read-only transaction and the
 * physical read-only DB pool make writes impossible even if a plan were wrong.
 *
 * Internal names (tables/columns) never leave this module: they are not shown to
 * the user and only appear in server-side SQL.
 */
import {parseDateExpression, toBengaliDigits, formatBnDate} from './ai-assistant-dates.ts';
import {transliterate} from './transliterate.ts';
import {encodeContext, type AssistantContext} from './ai-assistant-context.ts';
import type {QueryResultRow} from 'pg';
import {pool} from './db.ts';

export {SCHEMA_CONTEXT} from './ai-assistant-prompt.ts';

export type SqlDomain = 'employees' | 'attendance' | 'cash' | 'vessel';
export type SqlKind =
  | 'cash_total' | 'cash_top' | 'vessel_escorts' | 'attendance_list'
  | 'employee_list' | 'cash_attendance_join';

export type SqlPlan = {
  kind: SqlKind;
  domain: SqlDomain;
  from?: string;
  to?: string;
  label?: string;
  term?: string;
};

const FORBIDDEN = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|GRANT|REVOKE|CREATE|EXECUTE|CALL|COPY|LOCK|VACUUM|ANALYZE|REFRESH|MERGE|COMMENT|SECURITY|OWNER|RENAME|SET|RESET|DISCARD|IMPORT)\b/i;
const SYSTEM_CATALOG = /\b(pg_catalog|information_schema|pg_stat|pg_shadow|pg_authid|pg_user|pg_roles|pg_settings)\b/i;

/** Boolean safety check. Comments are rejected so keywords cannot be hidden. */
export function validateSQL(query: string): boolean {
  const sql = String(query ?? '').trim();
  if (!sql) return false;
  if (/--|\/\*|\*\//.test(sql)) return false;
  if (FORBIDDEN.test(sql)) return false;
  if (SYSTEM_CATALOG.test(sql)) return false;
  if (!/^(SELECT|WITH)\b/i.test(sql)) return false;
  if (sql.includes(';')) {
    // a single trailing semicolon is fine, anything after it is not
    const body = sql.replace(/;\s*$/, '');
    if (body.includes(';')) return false;
  }
  if (/\b(WITH)\b/i.test(sql) && !/\bSELECT\b/i.test(sql)) return false;
  return true;
}

/** Adds a LIMIT when the top-level query has none (50 by default). */
export function hardenSQL(query: string, limit = 50): string {
  const sql = String(query ?? '').trim().replace(/;\s*$/, '');
  if (!validateSQL(sql)) throw new Error('SQL_REJECTED');
  if (/\blimit\s+\d+/i.test(sql)) return sql;
  return `${sql}\nLIMIT ${Math.min(Math.max(Number(limit) || 50, 1), 200)}`;
}

/** Bengali label for a date range, without exposing storage details. */
function labelFor(from?: string, to?: string): string {
  if (!from || !to) return 'সর্বকালের';
  return from === to ? formatBnDate(from) : `${formatBnDate(from)} – ${formatBnDate(to)}`;
}

function vesselTerm(message: string): string {
  const cleanup = (value: string) => value
    .replace(/(^|\s)(সব|all|এর|ের|টি|টা|গুলো|গুলোও|the)(\s|$)/gi, ' ')
    .replace(/\s+/g, ' ').trim().slice(0, 60);
  const before = message.match(/([\p{L}\p{N}][\p{L}\p{N}.\- ]{1,30}?)\s*(?:মাদার|মাদারের|mother)/u);
  if (before) return cleanup(before[1]);
  const after = message.match(/(?:মাদার|mother)\s+([\p{L}\p{N}][\p{L}\p{N}.\- ]{1,30})/u);
  if (after) {
    const stop = after[1].search(/\s(সব|all|এর|ের|এসকর্ট|escort)\b/i);
    return cleanup(stop > 0 ? after[1].slice(0, stop) : after[1]);
  }
  return '';
}

function isMoneyWord(message: string): boolean {
  return /(টাকা|পেইড|paid|পেমেন্ট|payment|খরচ|বেতন|salary|টাকার|ক্যাশ|cash)/i.test(message);
}

/** NL → plan (deterministic; returns null when the question is not data-shaped). */
export function buildSqlPlan(message: string, now: Date = new Date(), prior?: AssistantContext | null): SqlPlan | null {
  const text = String(message ?? '');
  const parsed = parseDateExpression(text, now);
  let from = parsed?.from;
  let to = parsed?.to;
  // Context: "তার আগের দিনেরটা" shifts the remembered single day back by one.
  if (!parsed && prior?.from && prior?.to && /(আগের\s*দিন|previous\s+day|আগেরটা)/i.test(text)) {
    const base = new Date(`${prior.from}T00:00:00Z`);
    base.setUTCDate(base.getUTCDate() - 1);
    const day = base.toISOString().slice(0, 10);
    from = day; to = prior.from === prior.to ? day : day;
  }

  const attendance = /(উপস্থিত|হাজিরা|attendance|absent|অনুপস্থিত)/i.test(text);
  const cash = isMoneyWord(text);
  const vessel = /(ভেসেল|vessel|প্রোগ্রাম|program|মাদার|mother|লাইটার|lighter|এসকর্ট|escort)/i.test(text);
  const employees = /(এমপ্লোয়ি|employee|কর্মচারী|কর্মী|escort|এসকর্ট)/i.test(text);
  const aggregation = /(মোট|total|কত|how\s+much|sum)/i.test(text);

  if (attendance && cash) {
    return {kind: 'cash_attendance_join', domain: 'cash', from, to, label: labelFor(from, to)};
  }
  if (cash && /(সবচেয়ে\s*বেশি|top|highest|most)/i.test(text)) {
    return {kind: 'cash_top', domain: 'cash', from, to, label: labelFor(from, to)};
  }
  if (cash && aggregation) {
    return {kind: 'cash_total', domain: 'cash', from, to, label: labelFor(from, to)};
  }
  if (vessel && /(এসকর্ট|escort)/i.test(text)) {
    const term = vesselTerm(text);
    return {kind: 'vessel_escorts', domain: 'vessel', from, to, term: term || undefined, label: labelFor(from, to)};
  }
  if (attendance) {
    return {kind: 'attendance_list', domain: 'attendance', from, to, label: labelFor(from, to)};
  }
  if (employees && /(তালিকা|list|সব|all|কে|who|নাম|name|ডিজিগনেশন|designation)/i.test(text)) {
    return {kind: 'employee_list', domain: 'employees'};
  }
  // Context-only follow-up ("তার আগের দিনেরটা দেখাও"): reuse the last domain.
  if (prior && /(আগের\s*দিন|previous\s+day|ওটার|সেটার)/i.test(text)) {
    if (prior.domain === 'cash') return {kind: 'cash_total', domain: 'cash', from, to, label: labelFor(from, to)};
    if (prior.domain === 'attendance') return {kind: 'attendance_list', domain: 'attendance', from, to, label: labelFor(from, to)};
    if (prior.domain === 'vessel') return {kind: 'vessel_escorts', domain: 'vessel', from, to, label: labelFor(from, to)};
  }
  return null;
}

export type SqlQuery = {plan: SqlPlan; sql: string; params: unknown[]};

/** Renders exactly one parameterised SELECT for a plan. */
export function generateSQL(plan: SqlPlan): SqlQuery {
  const params: unknown[] = [];
  const range = plan.from && plan.to;
  if (range) {
    params.push(plan.from, plan.to);
  }
  const cashRange = range
    ? `AND (i.event_at AT TIME ZONE 'Asia/Dhaka')::date BETWEEN $1::date AND $2::date`
    : '';

  if (plan.kind === 'cash_total') {
    const sql = `SELECT count(*)::int AS entries,
                        coalesce(sum(i.amount_minor), 0)::bigint AS total_minor
                   FROM cash_instructions i
                  WHERE i.state = 'POSTED' ${cashRange}`;
    return {plan, sql, params: range ? [plan.from, plan.to] : []};
  }
  if (plan.kind === 'cash_top') {
    const sql = `SELECT coalesce(e.preferred_name, i.employee_name) AS name,
                        i.employee_mobile AS mobile,
                        sum(i.amount_minor)::bigint AS total_minor
                   FROM cash_instructions i
                   LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
                  WHERE i.state = 'POSTED' ${cashRange}
                  GROUP BY 1, 2
                  ORDER BY total_minor DESC
                  LIMIT 5`;
    return {plan, sql, params: range ? [plan.from, plan.to] : []};
  }
  if (plan.kind === 'vessel_escorts') {
    const term = plan.term ? transliterate(plan.term) : '';
    const termParam = term ? (range ? '$3' : '$1') : '';
    const sql = `SELECT p.mother_vessel AS mother, p.lighter_vessel AS lighter,
                        p.escort_name AS escort, p.escort_mobile AS escort_mobile,
                        p.start_date::text AS start_date, p.end_date::text AS end_date
                   FROM programs p
                  WHERE p.state <> 'VOIDED'
                    ${range ? `AND p.start_date <= $2::date AND coalesce(p.end_date, p.start_date) >= $1::date` : ''}
                    ${term ? `AND (p.mother_vessel ILIKE '%' || ${termParam} || '%' OR similarity(p.mother_vessel, ${termParam}) >= 0.3)` : ''}
                  ORDER BY p.start_date DESC
                  LIMIT 50`;
    return {plan, sql, params: [...(range ? [plan.from, plan.to] : []), ...(term ? [term] : [])]};
  }
  if (plan.kind === 'attendance_list' || plan.kind === 'cash_attendance_join') {
    const join = plan.kind === 'cash_attendance_join';
    const sql = join
      ? `SELECT e.preferred_name AS name, a.attendance_date::text AS day, a.shift,
                a.location, a.client_name,
                coalesce(sum(i.amount_minor), 0)::bigint AS total_minor
           FROM attendance_records a
           LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
           LEFT JOIN cash_instructions i ON i.employee_mobile = a.employee_mobile
                AND i.state = 'POSTED'
                AND (i.event_at AT TIME ZONE 'Asia/Dhaka')::date = a.attendance_date
          WHERE a.state = 'ACTIVE'
            ${range ? 'AND a.attendance_date BETWEEN $1::date AND $2::date' : ''}
          GROUP BY 1, 2, 3, 4, 5
          ORDER BY a.attendance_date DESC, name
          LIMIT 50`
      : `SELECT e.preferred_name AS name, a.attendance_date::text AS day, a.shift,
                a.location, a.client_name
           FROM attendance_records a
           LEFT JOIN employees e ON e.employee_mobile = a.employee_mobile
          WHERE a.state = 'ACTIVE'
            ${range ? 'AND a.attendance_date BETWEEN $1::date AND $2::date' : ''}
          ORDER BY a.attendance_date DESC, name
          LIMIT 50`;
    return {
      plan, sql,
      params: range ? [plan.from, plan.to] : [],
    };
  }
  const sql = `SELECT e.preferred_name AS name, e.employee_mobile AS mobile,
                      e.designation, e.duty_type, e.state
                 FROM employees e
                WHERE e.state = 'ACTIVE'
                ORDER BY e.preferred_name
                LIMIT 50`;
  return {plan, sql, params: []};
}

export type SqlResult = {
  rows: Array<Record<string, unknown>>;
  rowCount: number;
  executionTime: number;
  error?: string;
};

type Executor = (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>;

/** 5s timeout inside an explicit READ ONLY transaction. */
async function defaultExecutor(sql: string, params: unknown[]): Promise<Array<Record<string, unknown>>> {
  const client = await pool().connect();
  try {
    await client.query('BEGIN READ ONLY');
    await client.query('SET LOCAL statement_timeout = 5000');
    const result = await client.query(sql, params);
    await client.query('COMMIT');
    return result.rows as Array<Record<string, unknown>>;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function executeSQL(query: SqlQuery, execute: Executor = defaultExecutor): Promise<SqlResult> {
  const sql = hardenSQL(query.sql);
  if (!validateSQL(sql)) return {rows: [], rowCount: 0, executionTime: 0, error: 'SQL_REJECTED'};
  const started = Date.now();
  try {
    const rows = await execute(sql, query.params);
    return {rows, rowCount: rows.length, executionTime: Date.now() - started};
  } catch (error) {
    // Never surface driver text: it can contain internal names.
    const code = (error as {code?: string}).code ?? 'SQL_FAILED';
    return {rows: [], rowCount: 0, executionTime: Date.now() - started, error: code};
  }
}

const n = (value: number) => toBengaliDigits(value);
const money = (minor: number) => `৳${new Intl.NumberFormat('bn-BD', {maximumFractionDigits: 2}).format(Number(minor || 0) / 100)}`;

export type EngineAnswer = {
  text: string;
  actions: Array<{label: string; href: string}>;
  suggestions: string[];
  context: string | null;
};

function ledgerHref(plan: SqlPlan): string {
  const base = '/cash/transactions';
  if (!plan.from || !plan.to) return base;
  return `${base}?from=${plan.from}&to=${plan.to}`;
}

function vesselHref(plan: SqlPlan): string {
  const query = plan.term ? `&q=${encodeURIComponent(plan.term)}` : '';
  if (plan.from && plan.to) return `/vessel?from=${plan.from}&to=${plan.to}${query}`;
  return `/vessel${query ? `?${query.slice(1)}` : ''}`;
}

/** Bengali conversation over the query result (never raw rows JSON). */
export function formatEngineAnswer(plan: SqlPlan, result: SqlResult, now: Date = new Date()): EngineAnswer {
  const context = encodeContext({
    domain: plan.domain === 'employees' ? 'employee' : plan.domain,
    from: plan.from, to: plan.to, at: now.getTime(),
  });
  const capped = result.rowCount >= 50;
  const suggestions = plan.domain === 'cash'
    ? ['এই মাসের ক্যাশ সামারি', 'Add Hotel Bill..', 'Open ledger']
    : plan.domain === 'vessel'
      ? ['Add Release Info..', 'Add lighter program..']
      : plan.domain === 'attendance'
        ? ['এই মাসের হাজিরা সামারি', 'Add Attendance..']
        : ['Search an employee..', 'Add New Employee..'];

  if (result.error) {
    return {
      text: 'দুঃখিত, এই প্রশ্নটি নিরাপদে চালানো যায়নি। অন্যভাবে জিজ্ঞাসা করুন অথবা টেমপ্লেট ব্যবহার করুন।',
      actions: [{label: 'Open Employees', href: '/employees'}],
      suggestions, context,
    };
  }
  if (!result.rowCount) {
    return {
      text: `দুঃখিত, ${plan.label ?? 'এই শর্তে'} কোনো তথ্য পাওয়া যায়নি।`,
      actions: [
        {label: plan.domain === 'cash' ? 'Open ledger' : plan.domain === 'vessel' ? 'Open vessel' : 'Open employees',
          href: plan.domain === 'cash' ? ledgerHref(plan) : plan.domain === 'vessel' ? vesselHref(plan) : '/employees'},
      ],
      suggestions, context,
    };
  }

  if (plan.kind === 'cash_total') {
    const row = result.rows[0] ?? {};
    const total = Number(row.total_minor ?? 0);
    const entries = Number(row.entries ?? 0);
    return {
      text: `${plan.label ?? 'সর্বকালের'} মোট: ${money(total)} (${n(entries)} টি লেনদেন)\n• হিসাব শুধু POSTED এন্ট্রির; রিভিউ-অপেক্ষমাণ এন্ট্রি বাদে।`,
      actions: [{label: 'Open ledger', href: ledgerHref(plan)}],
      suggestions, context,
    };
  }

  if (plan.kind === 'cash_top') {
    const lines = result.rows.map((row, index) =>
      `${index + 1}. ${String(row.name ?? '—')} — ${money(Number(row.total_minor ?? 0))}`);
    return {
      text: `${plan.label ?? 'এই মাসে'} সবচেয়ে বেশি পেয়েছেন:\n${lines.join('\n')}`,
      actions: [{label: 'Open ledger', href: ledgerHref(plan)}],
      suggestions, context,
    };
  }

  if (plan.kind === 'vessel_escorts') {
    const lines = result.rows.slice(0, 10).map((row, index) =>
      `${index + 1}. ${String(row.escort ?? 'এসকর্ট নেই')} — ${String(row.escort_mobile ?? 'মোবাইল নেই')} · ${String(row.mother ?? '')} → ${String(row.lighter ?? '')}`);
    const more = !capped && result.rowCount > 10 ? `\nআরও ${n(result.rowCount - 10)} টি আছে।` : '';
    return {
      text: result.rowCount === 1
        ? `${lines[0]}`
        : `${plan.label ?? 'নির্বাচিত সময়ে'} ${capped ? `${n(result.rowCount)} টি পর্যন্ত` : `${n(result.rowCount)} টি`} প্রোগ্রামের এসকর্ট:\n${lines.join('\n')}${more}`,
      actions: [{label: 'Open vessel', href: vesselHref(plan)}],
      suggestions, context,
    };
  }

  if (plan.kind === 'attendance_list' || plan.kind === 'cash_attendance_join') {
    const attendanceHref = plan.from && plan.to ? `/attendance?from=${plan.from}&to=${plan.to}` : '/attendance';
    const lines = result.rows.slice(0, 10).map((row, index) =>
      `${index + 1}. ${String(row.name ?? '—')} — ${String(row.day ?? '')} ${String(row.shift ?? '')}${row.location ? `, ${String(row.location)}` : ''}`);
    const more = !capped && result.rowCount > 10 ? `\nআরও ${n(result.rowCount - 10)} টি আছে।` : '';
    return {
      text: `${plan.label ?? 'নির্বাচিত সময়ে'} ${capped ? `${n(result.rowCount)} টি পর্যন্ত` : `${n(result.rowCount)} টি`} উপস্থিতি:\n${lines.join('\n')}${more}`,
      actions: [{label: 'Open attendance', href: attendanceHref}],
      suggestions, context,
    };
  }

  const lines = result.rows.slice(0, 10).map((row, index) =>
    `${index + 1}. ${String(row.name ?? '—')} — ${String(row.mobile ?? '')}${row.designation ? ` (${String(row.designation)})` : ''}`);
  const more = !capped && result.rowCount > 10 ? `\nআরও ${n(result.rowCount - 10)} টি আছে।` : '';
  return {
    text: `${n(result.rowCount)}${capped ? ' পর্যন্ত' : ''} জন কর্মচারী:\n${lines.join('\n')}${more}`,
    actions: [{label: 'Open employees', href: '/employees'}],
    suggestions, context,
  };
}

/** W4: edit/delete requests never reach SQL. */
export function writeIntentAnswer(message: string): EngineAnswer | null {
  const text = String(message ?? '');
  if (!/(ডিলিট|মুছে|মুছব|এডিট|পরিবর্তন|সংশোধন|আপডেট|delete|remove|edit|modify|update)/i.test(text)) return null;
  if (/(ক্যাশ|cash|পেমেন্ট|payment|টাকা)/i.test(text)) {
    return {
      text: 'ক্যাশ এন্ট্রি সরাসরি ডিলিট/এডিট করা যায় না। এটি REVIEW অবস্থায় থাকলে অ্যাডমিন /review?category=CASH থেকে Decline করতে পারেন; POSTED হলে সংশোধন/রিভার্সাল প্রক্রিয়া লাগবে। ফর্ম: Cash → Add New Payment।',
      actions: [{label: 'Open Review', href: '/review?category=CASH'}, {label: 'Open Cash', href: '/cash'}],
      suggestions: ['Add Hotel Bill..', 'Today\'s cash..'],
      context: null,
    };
  }
  if (/(উপস্থিত|হাজিরা|attendance)/i.test(text)) {
    return {
      text: 'উপস্থিতি পরিবর্তন করতে: Attendance পেইজ → সারির পেন্সিল (Edit) আইকন → তথ্য ঠিক করুন → Save। ডিলিট শুধু attendance.manage অনুমতিতে অ্যাডমিন করতে পারেন।',
      actions: [{label: 'Open Attendance', href: '/attendance'}],
      suggestions: ['Add Attendance..', 'এই মাসের হাজিরা সামারি'],
      context: null,
    };
  }
  if (/(ভেসেল|vessel|প্রোগ্রাম|program|রিলিজ|release)/i.test(text)) {
    return {
      text: 'ভেসেল তথ্য বদলাতে: Vessel পেইজ → নাম দিয়ে খুঁজুন → রো-এর View → Edit → প্রয়োজনীয় ঘর ঠিক করুন → Save। রিলিজের জন্য End তারিখ/শিফট দিন (vessel.release দরকার)। ডিলিট শুধু vessel.command অনুমতিতে।',
      actions: [{label: 'Open Vessel', href: '/vessel'}, {label: 'Open Release', href: '/release'}],
      suggestions: ['Add lighter program..', 'Add Release Info..'],
      context: null,
    };
  }
  return {
    text: 'কর্মচারীর তথ্য বদলাতে: Employees পেইজ → নাম/মোবাইল দিয়ে সার্চ → View → Edit → Save। মুছে ফেলা যায় না; প্রয়োজনে State → INACTIVE করুন।',
    actions: [{label: 'Open Employees', href: '/employees'}],
    suggestions: ['Search an employee..', 'Add New Employee..'],
    context: null,
  };
}

/** One entry point for the chat route; null = not an SQL-shaped question. */
export async function answerSqlQuestion(
  message: string, prior: AssistantContext | null, now: Date = new Date(), execute: Executor = defaultExecutor,
): Promise<EngineAnswer | null> {
  const plan = buildSqlPlan(message, now, prior);
  if (!plan) return null;
  const query = generateSQL(plan);
  const result = await executeSQL(query, execute);
  return formatEngineAnswer(plan, result, now);
}

export type {QueryResultRow};
