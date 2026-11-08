'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';

export type CashTransaction = {
  id: string;
  employeeId: string | null;
  nameOfEmployee: string;
  designation: string | null;
  dateOfJoin: string | null;
  payoutNumber: number;
  amount: string;
  totalPaid: string;
  amountMinor: string;
  totalPaidMinor: string;
  method: string;
  state: string;
  source: string | null;
  sourceMessageId: string | null;
  createdAt: string;
};

export type CashTransactionPage = {
  transactions: CashTransaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;

export function CashTransactionsTable({initial}: {initial: CashTransactionPage}) {
  const [data, setData] = useState<CashTransactionPage>(initial);
  const [page, setPage] = useState(initial.page);
  const [limit, setLimit] = useState(initial.limit);
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const request = useRef(0);
  const current = useRef({page: initial.page, limit: initial.limit, appliedSearch: ''});

  useEffect(() => {
    current.current = {page, limit, appliedSearch};
  }, [page, limit, appliedSearch]);

  async function load(nextPage: number, nextLimit: number, nextSearch: string, quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(nextPage),
        limit: String(nextLimit),
      });
      if (nextSearch) params.set('search', nextSearch);
      const response = await fetch(`/api/cash/transactions?${params.toString()}`, {
        headers: {accept: 'application/json'},
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as CashTransactionPage;
      if (id !== request.current) return;
      setData(payload);
      setPage(payload.page);
      setUpdatedAt(new Date());
    } catch {
      if (id === request.current) setError('Could not refresh cash transactions. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    // One quiet refresh on mount so the indicator reflects a real API read.
    const {page: p, limit: l, appliedSearch: q} = current.current;
    void load(p, l, q, true);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const {page: p, limit: l, appliedSearch: q} = current.current;
      void load(p, l, q, true);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(search);
    void load(1, limit, search);
  };

  const changeLimit = (value: number) => {
    setLimit(value);
    void load(1, value, appliedSearch);
  };

  const rows = data.transactions;
  const offset = (data.page - 1) * data.limit;

  return (
    <section className="card" style={{marginBottom: 18}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3>Cash Transactions ({data.total.toLocaleString()})</h3>
          <p className="muted" style={{marginTop: 0}}>
            Parsed from the Accountant ↔ Admin direct WhatsApp conversation. Amounts are instructed payouts;
            financial posting remains a separate explicit action.
          </p>
        </div>
        <span className="muted" aria-live="polite">
          {loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}
        </span>
      </div>

      <form method="get" className="form compact" onSubmit={submitSearch} style={{marginBottom: 12}}>
        <div className="row" style={{gap: 10, flexWrap: 'wrap'}}>
          <input
            name="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Employee ID or Name"
            aria-label="Search Employee ID or Name"
            style={{minWidth: 260}}
          />
          <button type="submit">Search</button>
          {appliedSearch ? (
            <button
              type="button"
              onClick={() => { setSearch(''); setAppliedSearch(''); void load(1, limit, ''); }}
            >
              Clear
            </button>
          ) : null}
          <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
            Rows
            <select value={limit} onChange={(event) => changeLimit(Number(event.target.value))} aria-label="Rows per page">
              {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </form>

      {error ? <div className="error" role="alert">{error}</div> : null}

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
            </tr>
          </thead>
          <tbody>
            {loading ? Array.from({length: Math.min(limit, 5)}).map((_, index) => (
              <tr key={`skeleton-${index}`} className="loading-rows">
                <td>—</td>
                <td colSpan={7}><span className="muted">Loading…</span></td>
              </tr>
            )) : rows.map((item, index) => (
              <tr key={item.id}>
                <td>{offset + index + 1}</td>
                <td>
                  {item.employeeId ? (
                    <Link href={`/employees/${encodeURIComponent(item.employeeId)}`}>{item.employeeId}</Link>
                  ) : <span className="muted">—</span>}
                </td>
                <td>
                  <Link href={`/cash/${encodeURIComponent(item.id)}`}>{dash(item.nameOfEmployee)}</Link>
                  <small className="muted">{item.source ?? 'WEB'} · {item.state}</small>
                </td>
                <td>{dash(item.designation)}</td>
                <td>{dash(item.dateOfJoin)}</td>
                <td>{item.payoutNumber}</td>
                <td className="cash-amount">{amount(item.amountMinor)}</td>
                <td className="cash-amount">{amount(item.totalPaidMinor)}</td>
              </tr>
            ))}
            {!loading && !rows.length ? (
              <tr><td colSpan={8} className="muted">No cash transactions match this search.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="row-actions cash-pagination" style={{marginTop: 12}}>
        <button type="button" disabled={loading || data.page <= 1} onClick={() => void load(data.page - 1, limit, appliedSearch)}>
          ← Previous
        </button>
        <span className="muted">Page {data.page} / {data.totalPages}</span>
        <button type="button" disabled={loading || data.page >= data.totalPages} onClick={() => void load(data.page + 1, limit, appliedSearch)}>
          Next →
        </button>
      </div>

      <p className="muted" style={{marginTop: 10, marginBottom: 0}}>
        Designation and Date of Join show “—” when the employee registry has no value. Employee ID is the parsed
        mobile; Payout Number is the sequential payout for that employee; Total Paid is cumulative through this row.
      </p>
    </section>
  );
}
