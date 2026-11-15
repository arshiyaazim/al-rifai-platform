'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eye} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {displayMobile} from '@/lib/display-mobile';
import type {PendingEmployeeReview} from '@/lib/standalone/review';

type EmployeeForm = {
  employeeMobile: string; preferredName: string; dutyType: string; designation: string;
  state: string; dateOfJoin: string; altMobile: string; homePhone: string;
  presentAddress: string; permanentAddress: string; referenceName: string;
  referenceMobile: string; nidNumber: string; birthCertNumber: string;
  passportNumber: string; notes: string;
};

const empty: EmployeeForm = {
  employeeMobile: '', preferredName: '', dutyType: 'other', designation: 'escort',
  state: 'ACTIVE', dateOfJoin: '', altMobile: '', homePhone: '',
  presentAddress: '', permanentAddress: '', referenceName: '',
  referenceMobile: '', nidNumber: '', birthCertNumber: '', passportNumber: '', notes: '',
};

const DESIGNATIONS = ['escort', 'crew', 'security', 'tally_man', 'scale_man', 'office', 'client', 'bondhu', 'bhai', 'accountant', 'other'];

function formFrom(row: PendingEmployeeReview): EmployeeForm {
  const p = row.payload ?? {};
  return {
    employeeMobile: String(p.employeeMobile ?? ''),
    preferredName: String(p.preferredName ?? ''),
    dutyType: String(p.dutyType ?? 'other'),
    designation: String(p.designation ?? 'escort').toLowerCase(),
    state: String(p.state ?? 'ACTIVE'),
    dateOfJoin: String(p.dateOfJoin ?? '').slice(0, 10),
    altMobile: String(p.altMobile ?? ''),
    homePhone: String(p.homePhone ?? ''),
    presentAddress: String(p.presentAddress ?? ''),
    permanentAddress: String(p.permanentAddress ?? ''),
    referenceName: String(p.referenceName ?? ''),
    referenceMobile: String(p.referenceMobile ?? ''),
    nidNumber: String(p.nidNumber ?? ''),
    birthCertNumber: String(p.birthCertNumber ?? ''),
    passportNumber: String(p.passportNumber ?? ''),
    notes: String(p.notes ?? ''),
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

export function EmployeeReviewPanel({rows, canDecide}: {rows: PendingEmployeeReview[]; canDecide: boolean}) {
  const router = useRouter();
  const [selected, setSelected] = useState<PendingEmployeeReview | null>(null);
  const [page, setPage] = useState(1);
  const limit = 20;
  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = rows.slice((safePage - 1) * limit, safePage * limit);

  return (
    <section className="card" style={{marginBottom: 18, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Employee Review ({rows.length})</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>Pending employee submissions. Approve creates the employee profile.</p>
        </div>
      </div>
      {!rows.length ? <p className="muted" style={{margin: 0}}>No pending employee review items.</p> : (
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 980}}>
            <thead>
              <tr>
                <th style={{width: 48}}>SL</th>
                <th>Employee ID</th><th>Name</th><th>Join Date</th><th>Designation</th>
                <th style={{textAlign: 'right'}}>Attendance</th><th style={{textAlign: 'right'}}>Salary</th>
                <th style={{textAlign: 'right'}}>Paid</th><th style={{textAlign: 'right'}}>Due</th>
                <th><span className="sr-only">View</span></th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => {
                const p = row.payload ?? {};
                return (
                  <tr key={row.id}>
                    <td style={{width: 48}}>{(safePage - 1) * limit + index + 1}</td>
                    <td>{p.employeeMobile ? displayMobile(String(p.employeeMobile)) : '—'}</td>
                    <td>{String(p.preferredName ?? '—')}</td>
                    <td>{String(p.dateOfJoin ?? '—')}</td>
                    <td>{String(p.designation ?? '—')}</td>
                    <td style={{textAlign: 'right'}}>—</td>
                    <td style={{textAlign: 'right'}}>—</td>
                    <td style={{textAlign: 'right'}}>—</td>
                    <td style={{textAlign: 'right'}}>—</td>
                    <td>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="View employee review item" onClick={() => setSelected(row)}>
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

      {pages > 1 ? (
        <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
          <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
          <span className="muted">Page {safePage} / {pages}</span>
          <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
        </div>
      ) : null}

      <EmployeeReviewSidebar
        key={selected?.id ?? 'none'}
        row={selected}
        canDecide={canDecide}
        onClose={() => setSelected(null)}
        onDone={() => { setSelected(null); router.refresh(); }}
      />
    </section>
  );
}

function EmployeeReviewSidebar({
  row, canDecide, onClose, onDone,
}: {
  row: PendingEmployeeReview | null;
  canDecide: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<EmployeeForm>(() => row ? formFrom(row) : empty);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (!row) return null;

  async function correct() {
    await reviewPost({action: 'correct', kind: 'review_item', id: row!.id, domain: 'EMPLOYEE', ...form});
  }

  async function save() {
    setBusy('save'); setError('');
    try {
      await correct();
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed.');
    } finally { setBusy(''); }
  }

  async function approve() {
    setBusy('approve'); setError('');
    try {
      await correct();
      await reviewPost({action: 'decide', kind: 'review_item', id: row!.id, decision: 'APPROVED'});
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approve failed.');
    } finally { setBusy(''); }
  }

  async function decline() {
    const why = reason.trim() || 'Declined from review queue';
    setBusy('decline'); setError('');
    try {
      await reviewPost({action: 'decide', kind: 'review_item', id: row!.id, decision: 'REJECTED', reason: why});
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Decline failed.');
    } finally { setBusy(''); }
  }

  return (
    <DetailSidebar
      open={Boolean(row)}
      onClose={onClose}
      title={form.preferredName || 'Employee review'}
      description={<span className="pill warn">{row.action} · {row.submitter_name ?? 'USER'}</span>}
      footer={canDecide ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={Boolean(busy)}>Close</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void save()} disabled={Boolean(busy)}>{busy === 'save' ? 'Saving…' : 'Save Edit'}</Button>
          <Button type="button" size="sm" onClick={() => void approve()} disabled={Boolean(busy)}>{busy === 'approve' ? 'Approving…' : 'Approve'}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void decline()} disabled={Boolean(busy)}>{busy === 'decline' ? 'Declining…' : 'Decline'}</Button>
        </>
      ) : <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>}
    >
      <div className="grid gap-3">
        {error ? <p className="error" style={{margin: 0, padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b'}}>{error}</p> : null}
        <section>
          <h4 className="mb-2 text-sm font-semibold">Basic Info</h4>
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: 8}}>
            <label className="text-sm">Employee Name *<Input value={form.preferredName} onChange={(e) => setForm({...form, preferredName: e.target.value})} /></label>
            <label className="text-sm">Employee ID / Mobile *<Input value={form.employeeMobile} onChange={(e) => setForm({...form, employeeMobile: e.target.value})} inputMode="tel" /></label>
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
                <option value="">—</option><option value="escort">Escort</option><option value="crew">Crew</option><option value="office">Office</option><option value="other">Other</option>
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
        <section>
          <h4 className="mb-2 text-sm font-semibold">Decline reason</h4>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required to decline" />
        </section>
      </div>
    </DetailSidebar>
  );
}
