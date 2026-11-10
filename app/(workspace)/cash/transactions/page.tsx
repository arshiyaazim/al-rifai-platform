import {CashPaymentsClient} from '@/components/standalone/cash-payments-client';
import {listCashPayments} from '@/lib/standalone/cash-dashboard';
import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';

export const dynamic = 'force-dynamic';

export default async function CashTransactionsPage({searchParams}: {searchParams: Promise<{
  q?: string; date?: string; from?: string; to?: string; employee?: string;
  employeeMobile?: string; employee_mobile?: string; source?: string; page?: string;
}>}) {
  const user = await pageUser();
  if (!can(user as never, 'cash.read')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">Cash read permission is required.</p></section>;
  }
  const params = await searchParams;
  const q = (params.q ?? '').trim();
  const date = (params.date ?? '').trim();
  const from = (params.from ?? '').trim();
  const to = (params.to ?? '').trim();
  const source = (params.source ?? '').trim();
  const employeeMobile = (params.employee_mobile ?? params.employeeMobile ?? params.employee ?? '').trim();
  const result = await listCashPayments({q, date, from, to, employeeMobile, source, limit: 20, offset: 0});
  return (
    <CashPaymentsClient
      initial={{
        rows: result.rows,
        total: result.count,
        totalMinor: result.totalMinor,
        page: 1,
        limit: 20,
        totalPages: Math.max(1, Math.ceil(result.count / 20)),
      }}
      initialFilters={{q, date, from, to, employeeMobile, source}}
    />
  );
}
