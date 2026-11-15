'use client';

import {useEffect, useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eye} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {EmployeeLookup, type EmployeeSuggestion} from '@/components/standalone/employee-lookup';
import {displayMobile} from '@/lib/display-mobile';
import {dateDdMmYyyy, dhakaTime12} from '@/lib/export-format';
import {formatDhakaDateTime, formatReviewAmount} from '@/lib/review-ui';
import type {CashReviewCandidate} from '@/lib/standalone/review';

type EmployeeOption = {mobile: string; name: string; designation: string | null; dateOfJoin: string | null};
type AccountOption = {id: string; code: string; name: string};

type CashForm = {
  employeeName: string; employeeMobile: string; payoutMobile: string;
  method: string; amount: string; accountId: string; purpose: string;
};

const empty: CashForm = {
  employeeName: '', employeeMobile: '', payoutMobile: '',
  method: 'bkash', amount: '', accountId: '', purpose: '',
};

const nested = (payload: Record<string, unknown>, key: string): unknown => {
  const fields = payload.fields && typeof payload.fields === 'object' ? payload.fields as Record<string, unknown> : {};
  return payload[key] ?? fields[key];
};

function formFrom(row: CashReviewCandidate, accounts: AccountOption[]): CashForm {
  const p = row.payload ?? {};
  const amountMinor = Number(nested(p, 'amountMinor') ?? 0);
  return {
    employeeName: String(nested(p, 'employeeName') ?? ''),
    employeeMobile: String(nested(p, 'employeeMobile') ?? nested(p, 'employeeId') ?? ''),
    payoutMobile: String(nested(p, 'payoutMobile') ?? nested(p, 'payoutNumber') ?? ''),
    method: String(nested(p, 'method') ?? 'bkash').toLowerCase(),
    amount: amountMinor > 0 ? (amountMinor / 100).toFixed(2) : String(nested(p, 'amount') ?? ''),
    accountId: String(nested(p, 'accountId') ?? accounts[0]?.id ?? ''),
    purpose: String(nested(p, 'purpose') ?? ''),
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

export function CashReviewPanel({
  rows, employees, accounts, canDecide,
}: {
  rows: CashReviewCandidate[];
  employees: EmployeeOption[];
  accounts: AccountOption[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<CashReviewCandidate | null>(null);
  const byMobile = new Map(employees.map((employee) => [employee.mobile.replace(/[^0-9]/g, '').slice(-10), employee]));

  return (
    <section className="card" style={{marginBottom: 18, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Cash Review ({rows.length})</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>AI-extracted cash messages pending review. Approve creates a REVIEW cash instruction; it does not post funds.</p>
        </div>
      </div>
      {!rows.length ? <p className="muted" style={{margin: 0}}>No pending cash review items.</p> : (
        <div className="cash-table-scroll">
          <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 940}}>
            <colgroup>
              <col style={{width: 88}} /><col style={{width: 110}} /><col style={{width: 180}} />
              <col style={{width: 120}} /><col style={{width: 100}} /><col style={{width: 70}} />
              <col style={{width: 100}} /><col style={{width: 100}} /><col style={{width: 50}} />
            </colgroup>
            <thead>
              <tr>
                <th>Date</th><th>Employee ID</th><th>Name</th><th>Designation</th><th>Date of Join</th>
                <th style={{textAlign: 'center'}}>Payouts</th><th style={{textAlign: 'right'}}>Amount</th>
                <th style={{textAlign: 'right'}}>Total Paid</th><th><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const p = row.payload ?? {};
                const mobile = String(nested(p, 'employeeId') ?? nested(p, 'employeeMobile') ?? '');
                const employee = byMobile.get(mobile.replace(/[^0-9]/g, '').slice(-10));
                const timestamp = String(nested(p, 'sourceTimestamp') ?? row.created_at ?? '');
                return (
                  <tr key={row.id}>
                    <td className="cash-date">
                      <div>{timestamp ? dateDdMmYyyy(timestamp) : '—'}</div>
                      <small className="muted">{timestamp ? dhakaTime12(timestamp) : ''}</small>
                    </td>
                    <td>{mobile ? displayMobile(mobile) : <span className="muted">—</span>}</td>
                    <td>{String(nested(p, 'employeeName') ?? employee?.name ?? '—')}</td>
                    <td>{employee?.designation ?? '—'}</td>
                    <td>{employee?.dateOfJoin ? dateDdMmYyyy(employee.dateOfJoin) : '—'}</td>
                    <td style={{textAlign: 'center'}}>—</td>
                    <td className="cash-amount" style={{textAlign: 'right'}}>{formatReviewAmount(nested(p, 'amountMinor') as string | number | null)}</td>
                    <td className="cash-amount" style={{textAlign: 'right'}}>—</td>
                    <td style={{textAlign: 'center'}}>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="View cash review item" onClick={() => setSelected(row)}>
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

      <CashReviewSidebar
        key={selected?.id ?? 'none'}
        row={selected}
        accounts={accounts}
        canDecide={canDecide}
        onClose={() => setSelected(null)}
        onDone={() => { setSelected(null); router.refresh(); }}
      />
    </section>
  );
}

function CashReviewSidebar({
  row, accounts, canDecide, onClose, onDone,
}: {
  row: CashReviewCandidate | null;
  accounts: AccountOption[];
  canDecide: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [form, setForm] = useState<CashForm>(() => row ? formFrom(row, accounts) : empty);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [source, setSource] = useState<{sender: string; mobile: string; text: string; timestamp: string} | null>(null);

  useEffect(() => {
    if (!row) return;
    const controller = new AbortController();
    fetch(`/api/review?id=${encodeURIComponent(row.id)}`, {signal: controller.signal, cache: 'no-store'})
      .then((response) => response.ok ? response.json() : null)
      .then((body) => {
        if (controller.signal.aborted || !body?.detail) return;
        const detail = body.detail;
        const message = (detail.sourceMessages ?? [])[0];
        const payload = (detail.item?.payload ?? {}) as Record<string, unknown>;
        setSource({
          sender: String(message?.sender_name ?? ''),
          mobile: String(message?.sender_mobile ?? ''),
          text: String(message?.text_content ?? payload.rawText ?? ''),
          timestamp: String(message?.source_timestamp ?? payload.sourceTimestamp ?? row.created_at ?? ''),
        });
      })
      .catch(() => undefined);
    return () => controller.abort();
  }, [row, accounts]);

  if (!row) return null;

  function payload(): Record<string, unknown> {
    const amountMinor = Math.round(Number(form.amount) * 100);
    return {
      employeeName: form.employeeName,
      employeeMobile: form.employeeMobile || null,
      payoutMobile: form.payoutMobile || null,
      method: form.method,
      amountMinor,
      accountId: form.accountId || null,
      purpose: form.purpose || null,
    };
  }

  async function correct() {
    if (!Number.isSafeInteger(Math.round(Number(form.amount) * 100)) || Number(form.amount) <= 0) {
      throw new Error('Amount must be greater than zero.');
    }
    await reviewPost({action: 'correct', kind: 'cash_submission', id: row!.id, domain: 'CASH', ...payload()});
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
      await reviewPost({action: 'decide', kind: 'cash_submission', id: row!.id, decision: 'APPROVED'});
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Approve failed.'); }
    finally { setBusy(''); }
  }

  async function decline() {
    if (!reason.trim()) { setError('Reason is required to decline.'); return; }
    setBusy('decline'); setError('');
    try {
      await reviewPost({action: 'decide', kind: 'cash_submission', id: row!.id, decision: 'REJECTED', reason: reason.trim()});
      onDone();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Decline failed.'); }
    finally { setBusy(''); }
  }

  return (
    <DetailSidebar
      open={Boolean(row)}
      onClose={onClose}
      title={form.employeeName || 'Cash review'}
      description={<span className="pill warn">{row.category ?? 'Cash candidate'}</span>}
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
        {source ? (
          <section>
            <h4 className="mb-2 text-sm font-semibold">Source message</h4>
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Sender</dt><dd>{source.sender || '—'}</dd>
              <dt className="text-muted-foreground">Mobile</dt><dd>{source.mobile ? displayMobile(source.mobile) : '—'}</dd>
              <dt className="text-muted-foreground">Date / time</dt><dd>{formatDhakaDateTime(source.timestamp)}</dd>
              <dt className="text-muted-foreground">Original text</dt><dd style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{source.text || '—'}</dd>
            </dl>
          </section>
        ) : null}
        <section>
          <h4 className="mb-2 text-sm font-semibold">Payment</h4>
          <div className="grid gap-3">
            <EmployeeLookup
              id="review-cash-employee"
              label="Employee / payee name"
              placeholder="Name, alias or mobile"
              value={form.employeeName}
              onChange={(value) => setForm({...form, employeeName: value})}
              onSelect={(employee: EmployeeSuggestion) => setForm({
                ...form,
                employeeName: employee.preferred_name,
                employeeMobile: employee.employee_mobile,
                payoutMobile: form.payoutMobile || employee.employee_mobile,
              })}
              required
            />
            <label className="text-sm">Employee ID / mobile<Input value={form.employeeMobile} onChange={(e) => setForm({...form, employeeMobile: e.target.value})} inputMode="tel" /></label>
            <label className="text-sm">Payout number<Input value={form.payoutMobile} onChange={(e) => setForm({...form, payoutMobile: e.target.value})} inputMode="tel" /></label>
            <label className="text-sm">Method
              <select className="vessel-select" value={form.method} onChange={(e) => setForm({...form, method: e.target.value})}>
                <option value="bkash">bKash</option><option value="nagad">Nagad</option><option value="rocket">Rocket</option>
                <option value="bank">Bank</option><option value="cash">Cash</option>
              </select>
            </label>
            <label className="text-sm">Amount (BDT)<Input type="number" min="0.01" step="0.01" value={form.amount} onChange={(e) => setForm({...form, amount: e.target.value})} /></label>
            <label className="text-sm">Pay from
              <select className="vessel-select" value={form.accountId} onChange={(e) => setForm({...form, accountId: e.target.value})}>
                {accounts.map((account) => <option key={account.id} value={account.id}>{account.code} — {account.name}</option>)}
              </select>
            </label>
            <label className="text-sm">Purpose<Input value={form.purpose} onChange={(e) => setForm({...form, purpose: e.target.value})} /></label>
          </div>
        </section>
        <section>
          <h4 className="mb-2 text-sm font-semibold">Decline reason</h4>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required to decline" />
        </section>
        <p className="muted" style={{margin: 0, fontSize: 12}}>Approve creates a REVIEW cash instruction; posting remains a separate admin step.</p>
      </div>
    </DetailSidebar>
  );
}
