import {row} from './db.ts';

/**
 * Read-only Cash dashboard totals.
 *
 * "Paid" means a POSTED cash posting. A reversed instruction becomes VOID and
 * is therefore excluded from every total. No ledger income/expense or account
 * balance is substituted for a payment total.
 */
export type CashDashboardSummary = {
  totalPaidMinor: string;
  currentMonthPaidMinor: string;
  todayPaidMinor: string;
  yesterdayPaidMinor: string;
  viaWhatsAppPaidMinor: string;
  byOfficePaidMinor: string;
  employeeCount: number;
  lastMonthPaidMinor: string;
};

export async function cashDashboardSummary(): Promise<CashDashboardSummary> {
  const summary = await row<{
    total_paid_minor: string;
    current_month_paid_minor: string;
    today_paid_minor: string;
    yesterday_paid_minor: string;
    via_whatsapp_paid_minor: string;
    by_office_paid_minor: string;
    employee_count: number;
    last_month_paid_minor: string;
  }>(
    `SELECT
        coalesce(sum(p.amount_minor), 0)::text AS total_paid_minor,
        coalesce(sum(p.amount_minor) FILTER (
          WHERE p.posted_at >= date_trunc('month', current_date)
            AND p.posted_at < date_trunc('month', current_date) + interval '1 month'
        ), 0)::text AS current_month_paid_minor,
        coalesce(sum(p.amount_minor) FILTER (WHERE p.posted_at::date = current_date), 0)::text AS today_paid_minor,
        coalesce(sum(p.amount_minor) FILTER (WHERE p.posted_at::date = current_date - 1), 0)::text AS yesterday_paid_minor,
        coalesce(sum(p.amount_minor) FILTER (WHERE i.source_channel = 'WHATSAPP'), 0)::text AS via_whatsapp_paid_minor,
        coalesce(sum(p.amount_minor) FILTER (WHERE i.source_channel <> 'WHATSAPP'), 0)::text AS by_office_paid_minor,
        (SELECT count(*)::int FROM employees) AS employee_count,
        coalesce(sum(p.amount_minor) FILTER (
          WHERE p.posted_at >= date_trunc('month', current_date) - interval '1 month'
            AND p.posted_at < date_trunc('month', current_date)
        ), 0)::text AS last_month_paid_minor
       FROM cash_postings p
       JOIN cash_instructions i ON i.id = p.instruction_id
      WHERE i.state = 'POSTED'`,
  );

  return {
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
