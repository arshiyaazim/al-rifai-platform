'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {MoreHorizontal, Plus} from 'lucide-react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {VesselDetailSidebar, stateTone, type VesselProgram} from '@/components/standalone/vessel-detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {cleanEmployeeName} from '@/lib/display-name';

export type VesselRow = VesselProgram & {updated_at?: string | null; source_type?: string | null};

export type VesselPage = {
  rows: VesselRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

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

export function VesselRegisterClient({
  initial, escorts, mothers, fixedMother, canCommand, canRelease, showNew = true,
}: {
  initial: VesselPage;
  escorts: Array<{mobile: string; name: string}>;
  mothers: string[];
  fixedMother?: string;
  canCommand: boolean;
  canRelease: boolean;
  showNew?: boolean;
}) {
  const [data, setData] = useState<VesselPage>(initial);
  const [page, setPage] = useState(initial.page);
  const [limit, setLimit] = useState(initial.limit);
  const [q, setQ] = useState('');
  const [state, setState] = useState('');
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
  const current = useRef({page: initial.page, limit: initial.limit, q: '', state: ''});

  useEffect(() => {
    current.current = {page, limit, q, state};
  }, [page, limit, q, state]);

  async function load(nextPage: number, nextLimit: number, nextQ: string, nextState: string, quiet = false) {
    const id = ++request.current;
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({page: String(nextPage), limit: String(nextLimit)});
      if (nextQ) params.set('q', nextQ);
      if (nextState) params.set('state', nextState);
      if (fixedMother) params.set('mother', fixedMother);
      const response = await fetch(`/api/vessel?${params.toString()}`, {headers: {accept: 'application/json'}, cache: 'no-store'});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json() as VesselPage;
      if (id !== request.current) return;
      setData(payload);
      setPage(payload.page);
      setUpdatedAt(new Date());
    } catch {
      if (id === request.current) setError('Could not refresh vessel programs. The last successful result is shown.');
    } finally {
      if (id === request.current && !quiet) setLoading(false);
    }
  }

  useEffect(() => {
    const {page: p, limit: l, q: search, state: status} = current.current;
    void load(p, l, search, status, true);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      const {page: p, limit: l, q: search, state: status} = current.current;
      void load(p, l, search, status, true);
    }, 30_000);
    return () => clearInterval(timer);
  }, []);

  const submitFilters = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void load(1, limit, q, state);
  };

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
      await load(1, limit, q, state);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Create failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  const rows = data.rows;
  const offset = (data.page - 1) * data.limit;

  return (
    <>
      <AppToaster />
      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3>Programs ({data.total.toLocaleString()})</h3>
            <p className="muted" style={{marginTop: 0}}>
              {fixedMother ? `All programs for ${fixedMother}.` : 'WhatsApp orders, Admin confirmations and release updates, newest first.'}
            </p>
          </div>
          <div className="row-actions">
            <span className="muted" aria-live="polite">{loading ? 'Refreshing…' : updatedAt ? 'Updated just now' : 'Live data'}</span>
            {showNew && canCommand ? (
              <Button type="button" size="sm" onClick={() => setNewOpen(true)}><Plus className="size-4" />New Program</Button>
            ) : null}
          </div>
        </div>

        <form method="get" className="form compact" onSubmit={submitFilters} style={{marginBottom: 12}}>
          <div className="row" style={{gap: 10, flexWrap: 'wrap'}}>
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search mother, lighter, escort or master" style={{minWidth: 260, maxWidth: 420}} />
            <select value={state} onChange={(e) => setState(e.target.value)} className="h-9 rounded-md border bg-background px-2 text-sm" aria-label="State filter">
              <option value="">All states</option>
              {['DRAFT', 'CONFIRMED', 'ASSIGNED', 'IN_DUTY', 'RELEASED', 'COMPLETED', 'VOIDED'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
            <Button type="submit" size="sm">Filter</Button>
            <label className="muted" style={{display: 'flex', alignItems: 'center', gap: 6}}>
              Rows
              <select value={limit} onChange={(e) => { const next = Number(e.target.value); setLimit(next); void load(1, next, q, state); }} className="h-8 rounded-md border bg-background px-2 text-sm">
                {[10, 20, 50].map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
          </div>
        </form>

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

        <div className="row-actions cash-pagination" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => void load(data.page - 1, limit, q, state)}>← Previous</Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => void load(data.page + 1, limit, q, state)}>Next →</Button>
        </div>
      </section>

      <VesselDetailSidebar
        key={selectedId ?? 'none'}
        programId={selectedId}
        onClose={() => setSelectedId(null)}
        onUpdated={() => void load(page, limit, q, state, true)}
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
            <datalist id="vessel-mothers">{mothers.map((mother) => <option key={mother} value={mother} />)}</datalist>
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
