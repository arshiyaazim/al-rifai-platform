'use client';

import {useEffect, useRef, useState} from 'react';
import {MoreHorizontal, Plus} from 'lucide-react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {TableExportControls} from '@/components/standalone/export-controls';
import {RealtimeIndicator} from '@/components/standalone/realtime-refresher';
import {VesselDetailSidebar, stateTone, type VesselProgram} from '@/components/standalone/vessel-detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {useRealtimeUpdates} from '@/hooks/use-realtime-updates';
import {cleanEmployeeName} from '@/lib/display-name';
import {dateDdMmYyyy, dhakaDateTime, type ExportColumn} from '@/lib/export-format';

export type VesselRow = VesselProgram & {updated_at?: string | null; source_type?: string | null};

export type MotherFacet = {name: string; count: number};

export type VesselPage = {
  rows: VesselRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  mothers?: MotherFacet[];
};

type ExportRow = VesselRow & {sl: number};

const VESSEL_STATES = ['DRAFT', 'CONFIRMED', 'ASSIGNED', 'IN_DUTY', 'RELEASED', 'COMPLETED', 'VOIDED'];

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function shift(value: string | null | undefined, shiftValue: string | null | undefined) {
  return value ? `${value} · ${shiftValue ?? '—'}` : '—';
}

function updateUrl(page: number, limit: number, q: string, state: string, mother: string) {
  if (typeof window === 'undefined') return;
  const url = new URL(window.location.href);
  const set = (key: string, value: string) => {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  };
  set('q', q);
  set('state', state);
  set('mother', mother);
  set('page', page > 1 ? String(page) : '');
  set('limit', limit !== 20 ? String(limit) : '');
  window.history.replaceState(null, '', url);
}

export function VesselRegisterClient({
  initial, escorts, mothers: initialMothers, fixedMother, initialQ = '', initialState = '', initialMother = '',
  canCommand, canRelease, showNew = true,
}: {
  initial: VesselPage;
  escorts: Array<{mobile: string; name: string}>;
  mothers: string[];
  fixedMother?: string;
  initialQ?: string;
  initialState?: string;
  initialMother?: string;
  canCommand: boolean;
  canRelease: boolean;
  showNew?: boolean;
}) {
  const [data, setData] = useState<VesselPage>(initial);
  const [page, setPage] = useState(initial.page);
  const [limit, setLimit] = useState(initial.limit);
  const [q, setQ] = useState(initialQ);
  const [state, setState] = useState(initialState);
  const [mother, setMother] = useState(fixedMother ?? initialMother);
  const [mothers, setMothers] = useState<MotherFacet[]>(initial.mothers ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({
    motherVessel: fixedMother ?? '', lighterName: '', masterName: '', masterMobile: '',
    startDate: '', startShift: 'D', escortMobile: '', notes: '',
  });
  const request = useRef(0);
  const current = useRef({page: initial.page, limit: initial.limit, q: initialQ, state: initialState, mother: fixedMother ?? initialMother});

  useEffect(() => {
    current.current = {page, limit, q, state, mother};
  }, [page, limit, q, state, mother]);

  async function load(nextPage: number, nextLimit: number, nextQ: string, nextState: string, nextMother: string, quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({page: String(nextPage), limit: String(nextLimit)});
      if (nextQ) params.set('q', nextQ);
      if (nextState) params.set('state', nextState);
      if (nextMother) params.set('mother', nextMother);
      const response = await fetch(`/api/vessel?${params.toString()}`, {headers: {accept: 'application/json'}, cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as VesselPage;
      if (id !== request.current) return;
      setData(payload);
      setPage(payload.page);
      setUpdatedAt(new Date());
      if (payload.mothers) setMothers(payload.mothers);
    } catch {
      if (id === request.current) setError('Could not refresh vessel programs. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    const {page: p, limit: l, q: search, state: status, mother: vessel} = current.current;
    void load(p, l, search, status, vessel, true);
  }, []);

  const realtime = useRealtimeUpdates('VESSEL', () => {
    const {page: p, limit: l, q: search, state: status, mother: vessel} = current.current;
    void load(p, l, search, status, vessel, true);
  });

  const submitFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    updateUrl(1, limit, q, state, mother);
    void load(1, limit, q, state, mother);
  };

  const changeState = (value: string) => {
    setState(value);
    updateUrl(1, limit, q, value, mother);
    void load(1, limit, q, value, mother);
  };

  const changeMother = (value: string) => {
    setMother(value);
    updateUrl(1, limit, q, state, value);
    void load(1, limit, q, state, value);
  };

  async function fetchAllForExport(): Promise<ExportRow[]> {
    const params = new URLSearchParams({page: '1', limit: '10000'});
    if (q) params.set('q', q);
    if (state) params.set('state', state);
    if (mother) params.set('mother', mother);
    const response = await fetch(`/api/vessel?${params.toString()}`, {headers: {accept: 'application/json'}, cache: 'no-store'});
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json() as VesselPage;
    return payload.rows.map((row, index) => ({...row, sl: index + 1}));
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
      setForm({motherVessel: fixedMother ?? '', lighterName: '', masterName: '', masterMobile: '', startDate: '', startShift: 'D', escortMobile: '', notes: ''});
      await load(1, limit, q, state, mother);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Create failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  const rows = data.rows;
  const offset = (data.page - 1) * data.limit;
  const exportRows: ExportRow[] = rows.map((row, index) => ({...row, sl: offset + index + 1}));
  const columns: ExportColumn<ExportRow>[] = [
    {header: 'Sl', value: (row) => row.sl},
    {header: 'Mother Vessel', value: (row) => row.mother_vessel},
    {header: 'Lighter Vessel', value: (row) => row.master_mobile ? `${row.lighter_vessel} (${row.master_mobile})` : row.lighter_vessel},
    {header: 'Escort Name', value: (row) => row.escort_mobile ? `${cleanEmployeeName(row.escort_name)} (${row.escort_mobile})` : cleanEmployeeName(row.escort_name)},
    {header: 'Start', value: (row) => `${dateDdMmYyyy(row.start_date)} · ${row.start_shift}`},
    {header: 'End', value: (row) => row.end_date ? `${dateDdMmYyyy(row.end_date)} · ${row.end_shift ?? ''}` : ''},
    {header: 'Status', value: (row) => row.state},
    {header: 'Updated', value: (row) => dhakaDateTime(row.updated_at)},
  ];
  const facetsTotal = mothers.reduce((sum, facet) => sum + facet.count, 0);
  const filterSummary = [
    state && `State: ${state}`,
    mother && `Mother: ${mother}`,
    q && `Search: ${q}`,
  ];
  const activeFilters = (state ? 1 : 0) + (mother ? 1 : 0) + (q ? 1 : 0);

  return (
    <>
      <AppToaster />
      <section className="card print-area" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3>Programs ({data.total.toLocaleString()})</h3>
            <p className="muted" style={{marginTop: 0}}>
              {fixedMother ? `All programs for ${fixedMother}.` : 'WhatsApp orders, Admin confirmations and release updates, newest first.'}
            </p>
          </div>
          <div className="row-actions" style={{alignItems: 'center'}}>
            <RealtimeIndicator status={realtime.status} />
            <span className="muted" aria-live="polite">{loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}</span>
            {showNew && canCommand ? (
              <Button type="button" size="sm" onClick={() => setNewOpen(true)}><Plus className="size-4" />New Program</Button>
            ) : null}
          </div>
        </div>

        {!fixedMother && mothers.length ? (
          <>
            <div className="vessel-facets" aria-label="Mother vessel filter">
              <button type="button" className={!mother ? 'is-active' : ''} onClick={() => changeMother('')}>
                All <span>{facetsTotal}</span>
              </button>
              {mothers.map((facet) => (
                <button
                  key={facet.name}
                  type="button"
                  className={mother === facet.name ? 'is-active' : ''}
                  onClick={() => changeMother(facet.name)}
                  title={`Filter by ${facet.name}`}
                >
                  {facet.name} <span>{facet.count}</span>
                </button>
              ))}
            </div>
            <label className="vessel-facet-mobile">
              <span>Mother vessel</span>
              <select value={mother} onChange={(event) => changeMother(event.target.value)}>
                <option value="">All vessels ({facetsTotal})</option>
                {mothers.map((facet) => <option key={facet.name} value={facet.name}>{facet.name} ({facet.count})</option>)}
              </select>
            </label>
          </>
        ) : null}

        <div className="table-toolbar print-hidden">
          <form method="get" className="form compact" onSubmit={submitFilters} style={{margin: 0, flex: 1}}>
            <div className="row" style={{gap: 10, flexWrap: 'wrap'}}>
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mother, lighter, escort or master" style={{minWidth: 240, maxWidth: 420}} />
              <select value={state} onChange={(e) => changeState(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="State filter">
                <option value="">All states</option>
                {VESSEL_STATES.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
              <Button type="submit" size="sm">Filter</Button>
              {activeFilters ? (
                <Button type="button" size="sm" variant="outline" onClick={() => { setQ(''); setState(''); if (!fixedMother) setMother(''); updateUrl(1, limit, '', '', fixedMother ?? ''); void load(1, limit, '', '', fixedMother ?? ''); }}>
                  Clear filters ({activeFilters})
                </Button>
              ) : null}
              <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
                Rows
                <select value={limit} onChange={(e) => { const next = Number(e.target.value); setLimit(next); updateUrl(1, next, q, state, mother); void load(1, next, q, state, mother); }} className="h-8 rounded-md border bg-background px-2 text-sm">
                  {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
                </select>
              </label>
            </div>
          </form>
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

        <div style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 1120}}>
            <colgroup>
              <col style={{width: 50}} /><col style={{width: 150}} /><col style={{width: 170}} />
              <col style={{width: 180}} /><col style={{width: 120}} /><col style={{width: 120}} />
              <col style={{width: 110}} /><col style={{width: 150}} /><col style={{width: 50}} />
            </colgroup>
            <thead>
              <tr>
                <th>Sl</th><th>Mother Vessel</th><th>Lighter Vessel</th><th>Escort Name</th>
                <th>Start</th><th>End</th><th>Status</th><th>Updated</th><th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? Array.from({length: Math.min(limit, 5)}).map((_, index) => (
                <tr key={`sk-${index}`}><td>—</td><td colSpan={8}><span className="muted">Loading…</span></td></tr>
              )) : rows.map((program, index) => (
                <tr key={program.id}>
                  <td>{offset + index + 1}</td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}} title={program.mother_vessel}>{program.mother_vessel}</td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    <div>{program.lighter_vessel}</div>
                    <small className="muted">{program.master_mobile ?? '—'}</small>
                  </td>
                  <td style={{overflow: 'hidden', textOverflow: 'ellipsis'}}>
                    <div>{cleanEmployeeName(program.escort_name)}</div>
                    <small className="muted">{program.escort_mobile ?? '—'}</small>
                  </td>
                  <td>{shift(program.start_date, program.start_shift)}</td>
                  <td>{shift(program.end_date, program.end_shift)}</td>
                  <td><span className={`pill ${stateTone(program.state)}`}>{program.state}</span></td>
                  <td>{program.updated_at ? new Date(program.updated_at).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'short', timeStyle: 'short'}) : '—'}</td>
                  <td>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`Actions for ${program.lighter_vessel}`} onClick={() => setSelectedId(program.id)}>
                      <MoreHorizontal className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
              {!loading && !rows.length ? <tr><td colSpan={9} className="muted">No programs match this filter.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions cash-pagination print-hidden" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => { const next = data.page - 1; updateUrl(next, limit, q, state, mother); void load(next, limit, q, state, mother); }}>← Previous</Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => { const next = data.page + 1; updateUrl(next, limit, q, state, mother); void load(next, limit, q, state, mother); }}>Next →</Button>
        </div>
      </section>

      <VesselDetailSidebar
        key={selectedId ?? 'none'}
        programId={selectedId}
        onClose={() => setSelectedId(null)}
        onUpdated={() => void load(page, limit, q, state, mother, true)}
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
          <label className="text-sm">Lighter Name *<Input value={form.lighterName} onChange={(e) => setForm({...form, lighterName: e.target.value})} required /></label>
          <label className="text-sm">Master Name<Input value={form.masterName} onChange={(e) => setForm({...form, masterName: e.target.value})} /></label>
          <label className="text-sm">Master Mobile<Input value={form.masterMobile} onChange={(e) => setForm({...form, masterMobile: e.target.value})} inputMode="tel" /></label>
          <div className="flex gap-2">
            <label className="flex-1 text-sm">Start Date *<Input type="date" value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} required /></label>
            <label className="text-sm">Shift
              <select value={form.startShift} onChange={(e) => setForm({...form, startShift: e.target.value})} className="h-9 w-full rounded-md border bg-background px-2 text-sm"><option value="D">Day (D)</option><option value="N">Night (N)</option></select>
            </label>
          </div>
          <label className="text-sm">Escort (optional)
            <select value={form.escortMobile} onChange={(e) => setForm({...form, escortMobile: e.target.value})} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
              <option value="">No escort yet</option>
              {escorts.map((escort) => <option key={escort.mobile} value={escort.mobile}>{escort.name} · {escort.mobile}</option>)}
            </select>
          </label>
          <label className="text-sm">Notes<Textarea rows={3} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} /></label>
          <p className="text-xs text-muted-foreground">Mother + Lighter + Start Date are required. Duplicate ±1-day Mother/Lighter programs are checked by the server.</p>
        </div>
      </DetailSidebar>
    </>
  );
}
