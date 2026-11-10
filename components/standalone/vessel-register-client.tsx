'use client';

import {useEffect, useMemo, useRef, useState} from 'react';
import {Eye, Plus} from 'lucide-react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {ChatImportDialog} from '@/components/standalone/chat-import-dialog';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {TableExportControls} from '@/components/standalone/export-controls';
import {RealtimeIndicator} from '@/components/standalone/realtime-refresher';
import {VesselDetailSidebar, type VesselProgram} from '@/components/standalone/vessel-detail-sidebar';
import {Button} from '@/components/ui/button';
import {Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList} from '@/components/ui/combobox';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {useRealtimeUpdates} from '@/hooks/use-realtime-updates';
import {cleanEmployeeName} from '@/lib/display-name';
import {payCells} from '@/lib/vessel-pay';
import type {ExportColumn} from '@/lib/export-format';

export type VesselRow = VesselProgram & {
  updated_at?: string | null;
  source_type?: string | null;
  event_at?: string | null;
  source_chat_jid?: string | null;
  escort_change_from_program_id?: string | null;
  mother_vessel_normalized?: string | null;
  lighter_vessel_normalized?: string | null;
  pay_state?: 'CALCULATED' | 'UNRESOLVED' | null;
  shifts?: number | null;
  salary_minor?: string | null;
  conveyance_minor?: string | null;
  total_minor?: string | null;
};

export type VesselPage = {
  rows: VesselRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type ExportRow = VesselRow & {sl: number};

export type VesselClientOption = {jid: string; label: string};

const RUNNING_STATES = new Set(['CONFIRMED', 'ASSIGNED', 'IN_DUTY']);
const STATUS_OPTIONS = [
  ['', 'All'],
  ['RUNNING', 'Running'],
  ['COMPLETED', 'Completed'],
  ['CANCEL', 'Cancel / Withdrawn'],
  ['ESCORT_CHANGE', 'Escort Change'],
  ['DRAFT', 'Draft'],
] as const;

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function dateDmy(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.day}.${parts.month}.${parts.year}`;
}

const eventDate = dateDmy;

function eventDateIso(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('en-CA', {timeZone: 'Asia/Dhaka'});
}

function shift(value: string | null | undefined, shiftValue: string | null | undefined) {
  const rendered = dateDmy(value);
  return rendered === '—' ? '—' : `${rendered}(${shiftValue ?? '—'})`;
}

function withMv(value: string | null | undefined) {
  const name = String(value ?? '').trim();
  if (!name) return '—';
  return /^m\.?\s*v\.?\s+/i.test(name) ? name : `MV ${name}`;
}

function matches(value: unknown, filter: string) {
  if (!filter.trim()) return true;
  return String(value ?? '').toLowerCase().includes(filter.trim().toLowerCase());
}

function LookupFilter({
  id, value, onChange, items, placeholder,
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  items: string[];
  placeholder: string;
}) {
  return (
    <Combobox items={items} value={value} onValueChange={(next) => onChange(typeof next === 'string' ? next : '')}>
      <ComboboxInput placeholder={placeholder} showClear />
      <ComboboxContent>
        <ComboboxList>
          {(item: string) => <ComboboxItem key={item} value={item}>{item}</ComboboxItem>}
        </ComboboxList>
        <ComboboxEmpty>No match</ComboboxEmpty>
      </ComboboxContent>
    </Combobox>
  );
}

export function VesselRegisterClient({
  initial, escorts, mothers: initialMothers, lighters: initialLighters,
  escortNames: initialEscortNames, escortMobiles: initialEscortMobiles,
  clients, fixedMother, initialMother = '', initialEscortMobile = '', canCommand, canRelease, showNew = true,
}: {
  initial: VesselPage;
  escorts: Array<{mobile: string; name: string}>;
  mothers: string[];
  lighters: string[];
  escortNames: string[];
  escortMobiles: string[];
  clients: VesselClientOption[];
  fixedMother?: string;
  initialQ?: string;
  initialState?: string;
  initialMother?: string;
  initialEscortMobile?: string;
  canCommand: boolean;
  canRelease: boolean;
  showNew?: boolean;
}) {
  const [allRows, setAllRows] = useState<VesselRow[]>(initial.rows);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [motherFilter, setMotherFilter] = useState(fixedMother ?? initialMother);
  const [lighterFilter, setLighterFilter] = useState('');
  const [escortNameFilter, setEscortNameFilter] = useState('');
  const [escortMobileFilter, setEscortMobileFilter] = useState(initialEscortMobile);
  const [escortFilterLabel, setEscortFilterLabel] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [clientFilter, setClientFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [form, setForm] = useState({
    motherVessel: fixedMother ?? '', lighterName: '', masterMobile: '',
    startDate: '', startShift: 'D', escortName: '', escortMobile: '', notes: '',
  });
  const request = useRef(0);

  async function loadAll(quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/vessel?page=1&limit=10000', {
        headers: {accept: 'application/json'}, cache: 'no-store',
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as VesselPage;
      if (id !== request.current) return;
      setAllRows(payload.rows);
      setUpdatedAt(new Date());
    } catch {
      if (id === request.current) setError('Could not refresh vessel programs. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- the async refresh resets the error flag before awaiting the read.
  useEffect(() => { void loadAll(true); }, []);
  const realtime = useRealtimeUpdates('VESSEL', () => { void loadAll(true); });

  // eslint-disable-next-line react-hooks/set-state-in-effect -- any filter change must return the table to page 1.
  useEffect(() => { setPage(1); }, [
    motherFilter, lighterFilter, escortNameFilter, escortMobileFilter,
    fromDate, toDate, clientFilter, statusFilter,
  ]);

  const filteredRows = useMemo(() => {
    return allRows.filter((row) => {
      if (!matches(row.mother_vessel, motherFilter)) return false;
      if (!matches(row.lighter_vessel, lighterFilter)) return false;
      if (!matches(row.escort_name, escortNameFilter)) return false;
      if (!matches(row.escort_mobile, escortMobileFilter)) return false;
      const rowDate = eventDateIso(row.event_at);
      if (fromDate && (!rowDate || rowDate < fromDate)) return false;
      if (toDate && (!rowDate || rowDate > toDate)) return false;
      if (clientFilter && row.source_chat_jid !== clientFilter) return false;
      if (statusFilter) {
        const statusOk =
          (statusFilter === 'RUNNING' && RUNNING_STATES.has(row.state)) ||
          (statusFilter === 'COMPLETED' && (row.state === 'RELEASED' || row.state === 'COMPLETED')) ||
          (statusFilter === 'CANCEL' && (row.state === 'VOIDED' || row.state === 'WITHDRAWN')) ||
          (statusFilter === 'ESCORT_CHANGE' && Boolean(row.escort_change_from_program_id)) ||
          (statusFilter === 'DRAFT' && row.state === 'DRAFT');
        if (!statusOk) return false;
      }
      return true;
    }).sort((a, b) => String(b.event_at ?? '').localeCompare(String(a.event_at ?? '')));
  }, [allRows, motherFilter, lighterFilter, escortNameFilter, escortMobileFilter, fromDate, toDate, clientFilter, statusFilter]);

  const monthBounds = (offset: number) => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset + 1, 0));
    return {from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10)};
  };
  const thisMonth = monthBounds(0);
  const lastMonth = monthBounds(-1);
  const inMonth = (value: string | null | undefined, bounds: {from: string; to: string}) => {
    const day = eventDateIso(value);
    return Boolean(day && day >= bounds.from && day <= bounds.to);
  };
  const totalCount = allRows.length;
  const lastMonthCount = allRows.filter((row) => inMonth(row.event_at, lastMonth)).length;
  const thisMonthCount = allRows.filter((row) => inMonth(row.event_at, thisMonth)).length;
  const activeEscortName = escortFilterLabel
    || allRows.find((row) => String(row.escort_mobile ?? '') === escortMobileFilter)?.escort_name
    || escortMobileFilter;

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / limit));
  const safePage = Math.min(page, totalPages);
  const pageRows = filteredRows.slice((safePage - 1) * limit, safePage * limit);
  const offset = (safePage - 1) * limit;
  const exportRows: ExportRow[] = pageRows.map((row, index) => ({...row, sl: offset + index + 1}));
  const columns: ExportColumn<ExportRow>[] = [
    {header: 'Date', value: (row) => eventDate(row.event_at)},
    {header: 'Mother Vessel', value: (row) => withMv(row.mother_vessel_normalized ?? row.mother_vessel)},
    {header: 'Lighter Vessel', value: (row) => withMv(row.lighter_vessel_normalized ?? row.lighter_vessel)},
    {header: 'Escort Name', value: (row) => cleanEmployeeName(row.escort_name)},
    {header: 'Escort Mobile', value: (row) => row.escort_mobile ?? ''},
    {header: 'Start', value: (row) => shift(row.start_date, row.start_shift)},
    {header: 'End', value: (row) => shift(row.end_date, row.end_shift)},
    {header: 'Days', value: (row) => payCells({...row, halfDayUnits: row.shifts}).days.value},
    {header: 'Salary', value: (row) => payCells({...row, halfDayUnits: row.shifts}).salary.value},
    {header: 'Conv.', value: (row) => payCells({...row, halfDayUnits: row.shifts}).conveyance.value},
    {header: 'Total', value: (row) => payCells({...row, halfDayUnits: row.shifts}).total.value},
  ];
  const filterSummary = [
    motherFilter && `Mother: ${motherFilter}`,
    lighterFilter && `Lighter: ${lighterFilter}`,
    escortNameFilter && `Escort: ${escortNameFilter}`,
    clientFilter && `Client: ${clients.find((c) => c.jid === clientFilter)?.label ?? clientFilter}`,
    statusFilter && `Status: ${STATUS_OPTIONS.find(([value]) => value === statusFilter)?.[1] ?? statusFilter}`,
    fromDate && `From: ${fromDate}`,
    toDate && `To: ${toDate}`,
  ].filter(Boolean) as string[];

  function clearFilters() {
    setMotherFilter(fixedMother ?? '');
    setLighterFilter('');
    setEscortNameFilter('');
    setEscortMobileFilter('');
    setFromDate('');
    setToDate('');
    setClientFilter('');
    setStatusFilter('');
    setPage(1);
    syncEscortUrl('');
  }

  function syncEscortUrl(mobile: string) {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (mobile) url.searchParams.set('escort_mobile', mobile);
    else url.searchParams.delete('escort_mobile');
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }

  /** Employee name / sidebar "All Programs": client-side filter, no navigation. */
  function applyEscortFilter(mobile: string, name?: string | null) {
    setEscortMobileFilter(mobile);
    setEscortNameFilter('');
    setMotherFilter(fixedMother ?? '');
    setLighterFilter('');
    setFromDate('');
    setToDate('');
    setClientFilter('');
    setStatusFilter('');
    setPage(1);
    setSelectedId(null);
    syncEscortUrl(mobile);
    if (name) setEscortFilterLabel(name);
  }

  function clearEscortFilter() {
    setEscortMobileFilter('');
    setEscortFilterLabel('');
    setPage(1);
    syncEscortUrl('');
  }

  async function fetchAllForExport(): Promise<ExportRow[]> {
    return filteredRows.map((row, index) => ({...row, sl: index + 1}));
  }

  const create = async () => {
    setSaving(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/vessel', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(form),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Program created.');
      setNewOpen(false);
      setForm({motherVessel: fixedMother ?? '', lighterName: '', masterMobile: '', startDate: '', startShift: 'D', escortName: '', escortMobile: '', notes: ''});
      await loadAll(true);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Create failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <AppToaster />
      <section className="card print-area" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3>Vessel Register ({filteredRows.length.toLocaleString()})</h3>
            <p className="muted" style={{marginTop: 0}}>
              WhatsApp orders, Admin confirmations and release updates, newest first.
            </p>
          </div>
          <div className="row-actions" style={{alignItems: 'center'}}>
            <RealtimeIndicator status={realtime.status} />
            <span className="muted" aria-live="polite">{loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}</span>
            {showNew && canCommand ? (
              <ChatImportDialog onImported={() => void loadAll(true)} />
            ) : null}
            {showNew && canCommand ? (
              <Button type="button" size="sm" onClick={() => setNewOpen(true)}><Plus className="size-4" />New Program</Button>
            ) : null}
          </div>
        </div>

        {/* 12-cell filter + dashboard grid (4 columns × 3 rows) */}
        <div className="card vessel-filter-card" style={{padding: 16, marginBottom: 16}}>
          <div className="page-head" style={{marginBottom: 10}}>
            <div><h4 style={{margin: 0}}>Search &amp; filters</h4></div>
            <span className="muted" style={{fontSize: 12}}>{filteredRows.length.toLocaleString()} matching programs</span>
          </div>
          <div className="vessel-filter-grid">
            <label>Mother Vessel
              <LookupFilter id="filter-mothers" value={motherFilter} onChange={setMotherFilter} items={initialMothers} placeholder="All mothers" />
            </label>
            <label>Lighter Vessel
              <LookupFilter id="filter-lighters" value={lighterFilter} onChange={setLighterFilter} items={initialLighters} placeholder="All lighters" />
            </label>
            <label>Escort Name
              <LookupFilter id="filter-escort-names" value={escortNameFilter} onChange={setEscortNameFilter} items={initialEscortNames} placeholder="All escorts" />
            </label>
            <label>Escort Mobile
              <LookupFilter id="filter-escort-mobiles" value={escortMobileFilter} onChange={setEscortMobileFilter} items={initialEscortMobiles} placeholder="All mobiles" />
            </label>

            <label>Date From
              <Input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} />
            </label>
            <label>Date To
              <Input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} />
            </label>
            <label>Escort Client
              <select value={clientFilter} onChange={(e) => setClientFilter(e.target.value)} className="vessel-select">
                <option value="">All clients</option>
                {clients.map((client) => <option key={client.jid} value={client.jid}>{client.label}</option>)}
              </select>
            </label>
            <label>Status
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="vessel-select">
                {STATUS_OPTIONS.map(([value, label]) => <option key={value || 'all'} value={value}>{label}</option>)}
              </select>
            </label>

            <button type="button" className="vessel-kpi" onClick={clearFilters} title="Show every program">
              <span>Total Programs</span><strong>{totalCount.toLocaleString()}</strong>
            </button>
            <button type="button" className="vessel-kpi" title="Filter to last month"
              onClick={() => { setFromDate(lastMonth.from); setToDate(lastMonth.to); setStatusFilter(''); setPage(1); }}>
              <span>Last Month</span><strong>{lastMonthCount.toLocaleString()}</strong>
            </button>
            <button type="button" className="vessel-kpi" title="Filter to the current month"
              onClick={() => { setFromDate(thisMonth.from); setToDate(thisMonth.to); setStatusFilter(''); setPage(1); }}>
              <span>Running Month</span><strong>{thisMonthCount.toLocaleString()}</strong>
            </button>
            <button type="button" className="vessel-kpi vessel-kpi--clear" onClick={clearFilters}>
              <span>Clear All Filters</span><strong>↺</strong>
            </button>
          </div>
        </div>

        {escortMobileFilter ? (
          <div className="vessel-filter-chip" role="status">
            <span>Filtering: <strong>{cleanEmployeeName(activeEscortName)}</strong></span>
            <button type="button" aria-label="Clear escort filter" onClick={clearEscortFilter}>×</button>
          </div>
        ) : null}

        <div className="table-toolbar print-hidden" style={{justifyContent: 'flex-end'}}>
          <TableExportControls
            title="Vessel Register"
            filenamePrefix="vessel_register"
            columns={columns}
            rows={exportRows}
            fetchAll={fetchAllForExport}
            filterSummary={filterSummary}
            disabled={loading}
          />
        </div>

        {error ? <div className="error" role="alert">{error}</div> : null}

        <div className="vessel-table-wrap">
          <table className="cash-payment-table vessel-register-table" style={{tableLayout: 'fixed', minWidth: 920}}>
            <colgroup>
              <col style={{width: 75}} /><col style={{width: 120}} /><col style={{width: 120}} />
              <col style={{width: 130}} /><col style={{width: 90}} /><col style={{width: 90}} />
              <col style={{width: 45}} /><col style={{width: 60}} /><col style={{width: 55}} />
              <col style={{width: 60}} /><col style={{width: 35}} />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th><th>Mother Vessel</th><th>Lighter Vessel</th><th>Escort Name</th>
                <th>Start</th><th>End</th><th className="num">Days</th><th className="num">Salary</th>
                <th className="num">Conv.</th><th className="num">Total</th><th><span className="sr-only">View</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length: Math.min(limit, 5)}).map((_, index) => (
                <tr key={`sk-${index}`}><td>—</td><td colSpan={10}><span className="muted">Loading…</span></td></tr>
              )) : pageRows.map((program) => {
                const pay = payCells({...program, halfDayUnits: program.shifts});
                return (
                  <tr key={program.id}>
                    <td>{eventDate(program.event_at)}</td>
                    <td className="vessel-ellipsis" title={program.mother_vessel}>{withMv(program.mother_vessel_normalized ?? program.mother_vessel)}</td>
                    <td className="vessel-ellipsis" title={program.lighter_vessel}>{withMv(program.lighter_vessel_normalized ?? program.lighter_vessel)}</td>
                    <td className="vessel-escort-cell">
                      {program.escort_mobile ? (
                        <button type="button" className="vessel-link" title={cleanEmployeeName(program.escort_name)}
                          onClick={() => applyEscortFilter(String(program.escort_mobile), program.escort_name)}>
                          {cleanEmployeeName(program.escort_name) || '—'}
                        </button>
                      ) : (
                        <strong className="vessel-ellipsis">{cleanEmployeeName(program.escort_name) || '—'}</strong>
                      )}
                      <small>{program.escort_mobile ?? '—'}</small>
                    </td>
                    <td>{shift(program.start_date, program.start_shift)}</td>
                    <td>{shift(program.end_date, program.end_shift)}</td>
                    <td className="num">{pay.days.value}</td>
                    <td className="num">{pay.salary.value}</td>
                    <td className="num">{pay.conveyance.value}</td>
                    <td className="num">{pay.total.value}</td>
                    <td>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`View ${program.lighter_vessel}`} onClick={() => setSelectedId(program.id)}>
                        <Eye className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {!loading && !pageRows.length ? <tr><td colSpan={11} className="muted">No programs match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions cash-pagination print-hidden" style={{marginTop: 12, justifyContent: 'space-between'}}>
          <div className="row-actions" style={{gap: 8}}>
            <Button type="button" size="sm" variant="outline" disabled={loading || safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
            <span className="muted">Page {safePage} / {totalPages}</span>
            <Button type="button" size="sm" variant="outline" disabled={loading || safePage >= totalPages} onClick={() => setPage(safePage + 1)}>Next →</Button>
          </div>
          <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
            Rows
            <select value={limit} onChange={(e) => { setLimit(Number(e.target.value)); setPage(1); }} className="h-8 rounded-md border bg-background px-2 text-sm">
              {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
      </section>

      <VesselDetailSidebar
        key={selectedId ?? 'none'}
        programId={selectedId}
        onClose={() => setSelectedId(null)}
        onUpdated={() => void loadAll(true)}
        onFilterEscort={applyEscortFilter}
        canCommand={canCommand}
        canRelease={canRelease}
      />

      <DetailSidebar
        open={newOpen}
        onClose={() => setNewOpen(false)}
        title="New Vessel Program"
        description="Manual entry · created in DRAFT and audited."
        footer={
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setNewOpen(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void create()} disabled={saving}>{saving ? 'Creating…' : 'Create program'}</Button>
          </>
        }
      >
        <div className="grid gap-3">
          <label className="text-sm">Mother Vessel *
            <Input list="vessel-mothers" value={form.motherVessel} onChange={(e) => setForm({...form, motherVessel: e.target.value})} required />
            <datalist id="vessel-mothers">{initialMothers.map((motherName) => <option key={motherName} value={motherName} />)}</datalist>
          </label>
          <label className="text-sm">Lighter Vessel *
            <Input list="vessel-lighters" value={form.lighterName} onChange={(e) => setForm({...form, lighterName: e.target.value})} required />
            <datalist id="vessel-lighters">{initialLighters.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <label className="text-sm">Master Mobile<Input value={form.masterMobile} onChange={(e) => setForm({...form, masterMobile: e.target.value})} inputMode="tel" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-sm">Start Date *<Input type="date" value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} required /></label>
            <label className="text-sm">Shift
              <select value={form.startShift} onChange={(e) => setForm({...form, startShift: e.target.value})} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="D">Day (D)</option><option value="N">Night (N)</option></select>
            </label>
          </div>
          <label className="text-sm">Escort Name (optional)
            <Input list="vessel-escort-names" value={form.escortName} onChange={(e) => setForm({...form, escortName: e.target.value})} />
            <datalist id="vessel-escort-names">{initialEscortNames.map((name) => <option key={name} value={name} />)}</datalist>
          </label>
          <label className="text-sm">Escort Mobile (optional)
            <Input list="vessel-escort-mobiles" value={form.escortMobile} onChange={(e) => setForm({...form, escortMobile: e.target.value})} inputMode="tel" />
            <datalist id="vessel-escort-mobiles">{initialEscortMobiles.map((mobile) => <option key={mobile} value={mobile} />)}</datalist>
          </label>
          <label className="text-sm">Notes<Textarea rows={3} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} /></label>
          <p className="text-xs text-muted-foreground">Mother + Lighter + Start Date are required. Duplicate ±1-day Mother/Lighter programs are checked by the server.</p>
        </div>
      </DetailSidebar>
    </>
  );
}
