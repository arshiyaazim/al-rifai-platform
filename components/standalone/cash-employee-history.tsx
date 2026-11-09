'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {MoreHorizontal} from 'lucide-react';
import {AppToaster} from '@/components/standalone/app-toaster';
import {CashTransactionSidebar} from '@/components/standalone/cash-transaction-sidebar';
import {EmployeeStatementExport} from '@/components/standalone/employee-statement-export';
import {RealtimeIndicator} from '@/components/standalone/realtime-refresher';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {useRealtimeUpdates} from '@/hooks/use-realtime-updates';
import type {CashTransaction, CashTransactionPage} from './cash-transactions-table';
import {cashStateTone} from '@/lib/status-tone';

export type CashEmployeeSummary = {
  employeeId: string | null;
  nameOfEmployee: string;
  designation: string | null;
  dateOfJoin: string | null;
  totalPayouts: number;
  totalPaid: string;
  totalPaidMinor: string;
};

export type CashEmployeePayload = CashTransactionPage & {employee: CashEmployeeSummary | null};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
const localDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short'}) : '—';

function historyQuery(page: number, limit: number, filters: {
  from: string; to: string; amountMin: string; amountMax: string;
}) {
  const params = new URLSearchParams({page: String(page), limit: String(limit)});
  if (filters.from) params.set('from', filters.from);
  if (filters.to) params.set('to', filters.to);
  if (filters.amountMin) params.set('amountMin', String(Math.round(Number(filters.amountMin) * 100)));
  if (filters.amountMax) params.set('amountMax', String(Math.round(Number(filters.amountMax) * 100)));
  return params;
}

export function CashEmployeeHistory({employeeId, initial, canManage = false, generatedBy = 'Admin'}: {employeeId: string; initial: CashEmployeePayload; canManage?: boolean; generatedBy?: string}) {
  const [data, setData] = useState<CashEmployeePayload>(initial);
  const [page, setPage] = useState(initial.page);
  const [limit, setLimit] = useState(initial.limit);
  const [filters, setFilters] = useState({from: '', to: '', amountMin: '', amountMax: ''});
  const [draft, setDraft] = useState(filters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selected, setSelected] = useState<CashTransaction | null>(null);
  const request = useRef(0);
  const current = useRef({page: initial.page, limit: initial.limit, filters});

  useEffect(() => {
    current.current = {page, limit, filters};
  }, [page, limit, filters]);

  async function load(nextPage: number, nextLimit: number, nextFilters: typeof filters, quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch(
        `/api/cash/employees/${encodeURIComponent(employeeId)}/transactions?${historyQuery(nextPage, nextLimit, nextFilters)}`,
        {headers: {accept: 'application/json'}, cache: 'no-store'},
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as CashEmployeePayload;
      if (id !== request.current) return;
      setData(payload);
      setPage(payload.page);
      setUpdatedAt(new Date());
      setSelected((previous) => previous
        ? payload.transactions.find((item) => item.id === previous.id) ?? previous
        : null);
    } catch {
      if (id === request.current) setError('Could not refresh this employee history. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    const {page: p, limit: l, filters: f} = current.current;
    void load(p, l, f, true);
  }, []);

  const realtime = useRealtimeUpdates('CASH', () => {
    const {page: p, limit: l, filters: f} = current.current;
    void load(p, l, f, true);
  });

  const apply = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters(draft);
    void load(1, limit, draft);
  };

  const clear = () => {
    const empty = {from: '', to: '', amountMin: '', amountMax: ''};
    setDraft(empty);
    setFilters(empty);
    void load(1, limit, empty);
  };

  const employee = data.employee;
  const title = `Transaction History — ${employee?.nameOfEmployee ?? '—'} (${employee?.employeeId ?? employeeId})`;
  const offset = (data.page - 1) * data.limit;

  return (
    <>
      <AppToaster />
      <div className="page-head">
        <div>
          <h1 style={{fontSize: 28}}>{title}</h1>
          <p className="muted">All parsed Cash payouts for this employee, newest first.</p>
        </div>
        <div className="row-actions">
          <Button asChild size="sm" variant="outline"><Link href="/cash">← Back to Cash</Link></Button>
        </div>
      </div>

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Statement</h3></div>
          <div className="row-actions" style={{alignItems: 'center'}}>
            <RealtimeIndicator status={realtime.status} />
            {employee ? (
              <EmployeeStatementExport
                employeeId={employee.employeeId ?? employeeId}
                name={employee.nameOfEmployee}
                designation={employee.designation}
                dateOfJoin={employee.dateOfJoin}
                totalPayouts={employee.totalPayouts}
                totalPaidMinor={employee.totalPaidMinor ?? employee.totalPaid}
                filters={filters}
                generatedBy={generatedBy}
              />
            ) : null}
          </div>
        </div>
        <div className="grid-cards">
          <div className="stat"><div className="label">Employee ID</div><div className="value" style={{fontSize: 18}}>{dash(employee?.employeeId ?? employeeId)}</div></div>
          <div className="stat"><div className="label">Name</div><div className="value" style={{fontSize: 18}}>{dash(employee?.nameOfEmployee)}</div></div>
          <div className="stat"><div className="label">Designation</div><div className="value" style={{fontSize: 18}}>{dash(employee?.designation)}</div></div>
          <div className="stat"><div className="label">Date of Join</div><div className="value" style={{fontSize: 18}}>{dash(employee?.dateOfJoin)}</div></div>
          <div className="stat"><div className="label">Total Payouts</div><div className="value">{employee?.totalPayouts ?? data.total}</div></div>
          <div className="stat"><div className="label">Total Paid</div><div className="value" style={{fontSize: 22}}>{amount(employee?.totalPaidMinor ?? employee?.totalPaid)}</div></div>
        </div>
      </section>

      <section className="card" style={{marginBottom: 18}}>
        <form method="get" className="form compact" onSubmit={apply}>
          <div className="grid">
            <label><span>From</span><Input type="date" value={draft.from} onChange={(e) => setDraft({...draft, from: e.target.value})} /></label>
            <label><span>To</span><Input type="date" value={draft.to} onChange={(e) => setDraft({...draft, to: e.target.value})} /></label>
            <label><span>Min amount (৳)</span><Input type="number" min="0" step="0.01" value={draft.amountMin} onChange={(e) => setDraft({...draft, amountMin: e.target.value})} /></label>
            <label><span>Max amount (৳)</span><Input type="number" min="0" step="0.01" value={draft.amountMax} onChange={(e) => setDraft({...draft, amountMax: e.target.value})} /></label>
          </div>
          <div className="row-actions" style={{marginTop: 10}}>
            <Button type="submit" size="sm">Apply</Button>
            <Button type="button" size="sm" variant="outline" onClick={clear}>Clear</Button>
            <span className="muted" style={{marginLeft: 'auto'}} aria-live="polite">
              {loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}
            </span>
          </div>
        </form>
      </section>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <section className="card">
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Transactions ({data.total.toLocaleString()})</h3></div>
          <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
            Rows
            <select value={limit} onChange={(e) => { const next = Number(e.target.value); setLimit(next); void load(1, next, filters); }} className="h-8 rounded-md border bg-background px-2 text-sm" aria-label="Rows per page">
              {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <div className="cash-table-scroll">
          <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 980}}>
            <colgroup>
              <col style={{width: 50}} /><col style={{width: 160}} /><col style={{width: 80}} />
              <col style={{width: 120}} /><col style={{width: 100}} /><col style={{width: 100}} />
              <col style={{width: 160}} /><col style={{width: 50}} />
            </colgroup>
            <thead>
              <tr>
                <th>Sl</th><th>Date</th><th>Payouts</th><th style={{textAlign: 'right'}}>Amount</th>
                <th>Method</th><th>State</th><th>Source</th><th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length: Math.min(limit, 5)}).map((_, index) => (
                <tr key={`sk-${index}`}><td>—</td><td colSpan={7}><span className="muted">Loading…</span></td></tr>
              )) : data.transactions.map((item, index) => (
                <tr key={item.id} style={item.state === 'REVERSED' ? {opacity: 0.6} : undefined}>
                  <td>{offset + index + 1}</td>
                  <td>{localDate(item.createdAt)}</td>
                  <td>{item.payoutNumber}</td>
                  <td className="cash-amount" style={{textAlign: 'right', textDecoration: item.state === 'REVERSED' ? 'line-through' : undefined}}>
                    {amount(item.amountMinor)}{(item.correctionCount ?? 0) > 0 ? <small className="muted"> (corrected)</small> : null}
                  </td>
                  <td>{dash(item.method)}</td>
                  <td><span className={`pill ${cashStateTone(item.state, item.correctionCount ?? 0)}`}>{item.state}</span></td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{item.reversalOf ? <small className="muted" style={{display: 'block'}}>Reversal of #{item.reversalOf}</small> : null}{item.sourceMessageId
                    ? <Link href={`/messages?q=${encodeURIComponent(item.sourceMessageId)}`}>{item.sourceMessageId}</Link>
                    : dash(item.source)}</td>
                  <td>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Actions for payout ${item.payoutNumber}`} onClick={() => setSelected(item)}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!loading && !data.transactions.length ? <tr><td colSpan={8} className="muted">No transactions match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="row-actions cash-pagination" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => void load(data.page - 1, limit, filters)}>← Previous</Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => void load(data.page + 1, limit, filters)}>Next →</Button>
        </div>
      </section>

      <CashTransactionSidebar
        key={selected?.id ?? 'none'}
        transaction={selected}
        onClose={() => setSelected(null)}
        canManage={canManage}
        onUpdated={(updated) => {
          setSelected(updated);
          setData((previous) => ({
            ...previous,
            transactions: previous.transactions.map((item) => item.id === updated.id ? updated : item),
          }));
        }}
      />
    </>
  );
}
