'use client';

import {useMemo, useState} from 'react';
import {Eye} from 'lucide-react';
import {AppToaster} from '@/components/standalone/app-toaster';
import {CashTransactionSidebar} from '@/components/standalone/cash-transaction-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {dateDdMmYyyy, dhakaTime12, localMobile} from '@/lib/export-format';
import type {CashTransaction} from './cash-transactions-table';

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
  total: number;
  totalMinor: string;
  page: number;
  limit: number;
  totalPages: number;
};

type Filters = {q: string; date: string; from: string; to: string; employeeMobile: string; source: string};

const money = (minor: unknown) => {
  if (minor === null || minor === undefined || minor === '') return '—';
  return `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
};
const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const cleanName = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

export function CashPaymentsClient({initial, initialFilters}: {
  initial: CashPaymentPage;
  initialFilters: Filters;
}) {
  const [data, setData] = useState(initial);
  const [filters, setFilters] = useState(initialFilters);
  const [draft, setDraft] = useState(initialFilters);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<CashTransaction | null>(null);

  const activeFilters = useMemo(() => Object.values(filters).filter(Boolean).length, [filters]);

  async function load(next: Filters, page = 1) {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({page: String(page), limit: String(data.limit)});
      if (next.q) params.set('q', next.q);
      if (next.date) params.set('date', next.date);
      if (next.from) params.set('from', next.from);
      if (next.to) params.set('to', next.to);
      if (next.employeeMobile) params.set('employee_mobile', next.employeeMobile);
      if (next.source) params.set('source', next.source);
      const response = await fetch(`/api/cash/payments?${params.toString()}`, {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setData(body as CashPaymentPage);
      setFilters(next);
      setDraft(next);
      const url = new URL(window.location.href);
      for (const key of ['q', 'date', 'from', 'to', 'employee_mobile', 'source', 'page'] as const) {
        const value = key === 'employee_mobile' ? next.employeeMobile : key === 'page' ? '' : next[key as keyof Filters];
        if (value) url.searchParams.set(key, String(value));
        else url.searchParams.delete(key);
      }
      window.history.replaceState(null, '', url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load cash transactions.');
    } finally {
      setLoading(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    void load({...draft, employeeMobile: filters.employeeMobile}, 1);
  }

  function applyEmployee(item: CashPaymentRow) {
    const mobile = item.verified_mobile ?? item.employee_mobile ?? '';
    const next = {...filters, employeeMobile: mobile};
    setSelected(null);
    void load(next, 1);
  }

  function clearEmployee() {
    void load({...filters, employeeMobile: ''}, 1);
  }

  const employeeLabel = filters.employeeMobile
    ? data.rows.find((row) => (row.verified_mobile ?? row.employee_mobile) === filters.employeeMobile)?.preferred_name
      ?? localMobile(filters.employeeMobile)
    : '';

  const asTransaction = (item: CashPaymentRow, index: number): CashTransaction => ({
    id: item.instruction_id,
    employeeId: item.verified_mobile ?? item.employee_mobile,
    nameOfEmployee: cleanName(item.preferred_name ?? item.employee_name),
    designation: item.designation,
    dateOfJoin: item.joined_on,
    payoutNumber: (data.page - 1) * data.limit + index + 1,
    amount: item.amount_minor,
    amountMinor: item.amount_minor,
    totalPaid: item.employee_total_minor,
    totalPaidMinor: item.employee_total_minor,
    method: item.method,
    state: 'POSTED',
    source: item.source_channel,
    sourceMessageId: item.source_message_id,
    notes: null,
    createdAt: item.posted_at,
    eventAt: item.posted_at,
  });

  return (
    <>
      <AppToaster />
      <section className="card print-area">
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3>Cash Transactions ({data.total.toLocaleString()})</h3>
            <p className="muted" style={{marginTop: 0}}>Posted payments from the cash posting ledger.</p>
          </div>
          <span className="muted">Filtered total {money(data.totalMinor)}</span>
        </div>

        <form onSubmit={submit} className="row" style={{gap: 8, flexWrap: 'wrap', marginBottom: 10}}>
          <Input value={draft.q} onChange={(e) => setDraft({...draft, q: e.target.value})} placeholder="Search name or mobile" style={{maxWidth: 230}} />
          <label className="muted" style={{fontSize: 12}}>From <Input type="date" value={draft.from} onChange={(e) => setDraft({...draft, from: e.target.value})} /></label>
          <label className="muted" style={{fontSize: 12}}>To <Input type="date" value={draft.to} onChange={(e) => setDraft({...draft, to: e.target.value})} /></label>
          <label className="muted" style={{fontSize: 12}}>Source
            <select className="vessel-select" value={draft.source} onChange={(e) => setDraft({...draft, source: e.target.value})}>
              <option value="">All</option><option value="WHATSAPP">WhatsApp</option><option value="OFFICE">Office</option>
            </select>
          </label>
          <Button type="submit" size="sm" disabled={loading}>Search</Button>
          {activeFilters ? <Button type="button" size="sm" variant="outline" onClick={() => void load({q: '', date: '', from: '', to: '', employeeMobile: '', source: ''}, 1)}>Clear</Button> : null}
        </form>

        {filters.employeeMobile ? (
          <div className="vessel-filter-chip" role="status">
            <span>Filtering: <strong>{employeeLabel}</strong></span>
            <button type="button" aria-label="Clear employee filter" onClick={clearEmployee}>×</button>
          </div>
        ) : null}

        {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

        <div className="cash-table-scroll">
          <table className="cash-payment-table">
            <thead>
              <tr>
                <th>Sl</th><th>Employee ID</th><th>Name of Employee</th><th>Designation</th>
                <th>Date of Join</th><th>Payout Number</th><th>Amount</th><th>Total Paid</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((item, index) => {
                const mobile = item.verified_mobile ?? item.employee_mobile;
                return (
                  <tr key={item.posting_id}>
                    <td>{(data.page - 1) * data.limit + index + 1}</td>
                    <td>{mobile ? localMobile(mobile) : '—'}</td>
                    <td>
                      {mobile ? (
                        <button type="button" className="vessel-link" onClick={() => applyEmployee(item)}>
                          {cleanName(item.preferred_name ?? item.employee_name)}
                        </button>
                      ) : cleanName(item.employee_name)}
                      <small className="muted" style={{display: 'block'}}>
                        {dateDdMmYyyy(item.posted_at)} · {dhakaTime12(item.posted_at)}
                      </small>
                    </td>
                    <td>{dash(item.designation)}</td>
                    <td>{item.joined_on ? dateDdMmYyyy(item.joined_on) : '—'}</td>
                    <td>{dash(item.payout_mobile)}</td>
                    <td style={{textAlign: 'right'}}>{money(item.amount_minor)}</td>
                    <td style={{textAlign: 'right'}}>{money(item.employee_total_minor)}</td>
                    <td>
                      <Button type="button" size="icon-sm" variant="ghost"
                        aria-label={`View details for ${item.employee_name}`}
                        onClick={() => setSelected(asTransaction(item, index))}>
                        <Eye className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {!data.rows.length ? <tr><td colSpan={9} className="muted">No posted payments match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions cash-pagination" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => void load(filters, data.page - 1)}>← Previous</Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => void load(filters, data.page + 1)}>Next →</Button>
        </div>
      </section>

      <CashTransactionSidebar
        key={selected?.id ?? 'none'}
        transaction={selected}
        onClose={() => setSelected(null)}
        onFilterEmployee={(mobile, name) => void load({...filters, employeeMobile: mobile, q: name ?? ''}, 1)}
        onUpdated={() => void load(filters, data.page)}
        canManage={false}
      />
    </>
  );
}
