'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eye} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {EmployeeLookupDual} from '@/components/standalone/employee-lookup';
import {displayMobile} from '@/lib/display-mobile';
import {dateDdMmYyyy} from '@/lib/export-format';
import type {PendingAttendanceReview} from '@/lib/standalone/review';

type AttendanceForm = {
  employeeMobile: string; employeeName: string; attendanceDate: string;
  shift: 'D' | 'N' | 'FULL'; location: string; clientName: string;
  designation: string; remarks: string;
};

function formFrom(row: PendingAttendanceReview): AttendanceForm {
  const p = row.payload ?? {};
  const shift = String(p.shift ?? 'D').toUpperCase();
  return {
    employeeMobile: String(p.employeeMobile ?? ''),
    employeeName: String(row.preferred_name ?? p.employeeName ?? ''),
    attendanceDate: String(p.attendanceDate ?? p.dutyDate ?? '').slice(0, 10),
    shift: shift === 'N' || shift === 'FULL' ? shift : 'D',
    location: String(p.location ?? ''),
    clientName: String(p.clientName ?? ''),
    designation: String(p.designation ?? row.employee_designation ?? ''),
    remarks: String(p.remarks ?? ''),
  };
}

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

async function reviewPost(body: Record<string, unknown>) {
  const token = await csrfToken();
  const response = await fetch('/api/review', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({})) as {error?: string; detail?: string};
  if (!response.ok) throw new Error(payload.detail ?? payload.error ?? `HTTP_${response.status}`);
  return payload;
}

export function AttendanceReviewPanel({rows, canDecide}: {rows: PendingAttendanceReview[]; canDecide: boolean}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PendingAttendanceReview | null>(null);

  return (
    <section className="card" style={{marginBottom: 18, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Attendance Review ({rows.length})</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>Pending attendance submissions. Approve writes the attendance record.</p>
        </div>
      </div>
      {!rows.length ? <p className="muted" style={{margin: 0}}>No pending attendance review items.</p> : (
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 1100}}>
            <thead>
              <tr>
                <th style={{width: 96}}>Date</th><th>Employee ID</th><th>Employee Name</th>
                <th style={{width: 56}}>Shift</th><th>Location</th><th>Client</th>
                <th>Designation</th><th>Remarks</th><th>Source</th><th><span className="sr-only">View</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const p = row.payload ?? {};
                const date = String(p.attendanceDate ?? p.dutyDate ?? '');
                return (
                  <tr key={row.id}>
                    <td style={{whiteSpace: 'nowrap'}}>{date ? dateDdMmYyyy(date) : '—'}</td>
                    <td>{p.employeeMobile ? displayMobile(String(p.employeeMobile)) : '—'}</td>
                    <td>{row.preferred_name ?? String(p.employeeName ?? '—')}</td>
                    <td>{String(p.shift ?? '—')}</td>
                    <td>{String(p.location ?? '—')}</td>
                    <td>{String(p.clientName ?? '—')}</td>
                    <td>{String(p.designation ?? row.employee_designation ?? '—')}</td>
                    <td style={{maxWidth: 220, whiteSpace: 'pre-wrap'}}>{String(p.remarks ?? '—')}</td>
                    <td><span className="pill" style={{background: '#dcfce7', color: '#166534'}}>📋 Non-Vessel</span></td>
                    <td>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="View attendance review item" onClick={() => setSelected(row)}>
                        <Eye className="size-4" />
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <AttendanceReviewModal
          key={selected.id}
          row={selected}
          canDecide={canDecide}
          onClose={() => setSelected(null)}
          onDone={() => { setSelected(null); router.refresh(); }}
        />
      ) : null}
    </section>
  );
}

function AttendanceReviewModal({
  row, canDecide, onClose, onDone,
}: {
  row: PendingAttendanceReview;
  canDecide: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<AttendanceForm>(() => formFrom(row));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  async function correct() {
    await reviewPost({
      action: 'correct', kind: 'review_item', id: row.id, domain: 'ATTENDANCE',
      employeeMobile: form.employeeMobile,
      attendanceDate: form.attendanceDate,
      shift: form.shift,
      location: form.location || null,
      clientName: form.clientName || null,
      designation: form.designation || null,
      remarks: form.remarks || null,
    });
  }

  async function save() {
    setBusy('save'); setError('');
    try { await correct(); onDone(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed.'); }
    finally { setBusy(''); }
  }

  async function approve() {
    setBusy('approve'); setError('');
    try {
      await correct();
      await reviewPost({action: 'decide', kind: 'review_item', id: row.id, decision: 'APPROVED'});
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approve failed.'); }
    finally { setBusy(''); }
  }

  async function decline() {
    const why = reason.trim() || 'Declined from review queue';
    setBusy('decline'); setError('');
    try {
      await reviewPost({action: 'decide', kind: 'review_item', id: row.id, decision: 'REJECTED', reason: why});
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Decline failed.'); }
    finally { setBusy(''); }
  }

  return (
    <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="card" style={{width: 'min(720px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3 style={{margin: 0}}>Attendance review</h3><p className="muted" style={{marginTop: 2}}>{row.submitter_name ?? 'USER'} · {row.action}</p></div>
          <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>
        </div>
        {error ? <p className="error" style={{margin: '0 0 8px', padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b'}}>{error}</p> : null}
        <div className="grid gap-3">
          <EmployeeLookupDual
            initialMobile={form.employeeMobile}
            initialName={form.employeeName}
            onEmployeeSelect={(mobile, name) => setForm({...form, employeeMobile: mobile, employeeName: name})}
          />
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
            <label className="text-sm">Date *<Input type="date" value={form.attendanceDate} onChange={(e) => setForm({...form, attendanceDate: e.target.value})} /></label>
            <label className="text-sm">Shift *
              <select className="vessel-select" value={form.shift} onChange={(e) => setForm({...form, shift: e.target.value as AttendanceForm['shift']})}>
                <option value="D">D — Day</option><option value="N">N — Night</option><option value="FULL">FULL — Full day</option>
              </select>
            </label>
            <label className="text-sm">Location<Input value={form.location} onChange={(e) => setForm({...form, location: e.target.value})} /></label>
            <label className="text-sm">Client Name<Input value={form.clientName} onChange={(e) => setForm({...form, clientName: e.target.value})} /></label>
            <label className="text-sm">Designation<Input value={form.designation} onChange={(e) => setForm({...form, designation: e.target.value})} /></label>
          </div>
          <label className="text-sm">Remarks<Textarea rows={2} value={form.remarks} onChange={(e) => setForm({...form, remarks: e.target.value})} /></label>
          <label className="text-sm">Decline reason<Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required to decline" /></label>
          {canDecide ? (
            <div className="row-actions">
              <Button type="button" size="sm" variant="outline" onClick={() => void save()} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save Edit'}</Button>
              <Button type="button" size="sm" onClick={() => void approve()} disabled={Boolean(busy)}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => void decline()} disabled={Boolean(busy)}>{busy === 'decline' ? 'Declining…' : 'Decline'}</Button>
            </div>
          ) : <p className="muted">Review actions require ADMIN.</p>}
        </div>
      </div>
    </div>
  );
}
