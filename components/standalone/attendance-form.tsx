'use client';

import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {EmployeeLookupDual} from '@/components/standalone/employee-lookup';

export type AttendanceRecord = {
  id: string;
  employee_mobile: string;
  preferred_name?: string | null;
  attendance_date: string;
  shift: 'D' | 'N' | 'FULL';
  location: string | null;
  client_name: string | null;
  designation: string | null;
  remarks: string | null;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const today = () => new Date().toISOString().slice(0, 10);

export function AttendanceForm({
  record, onSaved, onCancel,
}: {
  record?: AttendanceRecord | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [mobile, setMobile] = useState(record?.employee_mobile ?? '');
  const [name, setName] = useState(record?.preferred_name ?? '');
  const [designation, setDesignation] = useState(record?.designation ?? '');
  const [date, setDate] = useState(record?.attendance_date ?? today());
  const [shift, setShift] = useState<'D' | 'N' | 'FULL'>(record?.shift ?? 'D');
  const [location, setLocation] = useState(record?.location ?? '');
  const [clientName, setClientName] = useState(record?.client_name ?? '');
  const [remarks, setRemarks] = useState(record?.remarks ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  /* eslint-disable react-hooks/set-state-in-effect -- the lookup clear is a local form reset. */
  useEffect(() => {
    if (!mobile) { setDesignation(''); return; }
    fetch(`/api/employees?mobile=${encodeURIComponent(mobile)}`, {cache: 'no-store'})
      .then((response) => response.ok ? response.json() : null)
      .then((body) => { if (body?.employee) setDesignation(body.employee.designation ?? ''); })
      .catch(() => undefined);
  }, [mobile]);
  /* eslint-enable react-hooks/set-state-in-effect */

  function reset() {
    setMobile(''); setName(''); setDesignation(''); setDate(today());
    setShift('D'); setLocation(''); setClientName(''); setRemarks(''); setError('');
  }

  async function save() {
    setBusy(true);
    setError('');
    try {
      if (!mobile) throw new Error('EMPLOYEE_REQUIRED');
      const token = await csrfToken();
      const response = await fetch(record ? `/api/attendance/${encodeURIComponent(record.id)}` : '/api/attendance', {
        method: record ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          employeeMobile: mobile,
          attendanceDate: date,
          dutyDate: date,
          shift,
          location: location.trim() || null,
          clientName: clientName.trim() || null,
          designation: designation || null,
          remarks: remarks.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        if (body.error === 'ATTENDANCE_EXISTS') throw new Error('এই তারিখে এই শিফটে হাজিরা ইতিমধ্যে আছে');
        throw new Error(body.error ?? `HTTP_${response.status}`);
      }
      if (body.pending) toast.success('Attendance submitted for review.');
      else toast.success(record ? 'Attendance updated.' : 'Attendance saved.');
      onSaved();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-3">
      <EmployeeLookupDual
        initialMobile={mobile}
        initialName={name}
        onEmployeeSelect={(nextMobile, nextName) => { setMobile(nextMobile); setName(nextName); }}
      />
      {designation ? <span className="pill" style={{width: 'fit-content'}}>{designation}</span> : null}

      <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
        <label className="text-sm">Date *<Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <label className="text-sm">Shift *
          <select className="vessel-select" value={shift} onChange={(e) => setShift(e.target.value as 'D' | 'N' | 'FULL')}>
            <option value="D">D — Day</option><option value="N">N — Night</option><option value="FULL">FULL — Full day</option>
          </select>
        </label>
        <label className="text-sm">Location<Input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Chittagong Port / Mongla Ghat" /></label>
        <label className="text-sm">Client Name<Input value={clientName} onChange={(e) => setClientName(e.target.value)} /></label>
      </div>
      <label className="text-sm">Remarks<Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} /></label>

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
      <div className="row-actions">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
        <Button type="button" size="sm" variant="outline" onClick={reset} disabled={busy}>Clear</Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
      </div>
    </div>
  );
}
