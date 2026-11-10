'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {Eye} from 'lucide-react';
import {AppToaster} from '@/components/standalone/app-toaster';
import {CashTransactionSidebar} from '@/components/standalone/cash-transaction-sidebar';
import {TableExportControls} from '@/components/standalone/export-controls';
import {RealtimeIndicator} from '@/components/standalone/realtime-refresher';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {useRealtimeUpdates} from '@/hooks/use-realtime-updates';
import {bdtNumber, dateDdMmYyyy, dhakaTime12, localMobile, type ExportColumn} from '@/lib/export-format';

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
  originalAmountMinor?: string;
  adjustmentMinor?: string;
  correctionCount?: number;
  lastCorrectionId?: string | null;
  reversalOf?: string | null;
  totalPaidMinor: string;
  method: string;
  state: string;
  source: string | null;
  sourceMessageId: string | null;
  notes?: string | null;
  createdAt: string;
  eventAt: string;
};

export type CashTransactionPage = {
  transactions: CashTransaction[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type ExportRow = CashTransaction & {sl: number};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

const STATES = [
  ['', 'All states'],
  ['POSTED', 'POSTED'],
  ['DRAFT', 'DRAFT'],
  ['PENDING_REVIEW', 'PENDING_REVIEW'],
  ['APPROVED', 'APPROVED'],
  ['REVERSED', 'REVERSED'],
  ['CORRECTION', 'CORRECTION'],
  ['REJECTED', 'REJECTED'],
] as const;

function updateUrl(page: number, limit: number, search: string, state: string, employee = '') {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const set = (key: string, value: string) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('search', search);
  set('state', state);
  set('employee_mobile', employee);
  set('page', page > 1 ? String(page) : '');
  set('limit', limit !== 20 ? String(limit) : '');
  window.history.replaceState(null, '', url);
}

export function CashTransactionsTable({
  initial, canManage = false, initialSearch = '', initialState = '', initialEmployeeMobile = '',
}: {
  initial: CashTransactionPage;
  canManage?: boolean;
  initialSearch?: string;
  initialState?: string;
  initialEmployeeMobile?: string;
}) {
  const [data, setData] = useState<CashTransactionPage>(initial);
  const [page, setPage] = useState(initial.page);
  const [limit, setLimit] = useState(initial.limit);
  const [search, setSearch] = useState(initialSearch);
  const [appliedSearch, setAppliedSearch] = useState(initialSearch);
  const [stateFilter, setStateFilter] = useState(initialState);
  const [employeeFilter, setEmployeeFilter] = useState(initialEmployeeMobile);
  const [employeeLabel, setEmployeeLabel] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selected, setSelected] = useState<CashTransaction | null>(null);
  const request = useRef(0);
  const current = useRef({page: initial.page, limit: initial.limit, appliedSearch: initialSearch, stateFilter: initialState, employeeFilter: initialEmployeeMobile});

  useEffect(() => {
    current.current = {page, limit, appliedSearch, stateFilter, employeeFilter};
  }, [page, limit, appliedSearch, stateFilter, employeeFilter]);

  async function load(nextPage: number, nextLimit: number, nextSearch: string, nextState: string,
    nextEmployee = employeeFilter, quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({page: String(nextPage), limit: String(nextLimit)});
      if (nextSearch) params.set('search', nextSearch);
      if (nextState) params.set('state', nextState);
      if (nextEmployee) params.set('employee_mobile', nextEmployee);
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
      setSelected((previous) => previous
        ? payload.transactions.find((item) => item.id === previous.id) ?? previous
        : null);
    } catch {
      if (id === request.current) setError('Could not refresh cash transactions. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    const {page: p, limit: l, appliedSearch: q, stateFilter: s, employeeFilter: e} = current.current;
    void load(p, l, q, s, e, true);
  }, []);

  const realtime = useRealtimeUpdates('CASH', () => {
    const {page: p, limit: l, appliedSearch: q, stateFilter: s, employeeFilter: e} = current.current;
    void load(p, l, q, s, e, true);
  });

  const submitSearch = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(search);
    updateUrl(1, limit, search, stateFilter, employeeFilter);
    void load(1, limit, search, stateFilter, employeeFilter);
  };

  const changeState = (value: string) => {
    setStateFilter(value);
    updateUrl(1, limit, appliedSearch, value, employeeFilter);
    void load(1, limit, appliedSearch, value, employeeFilter);
  };

  const changeLimit = (value: number) => {
    setLimit(value);
    updateUrl(1, value, appliedSearch, stateFilter, employeeFilter);
    void load(1, value, appliedSearch, stateFilter, employeeFilter);
  };

  const clearFilters = () => {
    setSearch('');
    setAppliedSearch('');
    setStateFilter('');
    setEmployeeFilter('');
    setEmployeeLabel('');
    updateUrl(1, limit, '', '', '');
    void load(1, limit, '', '', '');
  };

  const applyEmployeeFilter = (employeeId: string | null, name?: string) => {
    const mobile = employeeId ?? '';
    setEmployeeFilter(mobile);
    setEmployeeLabel(name ?? '');
    setPage(1);
    setSelected(null);
    updateUrl(1, limit, appliedSearch, stateFilter, mobile);
    void load(1, limit, appliedSearch, stateFilter, mobile);
  };

  const clearEmployeeFilter = () => {
    setEmployeeFilter('');
    setEmployeeLabel('');
    updateUrl(1, limit, appliedSearch, stateFilter, '');
    void load(1, limit, appliedSearch, stateFilter, '');
  };

  async function fetchAllForExport(): Promise<ExportRow[]> {
    const params = new URLSearchParams({page: '1', limit: '10000'});
    if (appliedSearch) params.set('search', appliedSearch);
    if (stateFilter) params.set('state', stateFilter);
    if (employeeFilter) params.set('employee_mobile', employeeFilter);
    const response = await fetch(`/api/cash/transactions?${params.toString()}`, {
      headers: {accept: 'application/json'}, cache: 'no-store',
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as CashTransactionPage;
    return payload.transactions.map((item, index) => ({...item, sl: index + 1}));
  }

  const rows = data.transactions;
  const offset = (data.page - 1) * data.limit;
  const exportRows: ExportRow[] = rows.map((item, index) => ({...item, sl: offset + index + 1}));
  const columns: ExportColumn<ExportRow>[] = [
    {header: 'Date', value: (row) => `${dateDdMmYyyy(row.eventAt)} ${dhakaTime12(row.eventAt)}`},
    {header: 'Employee ID', value: (row) => localMobile(row.employeeId)},
    {header: 'Name', value: (row) => row.nameOfEmployee},
    {header: 'Designation', value: (row) => row.designation ?? ''},
    {header: 'Date of Join', value: (row) => dateDdMmYyyy(row.dateOfJoin)},
    {header: 'Payouts', value: (row) => row.payoutNumber},
    {header: 'Amount', value: (row) => bdtNumber(row.amountMinor)},
    {header: 'Total Paid', value: (row) => bdtNumber(row.totalPaidMinor)},
  ];
  const filterSummary = [
    stateFilter && `State: ${stateFilter}`,
    appliedSearch && `Search: ${appliedSearch}`,
  ];
  const activeFilters = (stateFilter ? 1 : 0) + (appliedSearch ? 1 : 0) + (employeeFilter ? 1 : 0);

  const openSidebar = (item: CashTransaction) => setSelected(item);

  return (
    <>
      <AppToaster />
      <section className="card print-area" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3>Cash Transactions ({data.total.toLocaleString()})</h3>
            <p className="muted" style={{marginTop: 0}}>
              Parsed from the Accountant ↔ Admin direct WhatsApp conversation. Admin OUTGOING payments are auto-POSTED; manual instructions still follow the approval workflow.
            </p>
          </div>
          <span className="row-actions" style={{alignItems: 'center'}}>
            <RealtimeIndicator status={realtime.status} />
            <span className="muted" aria-live="polite">
              {loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}
            </span>
          </span>
        </div>

        <div className="table-toolbar print-hidden">
          <form method="get" className="form compact" onSubmit={submitSearch} style={{margin: 0, flex: 1}}>
            <div className="row" style={{gap: 10, flexWrap: 'wrap'}}>
              <Input
                name="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search Employee ID or Name"
                aria-label="Search Employee ID or Name"
                style={{minWidth: 240, maxWidth: 360}}
              />
              <select
                value={stateFilter}
                onChange={(event) => changeState(event.target.value)}
                aria-label="Cash state filter"
                className="h-8 rounded-md border bg-background px-2 text-sm"
              >
                {STATES.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
              </select>
              <Button type="submit" size="sm">Search</Button>
              {activeFilters ? (
                <Button type="button" size="sm" variant="outline" onClick={clearFilters}>
                  Clear filters{activeFilters ? ` (${activeFilters})` : ''}
                </Button>
              ) : null}
              <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
                Rows
                <select value={limit} onChange={(event) => changeLimit(Number(event.target.value))} aria-label="Rows per page" className="h-8 rounded-md border bg-background px-2 text-sm">
                  {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
          </form>
          <TableExportControls
            title="Cash Transactions"
            filenamePrefix="cash_transactions"
            columns={columns}
            rows={exportRows}
            fetchAll={fetchAllForExport}
            filterSummary={filterSummary}
            disabled={loading}
          />
        </div>

        {error ? <div className="error" role="alert">{error}</div> : null}

        {employeeFilter ? (
          <div className="vessel-filter-chip" role="status">
            <span>Filtering: <strong>{employeeLabel || localMobile(employeeFilter)}</strong></span>
            <button type="button" aria-label="Clear employee filter" onClick={clearEmployeeFilter}>×</button>
          </div>
        ) : null}

        <div className="cash-table-scroll">
          <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 940}}>
            <colgroup>
              <col style={{width: 110}} />
              <col style={{width: 110}} />
              <col style={{width: 180}} />
              <col style={{width: 120}} />
              <col style={{width: 100}} />
              <col style={{width: 70}} />
              <col style={{width: 100}} />
              <col style={{width: 100}} />
              <col style={{width: 50}} />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th>
                <th>Employee ID</th>
                <th>Name</th>
                <th>Designation</th>
                <th>Date of Join</th>
                <th style={{textAlign: 'center'}}>Payouts</th>
                <th style={{textAlign: 'right'}}>Amount</th>
                <th style={{textAlign: 'right'}}>Total Paid</th>
                <th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length: Math.min(limit, 5)}).map((_, index) => (
                <tr key={`skeleton-${index}`} className="loading-rows">
                  <td>—</td>
                  <td colSpan={8}><span className="muted">Loading…</span></td>
                </tr>
              )) : rows.map((item) => (
                <tr key={item.id} style={item.state === 'REVERSED' ? {opacity: 0.6} : undefined}>
                  <td className="cash-date">
                    <div>{dateDdMmYyyy(item.eventAt)}</div>
                    <small className="muted">{dhakaTime12(item.eventAt)}</small>
                  </td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    {item.employeeId
                      ? <Link href={`/employees/${encodeURIComponent(item.employeeId)}`}>{localMobile(item.employeeId)}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'}}>
                    {item.employeeId ? (
                      <button type="button" className="vessel-link" title={item.nameOfEmployee}
                        onClick={() => applyEmployeeFilter(item.employeeId, item.nameOfEmployee)}>
                        {dash(item.nameOfEmployee)}
                      </button>
                    ) : dash(item.nameOfEmployee)}
                  </td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>{dash(item.designation)}</td>
                  <td>{item.dateOfJoin ? dateDdMmYyyy(item.dateOfJoin) : '—'}</td>
                  <td style={{textAlign: 'center'}}>{item.payoutNumber}</td>
                  <td className="cash-amount" style={{textAlign: 'right', textDecoration: item.state === 'REVERSED' ? 'line-through' : undefined}} title={(item.correctionCount ?? 0) > 0 ? `Original ${amount(item.originalAmountMinor)} → effective ${amount(item.amountMinor)}` : undefined}>
                    {amount(item.amountMinor)}
                    {(item.correctionCount ?? 0) > 0 ? <small className="muted"> (corrected)</small> : null}
                  </td>
                  <td className="cash-amount" style={{textAlign: 'right'}}>{amount(item.totalPaidMinor)}</td>
                  <td style={{textAlign: 'center'}}>
                    <Button
                      type="button"
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`View details for ${item.nameOfEmployee}`}
                      onClick={() => openSidebar(item)}
                    >
                      <Eye className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!loading && !rows.length ? (
                <tr><td colSpan={9} className="muted">No cash transactions match this search.</td></tr>
              ) : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions cash-pagination print-hidden" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => { const next = data.page - 1; updateUrl(next, limit, appliedSearch, stateFilter, employeeFilter); void load(next, limit, appliedSearch, stateFilter, employeeFilter); }}>
            ← Previous
          </Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => { const next = data.page + 1; updateUrl(next, limit, appliedSearch, stateFilter, employeeFilter); void load(next, limit, appliedSearch, stateFilter, employeeFilter); }}>
            Next →
          </Button>
        </div>

        <p className="muted" style={{marginTop: 10, marginBottom: 0}}>
          Date is the real WhatsApp event time (Asia/Dhaka). Designation and Date of Join show “—” when the employee registry has no value. Payouts is the sequential payout for that employee; Total Paid is cumulative through this row in event-time order.
        </p>
      </section>

      <CashTransactionSidebar
        key={selected?.id ?? 'none'}
        transaction={selected}
        onClose={() => setSelected(null)}
        onFilterEmployee={applyEmployeeFilter}
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
