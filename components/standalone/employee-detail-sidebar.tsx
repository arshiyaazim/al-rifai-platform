'use client';

import {displayMobile} from '@/lib/display-mobile';
import {useEffect, useState} from 'react';
import Link from 'next/link';
import {toast} from 'sonner';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';

type Detail = {
  employee: {
    employee_mobile: string; preferred_name: string; duty_type: string | null;
    designation: string | null; state: string; joined_on: string | null;
    date_of_join: string | null; alt_mobile: string | null; home_phone: string | null;
    present_address: string | null; permanent_address: string | null;
    reference_name: string | null; reference_mobile: string | null;
    nid_number: string | null; birth_cert_number: string | null;
    passport_number: string | null; notes: string | null; created_at: string;
  };
  programs: Array<{id: string; mother_vessel: string; lighter_vessel: string; start_date: string; end_date: string | null; state: string; total_minor: string | null}>;
  attendance: Array<{duty_date: string; shift: string; state: string; hours: string | null}>;
};

type Form = {
  employeeMobile: string; preferredName: string; dutyType: string; designation: string;
  state: string; dateOfJoin: string; altMobile: string; homePhone: string;
  presentAddress: string; permanentAddress: string; referenceName: string;
  referenceMobile: string; nidNumber: string; birthCertNumber: string;
  passportNumber: string; notes: string;
};

type AttendanceMini = {
  source_id: string;
  attendance_date: string;
  shift: string;
  location: string | null;
  client_name: string | null;
  source: 'VESSEL' | 'NON_VESSEL';
};

type AttendanceSummary = {vesselDays: number; nonVesselDays: number; totalDays: number; salaryMinor: number};

const EMPTY: Form = {
  employeeMobile: '', preferredName: '', dutyType: 'other', designation: 'escort',
  state: 'ACTIVE', dateOfJoin: '', altMobile: '', homePhone: '',
  presentAddress: '', permanentAddress: '', referenceName: '',
  referenceMobile: '', nidNumber: '', birthCertNumber: '', passportNumber: '', notes: '',
};

const DESIGNATIONS = ['escort', 'crew', 'security', 'tally_man', 'scale_man', 'office', 'client', 'bondhu', 'bhai', 'accountant', 'other'];

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const money = (minor: string | null) => minor === null ? '—' : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;

function fromDetail(employee: Detail['employee']): Form {
  return {
    employeeMobile: employee.employee_mobile,
    preferredName: employee.preferred_name,
    dutyType: employee.duty_type ?? 'other',
    designation: (employee.designation ?? 'escort').toLowerCase(),
    state: employee.state,
    dateOfJoin: employee.date_of_join ?? employee.joined_on ?? '',
    altMobile: employee.alt_mobile ?? '',
    homePhone: employee.home_phone ?? '',
    presentAddress: employee.present_address ?? '',
    permanentAddress: employee.permanent_address ?? '',
    referenceName: employee.reference_name ?? '',
    referenceMobile: employee.reference_mobile ?? '',
    nidNumber: employee.nid_number ?? '',
    birthCertNumber: employee.birth_cert_number ?? '',
    passportNumber: employee.passport_number ?? '',
    notes: employee.notes ?? '',
  };
}

export function EmployeeDetailSidebar({
  mobile, mode = 'view', onClose, onUpdated, canManage,
}: {
  mobile: string | null;
  mode?: 'view' | 'edit' | 'create';
  onClose: () => void;
  onUpdated?: () => void;
  canManage: boolean;
}) {
  const creating = mode === 'create';
  const open = creating || Boolean(mobile);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(mode !== 'view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState<Form>(EMPTY);
  const [attMonth, setAttMonth] = useState(new Date().toISOString().slice(0, 7));
  const [attRows, setAttRows] = useState<AttendanceMini[]>([]);
  const [attSummary, setAttSummary] = useState<AttendanceSummary>({vesselDays: 0, nonVesselDays: 0, totalDays: 0, salaryMinor: 0});

  useEffect(() => {
    if (creating || !mobile) return;
    const controller = new AbortController();
    fetch(`/api/employees?mobile=${encodeURIComponent(mobile)}`, {headers: {accept: 'application/json'}, signal: controller.signal})
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: Detail) => {
        if (controller.signal.aborted) return;
        setDetail(payload);
        setForm(fromDetail(payload.employee));
      })
      .catch(() => { if (!controller.signal.aborted) toast.error('Employee could not be loaded.', {duration: Infinity}); });
    return () => controller.abort();
  }, [mobile, creating]);

  /* eslint-disable react-hooks/set-state-in-effect -- create mode resets the form; no external store to sync with. */
  useEffect(() => {
    if (!creating) return;
    setForm(EMPTY);
    setEditing(true);
    setDetail(null);
    setError('');
  }, [creating]);
  /* eslint-enable react-hooks/set-state-in-effect */

  useEffect(() => {
    if (!mobile || creating) return;
    const controller = new AbortController();
    fetch(`/api/attendance/unified?employee_mobile=${encodeURIComponent(mobile)}&month=${attMonth}`,
      {signal: controller.signal, cache: 'no-store'})
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (controller.signal.aborted || !body) return;
        setAttRows((body.rows ?? []) as AttendanceMini[]);
        setAttSummary(body.summary as AttendanceSummary);
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [mobile, creating, attMonth]);

  const employee = detail?.employee;

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const token = await csrfToken();
      const body = {
        employeeMobile: form.employeeMobile.trim(),
        preferredName: form.preferredName.trim(),
        dutyType: form.dutyType || null,
        designation: form.designation || null,
        state: form.state,
        dateOfJoin: form.dateOfJoin || null,
        altMobile: form.altMobile.trim() || null,
        homePhone: form.homePhone.trim() || null,
        presentAddress: form.presentAddress.trim() || null,
        permanentAddress: form.permanentAddress.trim() || null,
        referenceName: form.referenceName.trim() || null,
        referenceMobile: form.referenceMobile.trim() || null,
        nidNumber: form.nidNumber.trim() || null,
        birthCertNumber: form.birthCertNumber.trim() || null,
        passportNumber: form.passportNumber.trim() || null,
        notes: form.notes.trim() || null,
      };
      const response = await fetch('/api/employees', {
        method: creating ? 'POST' : 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
      toast.success(creating ? 'Employee created.' : 'Employee updated.');
      onUpdated?.();
      if (creating) onClose();
      else { setEditing(false); if (mobile) {
        const refreshed = await fetch(`/api/employees?mobile=${encodeURIComponent(mobile)}`, {cache: 'no-store'});
        if (refreshed.ok) {
          const next = await refreshed.json() as Detail;
          setDetail(next);
          setForm(fromDetail(next.employee));
        }
      } }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed.');
      toast.error(cause instanceof Error ? cause.message : 'Save failed.', {duration: Infinity});
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!employee) return;
    if (!window.confirm(`Mark ${employee.preferred_name} INACTIVE? The record is kept.`)) return;
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/employees', {
        method: 'PATCH', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({employeeMobile: employee.employee_mobile, state: 'INACTIVE'}),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
      toast.success('Employee marked INACTIVE.');
      onUpdated?.();
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Delete failed.', {duration: Infinity});
    } finally { setBusy(false); }
  };

  const title = creating ? 'New Employee' : employee ? employee.preferred_name : 'Employee';

  return (
    <DetailSidebar
      open={open}
      onClose={() => { setEditing(mode !== 'view'); onClose(); }}
      title={title}
      description={employee ? `${displayMobile(employee.employee_mobile)} · ${employee.state}` : creating ? 'Create a profile' : undefined}
      footer={editing ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={() => { if (creating) onClose(); else setEditing(false); }} disabled={busy}>Cancel</Button>
          <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        </>
      ) : employee ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>
          {canManage ? <Button type="button" size="sm" onClick={() => setEditing(true)}>Edit</Button> : null}
          <Button asChild size="sm" variant="outline">
            <Link href={`/vessel?escort_mobile=${encodeURIComponent(employee.employee_mobile)}`}>All Programs</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <Link href={`/cash?employee_mobile=${encodeURIComponent(employee.employee_mobile)}`}>All Transactions</Link>
          </Button>
          {canManage && employee.state !== 'INACTIVE' ? (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>Delete</Button>
          ) : null}
        </>
      ) : null}
    >
      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
      {!creating && !employee && editing ? <p className="muted">Loading employee…</p> : null}

      {editing ? (
        <div className="grid gap-3">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Basic Info</h4>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
              <label className="text-sm">Employee Name *<Input value={form.preferredName} onChange={(e) => setForm({...form, preferredName: e.target.value})} /></label>
              <label className="text-sm">Employee ID / Mobile *<Input value={form.employeeMobile} disabled={!creating} onChange={(e) => setForm({...form, employeeMobile: e.target.value})} inputMode="tel" /></label>
              <label className="text-sm">Alt Mobile<Input value={form.altMobile} onChange={(e) => setForm({...form, altMobile: e.target.value})} inputMode="tel" /></label>
              <label className="text-sm">Home Phone<Input value={form.homePhone} onChange={(e) => setForm({...form, homePhone: e.target.value})} /></label>
              <label className="text-sm">Date of Join<Input type="date" value={form.dateOfJoin} onChange={(e) => setForm({...form, dateOfJoin: e.target.value})} /></label>
              <label className="text-sm">Designation
                <select className="vessel-select" value={form.designation} onChange={(e) => setForm({...form, designation: e.target.value})}>
                  {DESIGNATIONS.map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}
                </select>
              </label>
              <label className="text-sm">Duty Type
                <select className="vessel-select" value={form.dutyType} onChange={(e) => setForm({...form, dutyType: e.target.value})}>
                  <option value="">—</option><option value="escort">Escort</option><option value="crew">Crew</option>
                  <option value="office">Office</option><option value="other">Other</option>
                </select>
              </label>
              <label className="text-sm">Status
                <select className="vessel-select" value={form.state} onChange={(e) => setForm({...form, state: e.target.value})}>
                  <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="SUSPENDED">Suspended</option>
                </select>
              </label>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Address</h4>
            <label className="text-sm">Present Address<Textarea rows={2} value={form.presentAddress} onChange={(e) => setForm({...form, presentAddress: e.target.value})} /></label>
            <label className="text-sm">Permanent Address<Textarea rows={2} value={form.permanentAddress} onChange={(e) => setForm({...form, permanentAddress: e.target.value})} /></label>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Reference</h4>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
              <label className="text-sm">Reference Name<Input value={form.referenceName} onChange={(e) => setForm({...form, referenceName: e.target.value})} /></label>
              <label className="text-sm">Reference Mobile<Input value={form.referenceMobile} onChange={(e) => setForm({...form, referenceMobile: e.target.value})} inputMode="tel" /></label>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Identity Documents</h4>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
              <label className="text-sm">NID Number<Input value={form.nidNumber} onChange={(e) => setForm({...form, nidNumber: e.target.value})} /></label>
              <label className="text-sm">Birth Certificate No.<Input value={form.birthCertNumber} onChange={(e) => setForm({...form, birthCertNumber: e.target.value})} /></label>
              <label className="text-sm">Passport Number<Input value={form.passportNumber} onChange={(e) => setForm({...form, passportNumber: e.target.value})} /></label>
            </div>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Notes</h4>
            <Textarea rows={3} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} />
          </section>
        </div>
      ) : employee ? (
        <div className="grid gap-4">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Profile</h4>
            <dl className="grid grid-cols-[150px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Mobile</dt><dd>{displayMobile(employee.employee_mobile)}</dd>
              <dt className="text-muted-foreground">Alt mobile</dt><dd>{dash(displayMobile(employee.alt_mobile))}</dd>
              <dt className="text-muted-foreground">Home phone</dt><dd>{dash(displayMobile(employee.home_phone))}</dd>
              <dt className="text-muted-foreground">Date of join</dt><dd>{dash(employee.date_of_join ?? employee.joined_on)}</dd>
              <dt className="text-muted-foreground">Designation</dt><dd>{dash(employee.designation)}</dd>
              <dt className="text-muted-foreground">Duty type</dt><dd>{dash(employee.duty_type)}</dd>
              <dt className="text-muted-foreground">State</dt><dd>{employee.state}</dd>
              <dt className="text-muted-foreground">Present address</dt><dd>{dash(employee.present_address)}</dd>
              <dt className="text-muted-foreground">Permanent address</dt><dd>{dash(employee.permanent_address)}</dd>
              <dt className="text-muted-foreground">Reference</dt><dd>{dash(employee.reference_name)} {employee.reference_mobile ? `· ${employee.reference_mobile}` : ''}</dd>
              <dt className="text-muted-foreground">NID</dt><dd>{dash(employee.nid_number)}</dd>
              <dt className="text-muted-foreground">Birth certificate</dt><dd>{dash(employee.birth_cert_number)}</dd>
              <dt className="text-muted-foreground">Passport</dt><dd>{dash(employee.passport_number)}</dd>
              <dt className="text-muted-foreground">Notes</dt><dd>{dash(employee.notes)}</dd>
            </dl>
          </section>
          <section>
            <h4 className="mb-2 text-sm font-semibold">Programs ({detail?.programs.length ?? 0})</h4>
            <table style={{fontSize: 12}}>
              <thead><tr><th>Vessel</th><th>Start</th><th>State</th><th>Pay</th></tr></thead>
              <tbody>
                {(detail?.programs ?? []).slice(0, 20).map((program) => (
                  <tr key={program.id}>
                    <td>{program.mother_vessel} → {program.lighter_vessel}</td>
                    <td>{program.start_date}</td><td>{program.state}</td><td>{money(program.total_minor)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section>
            <h4 className="mb-2 text-sm font-semibold">Attendance History</h4>
            <div style={{display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6}}>
              <input type="month" value={attMonth} onChange={(event) => setAttMonth(event.target.value)} />
              <span className="pill">Total {attSummary.totalDays.toFixed(2)} days</span>
              <span className="muted" style={{fontSize: 11}}>
                Vessel {attSummary.vesselDays.toFixed(2)} · Non-Vessel {attSummary.nonVesselDays.toFixed(2)}
              </span>
            </div>
            <table style={{fontSize: 12}}>
              <thead><tr><th>Date</th><th>Shift</th><th>Location</th><th>Source</th></tr></thead>
              <tbody>
                {attRows.slice(0, 20).map((entry) => (
                  <tr key={`${entry.source}-${entry.source_id}-${entry.shift}`}>
                    <td>{entry.attendance_date}</td>
                    <td>{entry.shift}</td>
                    <td>{entry.location ?? entry.client_name ?? '—'}</td>
                    <td>{entry.source === 'VESSEL' ? '🚢' : '📋'}</td>
                  </tr>
                ))}
                {!attRows.length ? <tr><td colSpan={4} className="muted">No attendance for this month.</td></tr> : null}
              </tbody>
            </table>
          </section>
        </div>
      ) : null}
    </DetailSidebar>
  );
}
