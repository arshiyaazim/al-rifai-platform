'use client';

import Link from 'next/link';
import {useState} from 'react';
import {toast} from 'sonner';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Label} from '@/components/ui/label';
import {Textarea} from '@/components/ui/textarea';
import type {CashTransaction} from './cash-transactions-table';
import {cashStateTone} from '@/lib/status-tone';
import {dateDdMmYyyy, dhakaTime12} from '@/lib/export-format';

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
const localDate = (value: string | null | undefined) =>
  value ? `${dateDdMmYyyy(value)} ${dhakaTime12(value)}` : '—';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function CashTransactionSidebar({
  transaction, onClose, onUpdated, canManage = false,
}: {
  transaction: CashTransaction | null;
  onClose: () => void;
  onUpdated?: (transaction: CashTransaction) => void;
  canManage?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<'correction' | 'reversal' | null>(null);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState({designation: '', amount: '', notes: ''});
  const [correction, setCorrection] = useState({amount: '', reason: ''});
  const [reversal, setReversal] = useState({amount: '', method: 'bkash', notes: '', reason: ''});
  const posted = transaction?.state === 'POSTED' || transaction?.state === 'SETTLED';
  const reversed = transaction?.state === 'REVERSED';

  const save = async () => {
    if (!transaction) return;
    setSaving(true);
    try {
      const token = await csrfToken();
      const amountMinor = Math.round(Number(edit.amount) * 100);
      if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) throw new Error('AMOUNT_INVALID');
      const response = await fetch(`/api/cash/transactions/${encodeURIComponent(transaction.id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          designation: transaction.employeeId ? (edit.designation.trim() || null) : null,
          amount: amountMinor,
          notes: edit.notes.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Transaction updated.');
      setEditing(false);
      onUpdated?.(body.transaction as CashTransaction);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Update failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  const startCorrection = () => {
    if (!transaction) return;
    setCorrection({
      amount: (Number(transaction.originalAmountMinor ?? transaction.amountMinor) / 100).toFixed(2),
      reason: '',
    });
    setEditing(false);
    setMode('correction');
  };

  const startReversal = () => {
    if (!transaction) return;
    setReversal({
      amount: (Number(transaction.originalAmountMinor ?? transaction.amountMinor) / 100).toFixed(2),
      method: transaction.method,
      notes: transaction.notes ?? '',
      reason: '',
    });
    setEditing(false);
    setMode('reversal');
  };

  const submitCorrection = async () => {
    if (!transaction) return;
    if (correction.reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters.', {duration: Infinity});
      return;
    }
    setSaving(true);
    try {
      const token = await csrfToken();
      const correctedAmount = Math.round(Number(correction.amount) * 100);
      if (!Number.isSafeInteger(correctedAmount) || correctedAmount <= 0) throw new Error('AMOUNT_INVALID');
      const response = await fetch(`/api/cash/transactions/${encodeURIComponent(transaction.id)}/correct`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({correctedAmount, reason: correction.reason.trim()}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Correction recorded. The original posting is untouched.');
      setMode(null);
      onUpdated?.(body.transaction as CashTransaction);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Correction failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  const submitReversal = async () => {
    if (!transaction) return;
    if (reversal.reason.trim().length < 10) {
      toast.error('Reason must be at least 10 characters.', {duration: Infinity});
      return;
    }
    setSaving(true);
    try {
      const token = await csrfToken();
      const newAmount = Math.round(Number(reversal.amount) * 100);
      if (!Number.isSafeInteger(newAmount) || newAmount <= 0) throw new Error('AMOUNT_INVALID');
      const response = await fetch(`/api/cash/transactions/${encodeURIComponent(transaction.id)}/reverse`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          amount: newAmount,
          method: reversal.method,
          notes: reversal.notes.trim() || null,
          reason: reversal.reason.trim(),
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Original reversed and a new POSTED transaction created.');
      setMode(null);
      onUpdated?.(body.original as CashTransaction);
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Reversal failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  return (
    <DetailSidebar
      open={Boolean(transaction)}
      onClose={() => { setEditing(false); onClose(); }}
      title={transaction ? dash(transaction.nameOfEmployee) : 'Transaction'}
      description={transaction ? `Payout #${transaction.payoutNumber} · ${transaction.state}` : undefined}
      footer={transaction ? (
        reversed ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); onClose(); }}>Close</Button>
            {transaction.employeeId ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/cash/employee/${encodeURIComponent(transaction.employeeId)}`}>All Transactions</Link>
              </Button>
            ) : null}
          </>
        ) : mode === 'correction' ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode(null)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void submitCorrection()} disabled={saving}>{saving ? 'Submitting…' : 'Submit Correction'}</Button>
          </>
        ) : mode === 'reversal' ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setMode(null)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void submitReversal()} disabled={saving}>{saving ? 'Submitting…' : 'Submit Reversal'}</Button>
          </>
        ) : posted ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); onClose(); }}>Close</Button>
            {canManage ? <Button type="button" size="sm" onClick={startCorrection}>Create Correction</Button> : null}
            {canManage ? <Button type="button" size="sm" variant="outline" onClick={startReversal}>Reverse &amp; Re-post</Button> : null}
            {transaction.employeeId ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/cash/employee/${encodeURIComponent(transaction.employeeId)}`}>All Transactions</Link>
              </Button>
            ) : null}
          </>
        ) : editing ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); onClose(); }}>Close</Button>
            <Button type="button" size="sm" onClick={() => setEditing(true)}>Edit</Button>
            {transaction.employeeId ? (
              <Button asChild size="sm" variant="outline">
                <Link href={`/cash/employee/${encodeURIComponent(transaction.employeeId)}`}>All Transactions</Link>
              </Button>
            ) : null}
          </>
        )
      ) : null}
    >
      {transaction ? (
        <div className="grid gap-4">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Employee</h4>
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Employee ID</dt><dd>{dash(transaction.employeeId)}</dd>
              <dt className="text-muted-foreground">Name</dt><dd>{dash(transaction.nameOfEmployee)}</dd>
              <dt className="text-muted-foreground">Designation</dt>
              <dd>{editing ? <Input value={edit.designation} onChange={(e) => setEdit({...edit, designation: e.target.value})} disabled={!transaction.employeeId} /> : dash(transaction.designation)}
                {editing && !transaction.employeeId ? <small className="muted">Register this employee to store a designation.</small> : null}</dd>
              <dt className="text-muted-foreground">Date of Join</dt><dd>{dash(transaction.dateOfJoin)}</dd>
            </dl>
          </section>
          <section>
            <h4 className="mb-2 text-sm font-semibold">This payout</h4>
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Payout number</dt><dd>{transaction.payoutNumber}</dd>
              <dt className="text-muted-foreground">Amount</dt>
              <dd>{editing ? (
                <Input type="number" min="0.01" step="0.01" value={edit.amount}
                  onChange={(e) => setEdit({...edit, amount: e.target.value})}
                  disabled={transaction.state === 'POSTED'} />
              ) : amount(transaction.amountMinor)}</dd>
              <dt className="text-muted-foreground">Date</dt><dd>{localDate(transaction.eventAt)}</dd>
              <dt className="text-muted-foreground">Method</dt><dd>{dash(transaction.method)}</dd>
              <dt className="text-muted-foreground">State</dt><dd><span className={`pill ${cashStateTone(transaction.state, transaction.correctionCount ?? 0)}`}>{transaction.state}</span></dd>
              <dt className="text-muted-foreground">Total paid</dt><dd>{amount(transaction.totalPaidMinor)}</dd>
            </dl>
          </section>
          {posted ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
              This transaction is posted and cannot be directly edited. Use Correction or Reversal to make changes.
            </div>
          ) : null}
          {reversed ? (
            <div className="rounded-md border bg-muted p-3 text-sm">
              This transaction was reversed. It is kept for audit and excluded from effective totals.
            </div>
          ) : null}
          {(transaction.correctionCount ?? 0) > 0 ? (
            <div className="rounded-md border bg-muted p-3 text-sm">
              Effective amount {amount(transaction.amountMinor)} (original {amount(transaction.originalAmountMinor)}; adjustment {amount(transaction.adjustmentMinor)}).
            </div>
          ) : null}
          {mode === 'correction' ? (
            <section className="grid gap-3 rounded-md border p-3">
              <h4 className="text-sm font-semibold">Create Correction</h4>
              <label className="text-sm">Corrected Amount (৳)
                <Input type="number" min="0.01" step="0.01" value={correction.amount} onChange={(e) => setCorrection({...correction, amount: e.target.value})} />
              </label>
              <label className="text-sm">Reason (min 10 characters)
                <Textarea rows={3} value={correction.reason} onChange={(e) => setCorrection({...correction, reason: e.target.value})} />
              </label>
              <p className="text-xs text-muted-foreground">The original POSTED amount and state remain unchanged. A new adjustment row records the difference.</p>
            </section>
          ) : null}
          {mode === 'reversal' ? (
            <section className="grid gap-3 rounded-md border p-3">
              <h4 className="text-sm font-semibold">Reverse &amp; Re-post</h4>
              <label className="text-sm">New Amount (৳)
                <Input type="number" min="0.01" step="0.01" value={reversal.amount} onChange={(e) => setReversal({...reversal, amount: e.target.value})} />
              </label>
              <label className="text-sm">Method
                <select value={reversal.method} onChange={(e) => setReversal({...reversal, method: e.target.value})} className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                  {['bkash','nagad','rocket','bank','cash'].map((method) => <option key={method} value={method}>{method}</option>)}
                </select>
              </label>
              <label className="text-sm">Notes
                <Textarea rows={2} value={reversal.notes} onChange={(e) => setReversal({...reversal, notes: e.target.value})} />
              </label>
              <label className="text-sm">Reason (min 10 characters)
                <Textarea rows={3} value={reversal.reason} onChange={(e) => setReversal({...reversal, reason: e.target.value})} />
              </label>
              <p className="text-xs text-muted-foreground">The original becomes REVERSED and a new POSTED transaction is created. Both remain in the audit history.</p>
            </section>
          ) : null}

          <section>
            <h4 className="mb-2 text-sm font-semibold">Source / evidence</h4>
            <dl className="grid grid-cols-[130px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Channel</dt><dd>{dash(transaction.source)}</dd>
              <dt className="text-muted-foreground">Source message</dt>
              <dd style={{overflowWrap: 'anywhere'}}>{transaction.sourceMessageId
                ? <Link href={`/messages?q=${encodeURIComponent(transaction.sourceMessageId)}`}>{transaction.sourceMessageId}</Link>
                : '—'}</dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>{editing
                ? <Textarea rows={3} value={edit.notes} onChange={(e) => setEdit({...edit, notes: e.target.value})} />
                : dash(transaction.notes)}</dd>
            </dl>
          </section>
          {editing ? (
            <p className="text-xs text-muted-foreground">
              Amount cannot be changed after financial posting. Designation is saved in the employee registry.
            </p>
          ) : null}
          <Label className="text-xs text-muted-foreground">Record {transaction.id}</Label>
        </div>
      ) : null}
    </DetailSidebar>
  );
}
