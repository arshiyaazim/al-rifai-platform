'use client';

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';

type Detail = {
  employee: {
    employee_mobile: string; preferred_name: string; duty_type: string | null;
    designation: string | null; state: string; joined_on: string | null;
    notes: string | null; created_at: string;
  };
  programs: Array<{id: string; mother_vessel: string; lighter_vessel: string; start_date: string; end_date: string | null; state: string; total_minor: string | null}>;
  attendance: Array<{duty_date: string; shift: string; state: string; hours: string | null}>;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const money = (minor: string | null) => minor === null ? '—' : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;

export function EmployeeDetailSidebar({
  mobile, onClose, onUpdated, canManage,
}: {
  mobile: string | null;
  onClose: () => void;
  onUpdated?: () => void;
  canManage: boolean;
}) {
  const [detail, setDetail] = useState<Detail | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({preferredName: '', dutyType: '', designation: '', state: 'ACTIVE', notes: ''});

  useEffect(() => {
    if (!mobile) return;
    const controller = new AbortController();
    fetch(`/api/employees?mobile=${encodeURIComponent(mobile)}`, {headers: {accept: 'application/json'}, signal: controller.signal})
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: Detail) => { if (!controller.signal.aborted) setDetail(payload); })
      .catch(() => { if (!controller.signal.aborted) toast.error('Employee could not be loaded.', {duration: Infinity}); });
    return () => controller.abort();
  }, [mobile]);

  const startEdit = () => {
    if (!detail) return;
    const e = detail.employee;
    setForm({
      preferredName: e.preferred_name, dutyType: e.duty_type ?? '',
      designation: e.designation ?? '', state: e.state, notes: e.notes ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!detail) return;
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/employees', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          employeeMobile: detail.employee.employee_mobile,
          preferredName: form.preferredName.trim(),
          dutyType: form.dutyType || null,
          designation: form.designation.trim() || null,
          state: form.state,
          notes: form.notes.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Employee updated.');
      setEditing(false);
      onUpdated?.();
      setDetail((current) => current ? {
        ...current,
        employee: {...current.employee, preferred_name: form.preferredName.trim(),
          duty_type: form.dutyType || null, designation: form.designation.trim() || null,
          state: form.state, notes: form.notes.trim() || null},
      } : current);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Update failed.', {duration: Infinity});
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    if (!window.confirm(`Mark ${detail.employee.preferred_name} INACTIVE? The record is kept.`)) return;
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/employees', {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({employeeMobile: detail.employee.employee_mobile, state: 'INACTIVE'}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Employee marked INACTIVE.');
      onUpdated?.();
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Delete failed.', {duration: Infinity});
    } finally {
      setBusy(false);
    }
  };

  const employee = detail?.employee;
  return (
    <DetailSidebar
      open={Boolean(mobile)}
      onClose={() => { setEditing(false); onClose(); }}
      title={employee ? employee.preferred_name : 'Employee'}
      description={employee ? `${employee.employee_mobile} · ${employee.state}` : undefined}
      footer={employee ? (
        editing ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Save'}</Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>
            {canManage ? <Button type="button" size="sm" onClick={startEdit}>Edit</Button> : null}
            <Button asChild size="sm" variant="outline">
              <Link href={`/vessel?escort_mobile=${encodeURIComponent(employee.employee_mobile)}`}>All Programs</Link>
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link href={`/cash?employee=${encodeURIComponent(employee.employee_mobile)}`}>All Transactions</Link>
            </Button>
            {canManage && employee.state !== 'INACTIVE' ? (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>Delete</Button>
            ) : null}
          </>
        )
      ) : null}
    >
      {!employee ? <p className="muted">Loading employee…</p> : (
        <div className="grid gap-4">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Profile</h4>
            {editing ? (
              <div className="grid gap-2">
                <label className="text-sm">Name<Input value={form.preferredName} onChange={(e) => setForm({...form, preferredName: e.target.value})} /></label>
                <label className="text-sm">Duty type
                  <select className="vessel-select" value={form.dutyType} onChange={(e) => setForm({...form, dutyType: e.target.value})}>
                    <option value="">—</option><option value="escort">Escort</option><option value="crew">Crew</option>
                    <option value="office">Office</option><option value="other">Other</option>
                  </select>
                </label>
                <label className="text-sm">Designation<Input value={form.designation} onChange={(e) => setForm({...form, designation: e.target.value})} /></label>
                <label className="text-sm">State
                  <select className="vessel-select" value={form.state} onChange={(e) => setForm({...form, state: e.target.value})}>
                    <option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="SUSPENDED">Suspended</option>
                  </select>
                </label>
                <label className="text-sm">Notes<Textarea rows={2} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} /></label>
              </div>
            ) : (
              <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Mobile</dt><dd>{employee.employee_mobile}</dd>
                <dt className="text-muted-foreground">Duty type</dt><dd>{dash(employee.duty_type)}</dd>
                <dt className="text-muted-foreground">Designation</dt><dd>{dash(employee.designation)}</dd>
                <dt className="text-muted-foreground">State</dt><dd>{employee.state}</dd>
                <dt className="text-muted-foreground">Joined</dt><dd>{dash(employee.joined_on)}</dd>
                <dt className="text-muted-foreground">Created</dt><dd>{dash(employee.created_at)}</dd>
                <dt className="text-muted-foreground">Notes</dt><dd>{dash(employee.notes)}</dd>
              </dl>
            )}
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
            <h4 className="mb-2 text-sm font-semibold">Attendance ({detail?.attendance.length ?? 0})</h4>
            <p className="muted" style={{fontSize: 12}}>
              {(detail?.attendance ?? []).slice(0, 8).map((entry) => `${entry.duty_date}(${entry.shift}) ${entry.state}`).join(' · ') || '—'}
            </p>
          </section>
        </div>
      )}
    </DetailSidebar>
  );
}
