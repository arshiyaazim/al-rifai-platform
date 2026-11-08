import {row, rows} from './db.ts';

/**
 * Read-only Cash payment reporting.
 *
 * A "payment" is an existing accounting posting: one row in `cash_postings`
 * whose instruction is still POSTED. Reversing an instruction moves it to VOID,
 * so reversed money is excluded from summaries and detail lists. A posting is
 * unique per instruction (`cash_postings.instruction_id` is UNIQUE), which
 * prevents instruction/posting joins from double counting.
 *
 * Payment date is `cash_postings.posted_at`. Every calendar comparison is made
 * in Asia/Dhaka, the business timezone, rather than the server timezone.
 */
export const CASH_PAYMENT_TIME_ZONE = 'Asia/Dhaka';

/** Business Paid reporting is opt-in and mirrors the write-side flag. */
export function paidEventsReportingEnabled(): boolean {
  return process.env.PHASE3_PAID_EVENTS_ENABLED === '1';
}

export type CashPaymentSource = 'WHATSAPP' | 'OFFICE' | 'WEB' | 'IMPORT' | null;

export type CashPaymentFilterInput = {
  date?: string | null;
  from?: string | null;
  to?: string | null;
  employee?: string | null;
  employeeMobile?: string | null;
  source?: string | null;
  q?: string | null;
};

export type NormalizedCashPaymentFilters = {
  from: string | null;
  to: string | null;
  employeeMobile: string | null;
  source: CashPaymentSource;
  q: string;
  errors: string[];
};

export type CashDashboardSummary = {
  asOfDate: string;
  totalPaidMinor: string;
  currentMonthPaidMinor: string;
  todayPaidMinor: string;
  yesterdayPaidMinor: string;
  viaWhatsAppPaidMinor: string;
  byOfficePaidMinor: string;
  employeeCount: number;
  lastMonthPaidMinor: string;
};

export type CashPaymentRow = {
  posting_id: string;
  instruction_id: string;
  amount_minor: string;
  posted_at: string;
  employee_mobile: string | null;
  employee_name: string;
  payout_mobile: string | null;
  method: string;
  source_channel: string | null;
  source_message_id: string | null;
  source_block_key: string | null;
  verified_mobile: string | null;
  preferred_name: string | null;
  designation: string | null;
  joined_on: string | null;
  employee_total_minor: string;
};

export type CashPaymentPage = {
  rows: CashPaymentRow[];
  count: number;
  totalMinor: string;
  limit: number;
  offset: number;
  filters: NormalizedCashPaymentFilters;
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MOBILE_DIGITS = /^01[3-9][0-9]{8}$/;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function validDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Display a timestamp in the business timezone without server-local drift. */
export function dhakaTimestamp(value: string | Date | null | undefined): string {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CASH_PAYMENT_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date);
  const v = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${v.year}-${v.month}-${v.day} ${v.hour}:${v.minute} (Dhaka)`;
}

/** Business date in Asia/Dhaka as `YYYY-MM-DD`. */
export function dhakaToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: CASH_PAYMENT_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function currentMonthRange(asOfDate: string = dhakaToday()): {from: string; to: string} {
  const [year, month] = asOfDate.split('-').map(Number);
  return {
    from: `${year}-${pad(month)}-01`,
    to: `${year}-${pad(month)}-${pad(daysInMonth(year, month))}`,
  };
}

export function previousMonthRange(asOfDate: string = dhakaToday()): {from: string; to: string} {
  const [year, month] = asOfDate.split('-').map(Number);
  const previousYear = month === 1 ? year - 1 : year;
  const previousMonth = month === 1 ? 12 : month - 1;
  return {
    from: `${previousYear}-${pad(previousMonth)}-01`,
    to: `${previousYear}-${pad(previousMonth)}-${pad(daysInMonth(previousYear, previousMonth))}`,
  };
}

/** Shift an ISO business date without depending on the server timezone. */
export function shiftIsoDate(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function normalizeMobile(value: string): string {
  const digits = value.replace(/\D/g, '');
  if (MOBILE_DIGITS.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  return value;
}

export function normalizeCashPaymentFilters(input: CashPaymentFilterInput = {}): NormalizedCashPaymentFilters {
  const errors: string[] = [];
  const date = (input.date ?? '').trim();
  const rawFrom = (input.from ?? '').trim();
  const rawTo = (input.to ?? '').trim();

  let from: string | null = null;
  let to: string | null = null;

  if (date) {
    if (validDate(date)) {
      from = date;
      to = date;
    } else {
      errors.push('INVALID_DATE');
    }
  } else {
    if (rawFrom) {
      if (validDate(rawFrom)) from = rawFrom;
      else errors.push('INVALID_FROM_DATE');
    }
    if (rawTo) {
      if (validDate(rawTo)) to = rawTo;
      else errors.push('INVALID_TO_DATE');
    }
  }

  if (from && to && from > to) errors.push('INVALID_DATE_RANGE');

  const employeeInput = (input.employeeMobile ?? input.employee ?? '').trim().slice(0, 40);
  const employeeMobile = employeeInput ? normalizeMobile(employeeInput) : null;

  const sourceInput = (input.source ?? '').trim().toUpperCase();
  let source: CashPaymentSource = null;
  if (sourceInput && sourceInput !== 'ALL') {
    if (sourceInput === 'WHATSAPP' || sourceInput === 'OFFICE' || sourceInput === 'WEB' || sourceInput === 'IMPORT') {
      source = sourceInput;
    } else {
      errors.push('INVALID_SOURCE');
    }
  }

  return {
    from,
    to,
    employeeMobile,
    source,
    q: (input.q ?? '').trim().slice(0, 100),
    errors,
  };
}

/**
 * Shared, parameterized predicate for summary and detail queries. The timezone
 * is the first bind parameter so no user value is ever interpolated.
 */
function paymentWhere(filters: NormalizedCashPaymentFilters, params: unknown[]): string {
  let tzParam: string | null = null;
  const tz = () => {
    if (!tzParam) {
      params.push(CASH_PAYMENT_TIME_ZONE);
      tzParam = `$${params.length}`;
    }
    return tzParam;
  };
  const clauses = [`i.state = 'POSTED'`];

  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (filters.from) {
    clauses.push(`p.posted_at >= (${bind(filters.from)}::date::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.to) {
    clauses.push(`p.posted_at < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.employeeMobile) {
    clauses.push(`i.employee_mobile = ${bind(filters.employeeMobile)}`);
  }
  if (filters.source === 'WHATSAPP') {
    clauses.push(`i.source_channel = 'WHATSAPP'`);
  } else if (filters.source === 'OFFICE') {
    clauses.push(`i.source_channel <> 'WHATSAPP'`);
  } else if (filters.source) {
    clauses.push(`i.source_channel = ${bind(filters.source)}`);
  }
  if (filters.q) {
    const like = bind(`%${filters.q}%`);
    clauses.push(`(
      i.employee_name ILIKE ${like}
      OR coalesce(i.employee_mobile, '') ILIKE ${like}
      OR coalesce(e.preferred_name, '') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(e.name_aliases) AS alias WHERE alias ILIKE ${like})
    )`);
  }

  return clauses.join(' AND ');
}

async function postedCashDashboardSummary(): Promise<CashDashboardSummary> {
  const summary = await row<{
    as_of_date: string;
    total_paid_minor: string;
    current_month_paid_minor: string;
    today_paid_minor: string;
    yesterday_paid_minor: string;
    via_whatsapp_paid_minor: string;
    by_office_paid_minor: string;
    employee_count: number;
    last_month_paid_minor: string;
  }>(
    `WITH bounds AS (
        SELECT (now() AT TIME ZONE $1)::date AS business_date
     ), posted AS (
        SELECT p.amount_minor + coalesce(a.adjustment_minor, 0) AS amount_minor,
               p.posted_at, i.source_channel
          FROM cash_postings p
          JOIN cash_instructions i ON i.id = p.instruction_id
          LEFT JOIN (
            SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
              FROM cash_transaction_adjustments GROUP BY correction_of
          ) a ON a.correction_of = i.id
         WHERE i.state = 'POSTED'
     )
     SELECT b.business_date::text AS as_of_date,
            coalesce(sum(p.amount_minor), 0)::text AS total_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.posted_at >= (date_trunc('month', b.business_date::timestamp) AT TIME ZONE $1)
                AND p.posted_at < ((date_trunc('month', b.business_date::timestamp) + interval '1 month') AT TIME ZONE $1)
            ), 0)::text AS current_month_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.posted_at >= (b.business_date::timestamp AT TIME ZONE $1)
                AND p.posted_at < ((b.business_date + 1)::timestamp AT TIME ZONE $1)
            ), 0)::text AS today_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.posted_at >= ((b.business_date - 1)::timestamp AT TIME ZONE $1)
                AND p.posted_at < (b.business_date::timestamp AT TIME ZONE $1)
            ), 0)::text AS yesterday_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (WHERE p.source_channel = 'WHATSAPP'), 0)::text AS via_whatsapp_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (WHERE p.source_channel <> 'WHATSAPP'), 0)::text AS by_office_paid_minor,
            (SELECT count(*)::int FROM employees) AS employee_count,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.posted_at >= ((date_trunc('month', b.business_date::timestamp) - interval '1 month') AT TIME ZONE $1)
                AND p.posted_at < (date_trunc('month', b.business_date::timestamp) AT TIME ZONE $1)
            ), 0)::text AS last_month_paid_minor
       FROM bounds b
       LEFT JOIN posted p ON true
      GROUP BY b.business_date`,
    [CASH_PAYMENT_TIME_ZONE],
  );

  return {
    asOfDate: summary?.as_of_date ?? dhakaToday(),
    totalPaidMinor: summary?.total_paid_minor ?? '0',
    currentMonthPaidMinor: summary?.current_month_paid_minor ?? '0',
    todayPaidMinor: summary?.today_paid_minor ?? '0',
    yesterdayPaidMinor: summary?.yesterday_paid_minor ?? '0',
    viaWhatsAppPaidMinor: summary?.via_whatsapp_paid_minor ?? '0',
    byOfficePaidMinor: summary?.by_office_paid_minor ?? '0',
    employeeCount: Number(summary?.employee_count ?? 0),
    lastMonthPaidMinor: summary?.last_month_paid_minor ?? '0',
  };
}

/**
 * Business Paid summary. When PHASE3_PAID_EVENTS_ENABLED=1 this is the
 * reporting definition: verified Business Paid Events (corrected amount,
 * reversed events excluded) PLUS historical POSTED rows that have no Business
 * Paid Event. The latter preserves Phase 2 history without double counting.
 */
export async function businessPaidSummary(): Promise<CashDashboardSummary> {
  const summary = await row<{
    as_of_date: string;
    total_paid_minor: string;
    current_month_paid_minor: string;
    today_paid_minor: string;
    yesterday_paid_minor: string;
    via_whatsapp_paid_minor: string;
    by_office_paid_minor: string;
    employee_count: number;
    last_month_paid_minor: string;
  }>(
    `WITH bounds AS (
        SELECT (now() AT TIME ZONE $1)::date AS business_date
     ), effective AS (
        SELECT e.id,
               coalesce(c.amount_minor, e.amount_minor) AS amount_minor,
               e.paid_at,
               e.source_category AS source
          FROM cash_payment_events e
          LEFT JOIN LATERAL (
            SELECT amount_minor
              FROM cash_payment_events c
             WHERE c.event_type = 'CORRECTION' AND c.corrects_event_id = e.id
             ORDER BY c.created_at DESC, c.id DESC
             LIMIT 1
          ) c ON true
         WHERE e.event_type = 'PAYMENT'
           AND e.status = 'PAID'
           AND NOT EXISTS (
             SELECT 1 FROM cash_payment_events r
              WHERE r.event_type = 'REVERSAL' AND r.reverses_event_id = e.id
           )
     ), legacy AS (
        SELECT p.id,
               p.amount_minor,
               p.posted_at AS paid_at,
               i.source_channel AS source
          FROM cash_postings p
          JOIN cash_instructions i ON i.id = p.instruction_id
         WHERE i.state = 'POSTED'
           AND NOT EXISTS (
             SELECT 1 FROM cash_payment_events e
              WHERE e.instruction_id = i.id AND e.event_type = 'PAYMENT'
           )
     ), paid AS (
        SELECT * FROM effective UNION ALL SELECT * FROM legacy
     )
     SELECT b.business_date::text AS as_of_date,
            coalesce(sum(p.amount_minor), 0)::text AS total_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.paid_at >= (date_trunc('month', b.business_date::timestamp) AT TIME ZONE $1)
                AND p.paid_at < ((date_trunc('month', b.business_date::timestamp) + interval '1 month') AT TIME ZONE $1)
            ), 0)::text AS current_month_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.paid_at >= (b.business_date::timestamp AT TIME ZONE $1)
                AND p.paid_at < ((b.business_date + 1)::timestamp AT TIME ZONE $1)
            ), 0)::text AS today_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.paid_at >= ((b.business_date - 1)::timestamp AT TIME ZONE $1)
                AND p.paid_at < (b.business_date::timestamp AT TIME ZONE $1)
            ), 0)::text AS yesterday_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (WHERE p.source = 'WHATSAPP'), 0)::text AS via_whatsapp_paid_minor,
            coalesce(sum(p.amount_minor) FILTER (WHERE p.source <> 'WHATSAPP'), 0)::text AS by_office_paid_minor,
            (SELECT count(*)::int FROM employees) AS employee_count,
            coalesce(sum(p.amount_minor) FILTER (
              WHERE p.paid_at >= ((date_trunc('month', b.business_date::timestamp) - interval '1 month') AT TIME ZONE $1)
                AND p.paid_at < (date_trunc('month', b.business_date::timestamp) AT TIME ZONE $1)
            ), 0)::text AS last_month_paid_minor
       FROM bounds b
       LEFT JOIN paid p ON true
      GROUP BY b.business_date`,
    [CASH_PAYMENT_TIME_ZONE],
  );

  return {
    asOfDate: summary?.as_of_date ?? dhakaToday(),
    totalPaidMinor: summary?.total_paid_minor ?? '0',
    currentMonthPaidMinor: summary?.current_month_paid_minor ?? '0',
    todayPaidMinor: summary?.today_paid_minor ?? '0',
    yesterdayPaidMinor: summary?.yesterday_paid_minor ?? '0',
    viaWhatsAppPaidMinor: summary?.via_whatsapp_paid_minor ?? '0',
    byOfficePaidMinor: summary?.by_office_paid_minor ?? '0',
    employeeCount: Number(summary?.employee_count ?? 0),
    lastMonthPaidMinor: summary?.last_month_paid_minor ?? '0',
  };
}

export async function cashDashboardSummary(): Promise<CashDashboardSummary> {
  return paidEventsReportingEnabled() ? businessPaidSummary() : postedCashDashboardSummary();
}

export async function cashPaymentTotals(input: CashPaymentFilterInput = {}): Promise<{
  count: number;
  totalMinor: string;
  filters: NormalizedCashPaymentFilters;
}> {
  const filters = normalizeCashPaymentFilters(input);
  const params: unknown[] = [];
  const where = paymentWhere(filters, params);
  const totals = await row<{n: number; total_minor: string}>(
    `SELECT count(*)::int AS n,
            coalesce(sum(p.amount_minor + coalesce(a.adjustment_minor, 0)), 0)::text AS total_minor
       FROM cash_postings p
       JOIN cash_instructions i ON i.id = p.instruction_id
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       LEFT JOIN (
         SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
           FROM cash_transaction_adjustments GROUP BY correction_of
       ) a ON a.correction_of = i.id
      WHERE ${where}`,
    params,
  );
  return {
    count: Number(totals?.n ?? 0),
    totalMinor: totals?.total_minor ?? '0',
    filters,
  };
}

export async function listCashPayments(
  input: CashPaymentFilterInput & {limit?: number; offset?: number} = {},
): Promise<CashPaymentPage> {
  const filters = normalizeCashPaymentFilters(input);
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const params: unknown[] = [];
  const where = paymentWhere(filters, params);
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;

  const items = await rows<CashPaymentRow>(
    `SELECT p.id AS posting_id,
            p.instruction_id,
            (p.amount_minor + coalesce(a.adjustment_minor, 0))::text AS amount_minor,
            p.posted_at::text AS posted_at,
            i.employee_mobile,
            i.employee_name,
            i.payout_mobile,
            i.method,
            i.source_channel,
            i.source_message_id,
            i.source_block_key,
            e.employee_mobile AS verified_mobile,
            e.preferred_name,
            e.designation,
            e.joined_on::text AS joined_on,
            CASE
              WHEN i.employee_mobile IS NULL THEN (p.amount_minor + coalesce(a.adjustment_minor, 0))::text
              ELSE (
                SELECT coalesce(sum(p2.amount_minor + coalesce(a2.adjustment_minor, 0)), 0)::text
                  FROM cash_postings p2
                  JOIN cash_instructions i2 ON i2.id = p2.instruction_id
                  LEFT JOIN (
                    SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
                      FROM cash_transaction_adjustments GROUP BY correction_of
                  ) a2 ON a2.correction_of = i2.id
                 WHERE i2.state = 'POSTED'
                   AND i2.employee_mobile = i.employee_mobile
              )
            END AS employee_total_minor
       FROM cash_postings p
       JOIN cash_instructions i ON i.id = p.instruction_id
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       LEFT JOIN (
         SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
           FROM cash_transaction_adjustments GROUP BY correction_of
       ) a ON a.correction_of = i.id
      WHERE ${where}
      ORDER BY p.posted_at DESC, p.id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, limit, offset],
  );

  const count = await row<{n: number; total_minor: string}>(
    `SELECT count(*)::int AS n,
            coalesce(sum(p.amount_minor + coalesce(a.adjustment_minor, 0)), 0)::text AS total_minor
       FROM cash_postings p
       JOIN cash_instructions i ON i.id = p.instruction_id
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       LEFT JOIN (
         SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
           FROM cash_transaction_adjustments GROUP BY correction_of
       ) a ON a.correction_of = i.id
      WHERE ${where}`,
    params,
  );

  return {
    rows: items,
    count: Number(count?.n ?? 0),
    totalMinor: count?.total_minor ?? '0',
    limit,
    offset,
    filters,
  };
}

export type BusinessPaidEventRow = {
  event_id: string | null;
  posting_id: string | null;
  instruction_id: string | null;
  source_submission_id: string | null;
  amount_minor: string;
  paid_at: string;
  source: string;
  employee_mobile: string;
  employee_name: string;
  registered_name: string | null;
  designation: string | null;
  joined_on: string | null;
  payout_mobile: string;
  method: string;
  source_message_id: string | null;
  source_block_key: string | null;
  status: string;
  employee_link_status: string | null;
  financial_posted_at: string | null;
  financial_status: 'POSTED' | 'POSTED_LEGACY' | 'NOT_POSTED';
};

/**
 * Business Paid detail list. Same definition as businessPaidSummary(), so
 * summary totals and detail rows reconcile. Read-only; no financial write.
 */
export async function listBusinessPaidEvents(
  input: CashPaymentFilterInput & {limit?: number; offset?: number} = {},
): Promise<{rows: BusinessPaidEventRow[]; count: number; totalMinor: string;
  limit: number; offset: number; filters: NormalizedCashPaymentFilters}> {
  const filters = normalizeCashPaymentFilters(input);
  const limit = Math.min(Math.max(Number(input.limit) || 25, 1), 100);
  const offset = Math.max(Number(input.offset) || 0, 0);
  const params: unknown[] = [];
  let tzParam: string | null = null;
  const tz = () => {
    if (!tzParam) {
      params.push(CASH_PAYMENT_TIME_ZONE);
      tzParam = `$${params.length}`;
    }
    return tzParam;
  };
  const clauses = ['1=1'];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };
  if (filters.from) {
    clauses.push(`p.paid_at >= (${bind(filters.from)}::date::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.to) {
    clauses.push(`p.paid_at < ((${bind(filters.to)}::date + 1)::timestamp AT TIME ZONE ${tz()})`);
  }
  if (filters.employeeMobile) {
    clauses.push(`p.employee_mobile = ${bind(filters.employeeMobile)}`);
  }
  if (filters.source === 'OFFICE') {
    clauses.push(`p.source <> 'WHATSAPP'`);
  } else if (filters.source) {
    clauses.push(`p.source = ${bind(filters.source)}`);
  }
  if (filters.q) {
    const like = bind(`%${filters.q}%`);
    clauses.push(`(p.employee_name ILIKE ${like} OR p.employee_mobile ILIKE ${like})`);
  }
  const limitParam = `$${params.length + 1}`;
  const offsetParam = `$${params.length + 2}`;
  const cte = `
    WITH effective AS (
      SELECT e.id AS event_id, l.posting_id,
             e.instruction_id, e.source_submission_id,
             coalesce(c.amount_minor, e.amount_minor) AS amount_minor,
             e.paid_at, e.source_category::text AS source,
             e.employee_mobile, coalesce(c.employee_name, e.employee_name) AS employee_name,
             e.payout_mobile, coalesce(c.method, e.method) AS method,
             e.source_message_id, e.source_block_key,
             CASE WHEN c.id IS NOT NULL THEN 'CORRECTED' ELSE 'PAID' END AS status,
             e.employee_link_status, l.posted_at AS financial_posted_at
        FROM cash_payment_events e
        LEFT JOIN cash_payment_event_postings l ON l.payment_event_id = e.id
        LEFT JOIN LATERAL (
          SELECT id, amount_minor, employee_name, method FROM cash_payment_events c
           WHERE c.event_type='CORRECTION' AND c.corrects_event_id=e.id
           ORDER BY c.created_at DESC, c.id DESC LIMIT 1
        ) c ON true
       WHERE e.event_type='PAYMENT'
         AND NOT EXISTS (SELECT 1 FROM cash_payment_events r
                          WHERE r.event_type='REVERSAL' AND r.reverses_event_id=e.id)
    ), legacy AS (
      SELECT NULL::text AS event_id, p.id AS posting_id,
             p.instruction_id, NULL::text AS source_submission_id,
             p.amount_minor, p.posted_at AS paid_at,
             i.source_channel::text AS source, i.employee_mobile, i.employee_name,
             coalesce(i.payout_mobile, '') AS payout_mobile, i.method,
             i.source_message_id, i.source_block_key, 'POSTED'::text AS status,
             NULL::text AS employee_link_status, p.posted_at AS financial_posted_at
        FROM cash_postings p
        JOIN cash_instructions i ON i.id=p.instruction_id
       WHERE i.state='POSTED'
         AND NOT EXISTS (SELECT 1 FROM cash_payment_events e
                          WHERE e.instruction_id=i.id AND e.event_type='PAYMENT')
    ), paid AS (
      SELECT * FROM effective UNION ALL SELECT * FROM legacy
    )`;
  const items = await rows<BusinessPaidEventRow>(
    `${cte}
     SELECT p.event_id, p.posting_id, p.instruction_id, p.source_submission_id,
            p.amount_minor::text,
            p.paid_at::text AS paid_at, p.source, p.employee_mobile, p.employee_name,
            e.preferred_name AS registered_name, e.designation, e.joined_on::text AS joined_on,
            p.payout_mobile, p.method, p.source_message_id, p.source_block_key,
            p.status, p.employee_link_status, p.financial_posted_at::text AS financial_posted_at,
            CASE WHEN p.posting_id IS NULL THEN 'NOT_POSTED'
                 WHEN p.event_id IS NULL THEN 'POSTED_LEGACY'
                 ELSE 'POSTED' END AS financial_status
       FROM paid p
       LEFT JOIN employees e ON e.employee_mobile = p.employee_mobile
      WHERE ${clauses.join(' AND ')}
      ORDER BY p.paid_at DESC, p.event_id NULLS LAST, p.posting_id DESC
      LIMIT ${limitParam} OFFSET ${offsetParam}`,
    [...params, limit, offset],
  );
  const count = await row<{n: number; total_minor: string}>(
    `${cte}
     SELECT count(*)::int AS n, coalesce(sum(p.amount_minor), 0)::text AS total_minor
       FROM paid p WHERE ${clauses.join(' AND ')}`,
    params,
  );
  return {
    rows: items,
    count: Number(count?.n ?? 0),
    totalMinor: count?.total_minor ?? '0',
    limit,
    offset,
    filters,
  };
}

/** Display-only method shorthand used beside the payout number. */
export function payoutMethodLabel(method: string): string {
  const labels: Record<string, string> = {
    bkash: 'bKash',
    nagad: 'Nagad',
    rocket: 'Rocket',
    bank: 'Bank',
    cash: 'Cash',
  };
  return labels[method] ?? method.charAt(0).toUpperCase() + method.slice(1);
}

/**
 * Payout number with method shorthand in parentheses. The method is never
 * rendered as a separate table column.
 */
export function formatPayoutNumber(payoutMobile: string | null, method: string): string {
  const number = (payoutMobile ?? '').trim();
  const label = payoutMethodLabel(method);
  return number ? `${number} (${label})` : `— (${label})`;
}
