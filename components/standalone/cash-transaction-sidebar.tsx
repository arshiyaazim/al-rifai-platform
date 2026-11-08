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

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
const localDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'short'}) : '—';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function CashTransactionSidebar({
  transaction, onClose, onUpdated,
}: {
  transaction: CashTransaction | null;
  onClose: () => void;
  onUpdated?: (transaction: CashTransaction) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [edit, setEdit] = useState({designation: '', amount: '', notes: ''});

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
          designation: edit.designation.trim() || null,
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

  return (
    <DetailSidebar
      open={Boolean(transaction)}
      onClose={() => { setEditing(false); onClose(); }}
      title={transaction ? dash(transaction.nameOfEmployee) : 'Transaction'}
      description={transaction ? `Payout #${transaction.payoutNumber} · ${transaction.state}` : undefined}
      footer={transaction ? (
        editing ? (
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
              <dd>{editing ? <Input value={edit.designation} onChange={(e) => setEdit({...edit, designation: e.target.value})} /> : dash(transaction.designation)}</dd>
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
              <dt className="text-muted-foreground">Date</dt><dd>{localDate(transaction.createdAt)}</dd>
              <dt className="text-muted-foreground">Method</dt><dd>{dash(transaction.method)}</dd>
              <dt className="text-muted-foreground">State</dt><dd><span className="pill">{transaction.state}</span></dd>
              <dt className="text-muted-foreground">Total paid</dt><dd>{amount(transaction.totalPaidMinor)}</dd>
            </dl>
          </section>
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
