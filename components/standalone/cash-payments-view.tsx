import Link from 'next/link';
import {pageUser, money, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {
  CASH_PAYMENT_TIME_ZONE, formatPayoutNumber, listCashPayments,
} from '@/lib/standalone/cash-dashboard';
import {CashRowActions} from '@/components/standalone/cash-row-actions';

export type CashPaymentViewParams = {
  q?: string;
  date?: string;
  from?: string;
  to?: string;
  employee?: string;
  employeeMobile?: string;
  source?: string;
  page?: string;
};

const PAGE_SIZE = 25;

export async function CashPaymentsView({
  title,
  description,
  params,
}: {
  title: string;
  description: string;
  params: CashPaymentViewParams;
}) {
  const user = await pageUser();
  if (!can(user as never, 'cash.read')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">Cash read permission is required.</p></section>;
  }

  const page = Math.max(1, Number(params.page) || 1);
  const q = (params.q ?? '').trim();
  const date = (params.date ?? '').trim();
  const from = (params.from ?? '').trim();
  const to = (params.to ?? '').trim();
  const employeeMobile = (params.employeeMobile ?? params.employee ?? '').trim();
  const source = (params.source ?? '').trim();

  const result = await listCashPayments({
    q,
    date,
    from,
    to,
    employeeMobile,
    source,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const pages = Math.max(1, Math.ceil(result.count / PAGE_SIZE));
  const currentPage = Math.min(page, pages);

  const href = (nextPage: number) => {
    const search = new URLSearchParams();
    if (q) search.set('q', q);
    if (date) search.set('date', date);
    if (from) search.set('from', from);
    if (to) search.set('to', to);
    if (employeeMobile) search.set('employeeMobile', employeeMobile);
    if (source) search.set('source', source);
    if (nextPage > 1) search.set('page', String(nextPage));
    const query = search.toString();
    return query ? `/cash/transactions?${query}` : '/cash/transactions';
  };

  const resetHref = '/cash/transactions';
  const errorLabels: Record<string, string> = {
    INVALID_DATE: 'The single date is not valid; no date filter was applied.',
    INVALID_FROM_DATE: 'The start date is not valid and was ignored.',
    INVALID_TO_DATE: 'The end date is not valid and was ignored.',
    INVALID_DATE_RANGE: 'The start date is after the end date, so no rows can match.',
    INVALID_SOURCE: 'The selected source is not recognised and was ignored.',
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{title}</h1>
          <p className="muted">{description}</p>
        </div>
        <div className="row-actions">
          <Link href="/api/reports?type=cash">Export Cash CSV</Link>
          <Link href="/cash">Cash control →</Link>
        </div>
      </div>

      <form method="get" className="card form compact cash-payment-filters">
        <div className="grid">
          <label>
            <span>Single date</span>
            <input name="date" type="date" defaultValue={date} />
          </label>
          <label>
            <span>Start date</span>
            <input name="from" type="date" defaultValue={from} />
          </label>
          <label>
            <span>End date</span>
            <input name="to" type="date" defaultValue={to} />
          </label>
          <label>
            <span>Employee ID / mobile</span>
            <input name="employeeMobile" defaultValue={employeeMobile} placeholder="01712345678" autoComplete="off" />
          </label>
          <label>
            <span>Source</span>
            <select name="source" defaultValue={source}>
              <option value="">All sources</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="OFFICE">Office (non-WhatsApp)</option>
            </select>
          </label>
          <label>
            <span>Search name / alias / mobile</span>
            <input name="q" defaultValue={q} placeholder="Name or mobile" autoComplete="off" />
          </label>
        </div>
        <div className="row-actions">
          <button type="submit">Filter</button>
          <Link className="cash-clear-filter" href={resetHref}>Clear</Link>
        </div>
        {result.filters.errors.length ? (
          <ul className="cash-filter-errors">
            {result.filters.errors.map((code) => <li key={code}>{errorLabels[code] ?? code}</li>)}
          </ul>
        ) : null}
      </form>

      <section className="card">
        <div className="cash-payment-summary">
          <div>
            <h3>Posted payments ({result.count})</h3>
            <p className="muted">
              Payment date is <code>posted_at</code> in {CASH_PAYMENT_TIME_ZONE}. Reversed (VOID) and
              unpaid instructions are excluded.
            </p>
          </div>
          <div className="cash-payment-total">
            <span>Filtered total</span>
            <strong>{money(result.totalMinor)}</strong>
          </div>
        </div>

        <div className="cash-table-scroll">
          <table className="cash-payment-table">
            <thead>
              <tr>
                <th>Sl</th>
                <th>Employee ID</th>
                <th>Name of Employee</th>
                <th>Designation</th>
                <th>Date of Join</th>
                <th>Payout Number</th>
                <th>Amount</th>
                <th>Total Paid</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((item, index) => {
                const verifiedMobile = item.verified_mobile ?? item.employee_mobile;
                const name = item.preferred_name ?? item.employee_name;
                return (
                  <tr key={item.posting_id}>
                    <td>{(currentPage - 1) * PAGE_SIZE + index + 1}</td>
                    <td>
                      {verifiedMobile
                        ? <Link href={`/employees/${encodeURIComponent(verifiedMobile)}`}>{verifiedMobile}</Link>
                        : <span className="muted">—</span>}
                    </td>
                    <td>
                      <div>{name}</div>
                      <small className="muted">{when(item.posted_at)} · {item.source_channel ?? 'WEB'}</small>
                    </td>
                    <td>{item.designation ?? '—'}</td>
                    <td>{item.joined_on ?? '—'}</td>
                    <td className="cash-payout">
                      {formatPayoutNumber(item.payout_mobile, item.method)}
                    </td>
                    <td className="cash-amount">{money(item.amount_minor)}</td>
                    <td className="cash-amount">{money(item.employee_total_minor)}</td>
                    <td>
                      <CashRowActions
                        sourceMessageId={item.source_message_id}
                        employeeMobile={verifiedMobile}
                        employeeName={name}
                        payoutMobile={item.payout_mobile}
                      />
                    </td>
                  </tr>
                );
              })}
              {!result.rows.length ? (
                <tr>
                  <td colSpan={9} className="muted">
                    No posted payments match these filters.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>

        {pages > 1 ? (
          <div className="row-actions cash-pagination">
            {currentPage > 1 ? <Link href={href(currentPage - 1)}>← Previous</Link> : null}
            <span className="muted">Page {currentPage} / {pages}</span>
            {currentPage < pages ? <Link href={href(currentPage + 1)}>Next →</Link> : null}
          </div>
        ) : null}
      </section>
    </>
  );
}
