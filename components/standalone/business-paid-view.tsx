import Link from 'next/link';
import {pageUser, money} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {
  CASH_PAYMENT_TIME_ZONE, dhakaTimestamp, formatPayoutNumber, listBusinessPaidEvents,
  paidEventsReportingEnabled,
} from '@/lib/standalone/cash-dashboard';

export type BusinessPaidViewParams = {
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

function sourceLabel(source: string): string {
  if (source === 'WHATSAPP') return 'WhatsApp';
  if (source === 'OFFICE') return 'Office';
  return source;
}

export async function BusinessPaidView({
  title,
  description,
  params,
}: {
  title: string;
  description: string;
  params: BusinessPaidViewParams;
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

  const result = await listBusinessPaidEvents({
    q, date, from, to, employeeMobile, source,
    limit: PAGE_SIZE,
    offset: (page - 1) * PAGE_SIZE,
  });
  const flagOn = paidEventsReportingEnabled();
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
    return query ? `/cash/paid?${query}` : '/cash/paid';
  };

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
          <Link href="/cash">Cash control →</Link>
          <Link href="/cash/transactions">Financial POSTED →</Link>
        </div>
      </div>

      {!flagOn ? (
        <div className="card" style={{padding: 12, marginBottom: 12}}>
          <strong>Paid Events flag is OFF.</strong>{' '}
          <span className="muted">
            No new Business Paid Events are being created. This list shows historical
            POSTED fallback rows only; financial POSTED remains the authoritative ledger view.
          </span>
        </div>
      ) : null}

      <form method="get" className="card form compact cash-payment-filters">
        <div className="grid">
          <label><span>Single date</span><input name="date" type="date" defaultValue={date} /></label>
          <label><span>Start date</span><input name="from" type="date" defaultValue={from} /></label>
          <label><span>End date</span><input name="to" type="date" defaultValue={to} /></label>
          <label><span>Employee ID / mobile</span><input name="employeeMobile" defaultValue={employeeMobile} placeholder="01712345678" autoComplete="off" /></label>
          <label>
            <span>Source</span>
            <select name="source" defaultValue={source}>
              <option value="">All sources</option>
              <option value="WHATSAPP">WhatsApp</option>
              <option value="OFFICE">Office (non-WhatsApp)</option>
            </select>
          </label>
          <label><span>Search name / mobile</span><input name="q" defaultValue={q} placeholder="Name or mobile" autoComplete="off" /></label>
        </div>
        <div className="row-actions">
          <button type="submit">Filter</button>
          <Link className="cash-clear-filter" href="/cash/paid">Clear</Link>
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
            <h3>Business Paid Events ({result.count})</h3>
            <p className="muted">
              Verified business payments. Dates use <code>{CASH_PAYMENT_TIME_ZONE}</code>.
              Financial POSTED is a separate ledger status.
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
                <th>Payout Number</th>
                <th>Amount</th>
                <th>Source</th>
                <th>Business Paid</th>
                <th>Financial</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((item, index) => {
                const registered = item.employee_link_status === 'REGISTERED';
                const name = item.registered_name ?? item.employee_name;
                return (
                  <tr key={item.event_id ?? item.posting_id ?? `${index}`}>
                    <td>{(currentPage - 1) * PAGE_SIZE + index + 1}</td>
                    <td>
                      {registered
                        ? <Link href={`/employees/${encodeURIComponent(item.employee_mobile)}`}>{item.employee_mobile}</Link>
                        : <span>{item.employee_mobile} <small className="muted">(unregistered)</small></span>}
                    </td>
                    <td>
                      <div>{name}</div>
                      <small className="muted">{item.designation ?? '—'} · joined {item.joined_on ?? '—'}</small>
                    </td>
                    <td className="cash-payout">{formatPayoutNumber(item.payout_mobile, item.method)}</td>
                    <td className="cash-amount">{money(item.amount_minor)}</td>
                    <td><span className={`pill ${item.source === 'WHATSAPP' ? 'ok' : 'warn'}`}>{sourceLabel(item.source)}</span></td>
                    <td style={{whiteSpace: 'nowrap'}}>{dhakaTimestamp(item.paid_at)}</td>
                    <td>
                      <span className={`pill ${item.financial_status === 'NOT_POSTED' ? 'warn' : 'ok'}`}>
                        {item.financial_status === 'POSTED_LEGACY' ? 'POSTED (legacy)' : item.financial_status}
                      </span>
                    </td>
                    <td>
                      <div className="row-actions">
                        {item.event_id ? <Link href={`/cash/paid/${encodeURIComponent(item.event_id)}`}>Detail →</Link> : null}
                        {item.instruction_id ? <Link href={`/cash/${encodeURIComponent(item.instruction_id)}`}>Instruction</Link> : null}
                        {item.source_message_id ? <Link href={`/messages?q=${encodeURIComponent(item.source_message_id)}`}>Evidence</Link> : null}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!result.rows.length ? (
                <tr><td colSpan={9} className="muted">No Business Paid Events match these filters.</td></tr>
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