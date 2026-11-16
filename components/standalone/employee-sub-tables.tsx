'use client';

import {useEffect, useState} from 'react';
import {Button} from '@/components/ui/button';

type AttendanceRow = {
  id: string; attendance_date: string; day_name: string; shift: string;
  location: string | null; client_name: string | null; designation: string | null; state: string;
};
type CashRow = {
  id: string; nameOfEmployee: string; payoutNumber: number; amountMinor: string | number;
  method: string | null; state: string; eventAt: string | null;
};
type VesselRow = {
  id: string; mother_vessel: string; lighter_vessel: string; start_date: string;
  end_date: string | null; state: string; total_minor: string | null;
};

type Tab = 'attendance' | 'cash' | 'vessel';
const PAGE_SIZE = 20;

const money = (minor: unknown) => {
  const value = Number(minor ?? 0);
  return Number.isFinite(value) ? `৳${(value / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}` : '—';
};
const day = (value: string | null | undefined) => value ? String(value).slice(0, 10) : '—';

function Pager({page, pages, onPage}: {page: number; pages: number; onPage: (next: number) => void}) {
  if (pages <= 1) return null;
  return (
    <div style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 8}}>
      <Button type="button" size="sm" variant="outline" disabled={page <= 1} onClick={() => onPage(page - 1)}>← Previous</Button>
      <span className="muted">Page {page} / {pages}</span>
      <Button type="button" size="sm" variant="outline" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next →</Button>
    </div>
  );
}

/** Attendance / Cash / Vessel history for one employee. One date range drives all three. */
export function EmployeeSubTables({mobile, from, to}: {mobile: string; from: string; to: string}) {
  const [tab, setTab] = useState<Tab>('attendance');
  const [attendance, setAttendance] = useState<AttendanceRow[]>([]);
  const [cash, setCash] = useState<CashRow[]>([]);
  const [vessel, setVessel] = useState<VesselRow[]>([]);
  const [pages, setPages] = useState<Record<Tab, number>>({attendance: 1, cash: 1, vessel: 1});
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const query = (extra: Record<string, string>) => new URLSearchParams(extra).toString();
    setLoading(true);
    setError('');
    const range = {from, to};
    Promise.all([
      fetch(`/api/attendance?${query({employee_mobile: mobile, date_from: from, date_to: to, limit: '1000'})}`,
        {signal: controller.signal, cache: 'no-store'}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`attendance ${r.status}`))),
      fetch(`/api/cash/transactions?${query({employee_mobile: mobile, ...range, limit: '1000'})}`,
        {signal: controller.signal, cache: 'no-store'}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`cash ${r.status}`))),
      fetch(`/api/vessel?${query({escort_mobile: mobile, ...range, limit: '1000'})}`,
        {signal: controller.signal, cache: 'no-store'}).then((r) => r.ok ? r.json() : Promise.reject(new Error(`vessel ${r.status}`))),
    ])
      .then(([att, cas, ves]) => {
        if (controller.signal.aborted) return;
        setAttendance((att.rows ?? []) as AttendanceRow[]);
        setCash((cas.transactions ?? []) as CashRow[]);
        setVessel((ves.rows ?? []) as VesselRow[]);
        setPages({attendance: 1, cash: 1, vessel: 1});
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Load failed.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [mobile, from, to, reload]);

  const slice = <T,>(rows: T[]) => {
    const page = pages[tab];
    return rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  };
  const pageCount = (total: number) => Math.max(1, Math.ceil(total / PAGE_SIZE));
  const count = {attendance: attendance.length, cash: cash.length, vessel: vessel.length};

  return (
    <section className="card" style={{padding: 14}}>
      <div style={{display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10}}>
        {(['attendance', 'cash', 'vessel'] as const).map((name) => (
          <Button key={name} type="button" size="sm" variant={tab === name ? 'default' : 'outline'}
            onClick={() => setTab(name)}>
            {name[0].toUpperCase() + name.slice(1)} ({count[name]})
          </Button>
        ))}
        <span className="muted" style={{fontSize: 12}}>
          {from || to ? `Range ${from || '…'} → ${to || '…'}` : 'All dates'}
        </span>
        <Button type="button" size="sm" variant="outline" onClick={() => setReload((value) => value + 1)} disabled={loading}>
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </div>
      {error ? <p role="alert" style={{color: '#b91c1c'}}>Could not load {error}.</p> : null}

      <div className="table-wrap" style={{overflowX: 'auto'}}>
        {tab === 'attendance' ? (
          <table style={{minWidth: 720, fontSize: 12}}>
            <thead><tr><th>Date</th><th>Day</th><th>Shift</th><th>Location / Client</th><th>Designation</th><th>State</th></tr></thead>
            <tbody>
              {slice(attendance).map((row) => (
                <tr key={row.id}>
                  <td>{day(row.attendance_date)}</td><td>{row.day_name}</td><td>{row.shift}</td>
                  <td>{row.location ?? row.client_name ?? '—'}</td><td>{row.designation ?? '—'}</td><td>{row.state}</td>
                </tr>
              ))}
              {!attendance.length ? <tr><td colSpan={6} className="muted">No attendance in this range.</td></tr> : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'cash' ? (
          <table style={{minWidth: 720, fontSize: 12}}>
            <thead><tr><th>Date</th><th>Payout #</th><th>Amount</th><th>Method</th><th>State</th></tr></thead>
            <tbody>
              {slice(cash).map((row) => (
                <tr key={row.id}>
                  <td>{day(row.eventAt)}</td><td>{row.payoutNumber}</td><td>{money(row.amountMinor)}</td>
                  <td>{row.method ?? '—'}</td><td>{row.state}</td>
                </tr>
              ))}
              {!cash.length ? <tr><td colSpan={5} className="muted">No cash transactions in this range.</td></tr> : null}
            </tbody>
          </table>
        ) : null}

        {tab === 'vessel' ? (
          <table style={{minWidth: 720, fontSize: 12}}>
            <thead><tr><th>Mother Vessel</th><th>Lighter</th><th>Start</th><th>End</th><th>State</th><th>Pay</th></tr></thead>
            <tbody>
              {slice(vessel).map((row) => (
                <tr key={row.id}>
                  <td>{row.mother_vessel}</td><td>{row.lighter_vessel}</td><td>{day(row.start_date)}</td>
                  <td>{day(row.end_date)}</td><td>{row.state}</td><td>{money(row.total_minor)}</td>
                </tr>
              ))}
              {!vessel.length ? <tr><td colSpan={6} className="muted">No vessel programs in this range.</td></tr> : null}
            </tbody>
          </table>
        ) : null}
      </div>

      <Pager page={pages[tab]} pages={pageCount(count[tab])}
        onPage={(next) => setPages((current) => ({...current, [tab]: next}))} />
    </section>
  );
}
