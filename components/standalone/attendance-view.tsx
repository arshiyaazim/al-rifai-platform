'use client';

import {useEffect, useMemo, useState} from 'react';
import {Eye, Plus} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {AttendanceForm, type AttendanceRecord} from '@/components/standalone/attendance-form';
import {EmployeeLookupDual} from '@/components/standalone/employee-lookup';

type Row = {
  source_id: string;
  employee_mobile: string;
  preferred_name: string | null;
  attendance_date: string;
  shift: string;
  location: string | null;
  client_name: string | null;
  designation: string | null;
  remarks: string | null;
  source: 'VESSEL' | 'NON_VESSEL';
  day_name: string;
  is_weekend: boolean;
};

type Summary = {vesselDays: number; nonVesselDays: number; totalDays: number; salaryMinor: number};

const money = (minor: number) => `৳${(minor / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
const dmy = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[3]}.${match[2]}.${match[1].slice(2)}` : value;
};

export function AttendanceView() {
  const [month, setMonth] = useState(new Date().toISOString().slice(0, 7));
  const [employeeMobile, setEmployeeMobile] = useState('');
  const [employeeName, setEmployeeName] = useState('');
  const [rows, setRows] = useState<Row[]>([]);
  const [summary, setSummary] = useState<Summary>({vesselDays: 0, nonVesselDays: 0, totalDays: 0, salaryMinor: 0});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{key: 'attendance_date' | 'preferred_name' | 'location'; dir: 'asc' | 'desc'}>({key: 'attendance_date', dir: 'desc'});
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<AttendanceRecord | null>(null);

  async function load() {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({month});
      if (employeeMobile) params.set('employee_mobile', employeeMobile);
      const response = await fetch(`/api/attendance/unified?${params.toString()}`, {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setRows(body.rows as Row[]);
      setSummary(body.summary as Summary);
      setPage(1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load attendance.');
    } finally {
      setLoading(false);
    }
  }

  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps -- the async read owns its loading state; reload only when month/employee changes. */
  useEffect(() => { void load(); }, [month, employeeMobile]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((left, right) => {
      const result = String(left[sort.key] ?? '').localeCompare(String(right[sort.key] ?? ''));
      return sort.dir === 'asc' ? result : -result;
    });
    return copy;
  }, [rows, sort]);
  const limit = 20;
  const pages = Math.max(1, Math.ceil(sorted.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = sorted.slice((safePage - 1) * limit, safePage * limit);

  const changeSort = (key: typeof sort.key) => {
    setSort((current) => current.key === key ? {key, dir: current.dir === 'asc' ? 'desc' : 'asc'} : {key, dir: 'asc'});
    setPage(1);
  };
  const header = (key: typeof sort.key, label: string) => (
    <th style={{cursor: 'pointer'}} onClick={() => changeSort(key)}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  const asRecord = (row: Row): AttendanceRecord => ({
    id: row.source_id,
    employee_mobile: row.employee_mobile,
    preferred_name: row.preferred_name,
    attendance_date: row.attendance_date,
    shift: row.shift as 'D' | 'N' | 'FULL',
    location: row.location,
    client_name: row.client_name,
    designation: row.designation,
    remarks: row.remarks,
  });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Attendance / হাজিরা</h1>
          <p className="muted">Vessel duty (automatic) + non-vessel duty (manual), month by month.</p>
        </div>
        <Button type="button" size="sm" onClick={() => { setEditing(null); setFormOpen(true); }}>
          <Plus className="size-4" /> Add Attendance
        </Button>
      </div>

      <section className="card" style={{marginBottom: 14, padding: 14}}>
        <div style={{display: 'grid', gridTemplateColumns: '180px minmax(280px, 1fr) auto', gap: 10, alignItems: 'end'}}>
          <label className="text-sm">Month<Input type="month" value={month} onChange={(e) => setMonth(e.target.value)} /></label>
          <div>
            <EmployeeLookupDual
              key={employeeMobile || 'all'}
              initialMobile={employeeMobile}
              initialName={employeeName}
              layout="horizontal"
              onEmployeeSelect={(mobile, name) => { setEmployeeMobile(mobile); setEmployeeName(name); }}
            />
          </div>
          <Button type="button" size="sm" variant="outline" onClick={() => { setEmployeeMobile(''); setEmployeeName(''); }}>All employees</Button>
        </div>
        {employeeMobile ? (
          <div className="vessel-filter-chip" style={{marginTop: 10}}>
            <span>Filtering: <strong>{employeeName || employeeMobile}</strong></span>
            <button type="button" aria-label="Clear employee filter" onClick={() => { setEmployeeMobile(''); setEmployeeName(''); }}>×</button>
          </div>
        ) : null}
      </section>

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

      <section className="card">
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 1100}}>
            <thead>
              <tr>
                {header('attendance_date', 'Date')}
                <th>Employee ID</th>
                {header('preferred_name', 'Employee Name')}
                <th>Shift</th>
                {header('location', 'Location')}
                <th>Client</th>
                <th>Designation</th>
                <th>Remarks</th>
                <th>Source</th>
                <th><span className="sr-only">Edit</span></th>
              </tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={10} className="muted">Loading attendance…</td></tr> : null}
              {!loading && pageRows.map((row) => (
                <tr key={`${row.source}-${row.source_id}-${row.shift}`} style={row.is_weekend ? {background: '#f8fafc'} : undefined}>
                  <td style={{whiteSpace: 'nowrap'}}>{dmy(row.attendance_date)} <small className="muted">{row.day_name}</small></td>
                  <td>{row.employee_mobile}</td>
                  <td>{row.preferred_name ?? '—'}</td>
                  <td>{row.shift}</td>
                  <td>{row.location ?? '—'}</td>
                  <td>{row.client_name ?? '—'}</td>
                  <td>{row.designation ?? '—'}</td>
                  <td style={{maxWidth: 220, whiteSpace: 'pre-wrap'}}>{row.remarks ?? '—'}</td>
                  <td>
                    <span className="pill" style={row.source === 'VESSEL' ? {background: '#dbeafe', color: '#1e3a8a'} : {background: '#dcfce7', color: '#166534'}}>
                      {row.source === 'VESSEL' ? '🚢 Vessel' : '📋 Non-Vessel'}
                    </span>
                  </td>
                  <td>
                    {row.source === 'NON_VESSEL' ? (
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Edit attendance ${row.source_id}`}
                        onClick={() => { setEditing(asRecord(row)); setFormOpen(true); }}>
                        <Eye className="size-4" />
                      </Button>
                    ) : <span className="muted" title="Vessel duty is derived from the program">—</span>}
                  </td>
                </tr>
              ))}
              {!loading && !pageRows.length ? <tr><td colSpan={10} className="muted">No attendance for this month.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
          <div className="row-actions" style={{gap: 8}}>
            <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
            <span className="muted">Page {safePage} / {pages}</span>
            <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
          </div>
          <span className="muted">
            Total days: <strong>{summary.totalDays.toFixed(2)}</strong> · Vessel: {summary.vesselDays.toFixed(2)} ·
            Non-Vessel: {summary.nonVesselDays.toFixed(2)} · Salary: <strong>{money(summary.salaryMinor)}</strong>
          </span>
        </div>
      </section>

      {formOpen ? (
        <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setFormOpen(false); }}>
          <div className="card" style={{width: 'min(720px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
            <div className="page-head" style={{marginBottom: 8}}>
              <div><h3 style={{margin: 0}}>{editing ? 'Edit Attendance' : 'Add Attendance'}</h3></div>
              <Button type="button" size="sm" variant="outline" onClick={() => setFormOpen(false)}>Close</Button>
            </div>
            <AttendanceForm
              key={editing?.id ?? 'new'}
              record={editing}
              onCancel={() => setFormOpen(false)}
              onSaved={() => { setFormOpen(false); void load(); }}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
