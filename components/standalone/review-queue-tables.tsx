'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useState} from 'react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {
  formatReviewAmount,
  formatReviewTimestamp,
  reviewCategoryLabel,
  reviewCategoryTone,
  reviewDomainLabel,
  reviewStateLabel,
  reviewStateTone,
} from '@/lib/review-ui';

export type ReviewQueueRow = {
  id: string;
  domain: string;
  category: string | null;
  state: string;
  target_ref: string | null;
  submitter_name: string | null;
  submitted_by: string;
  created_at: string;
};

export type CashCandidateRow = {
  id: string;
  category: string | null;
  state: string;
  submitter_name: string | null;
  submitted_by: string;
  created_at: string;
  source_message_id: string | null;
  payload: Record<string, unknown>;
};

type Selection = Map<string, 'review_item' | 'cash_submission'>;

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function ReviewQueueTables({
  rows, cashCandidates, canBulkReject = false,
}: {
  rows: ReviewQueueRow[];
  cashCandidates: CashCandidateRow[];
  canBulkReject?: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<Selection>(new Map());
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const selectableCash = cashCandidates.filter((row) => row.state === 'PENDING_REVIEW');
  const selectableReviews = rows.filter((row) => row.state === 'PENDING');
  const allSelectable = [...selectableCash, ...selectableReviews].filter((row) => !selected.has(row.id)).length === 0
    && selected.size > 0;

  const toggle = (id: string, kind: 'review_item' | 'cash_submission', state: string) => {
    if (!canBulkReject) return;
    const terminal = kind === 'cash_submission' ? state !== 'PENDING_REVIEW' : state !== 'PENDING';
    if (terminal) return;
    setSelected((current) => {
      const next = new Map(current);
      if (next.has(id)) next.delete(id); else next.set(id, kind);
      return next;
    });
  };

  const toggleAll = () => {
    if (!canBulkReject) return;
    setSelected((current) => {
      if (current.size > 0) return new Map();
      const next = new Map<string, 'review_item' | 'cash_submission'>();
      for (const row of selectableCash) next.set(row.id, 'cash_submission');
      for (const row of selectableReviews) next.set(row.id, 'review_item');
      return next;
    });
  };

  const rejectSelected = async () => {
    if (selected.size === 0) return;
    if (selected.size > 50) {
      toast.error('Select at most 50 items per bulk rejection.', {duration: Infinity});
      return;
    }
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/review/bulk-reject', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({ids: Array.from(selected.keys()), reason: reason.trim()}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      const succeeded = (body.succeeded ?? []) as string[];
      const failed = (body.failed ?? []) as Array<{id: string; error: string}>;
      const skipped = (body.skipped ?? []) as Array<{id: string; error: string}>;
      const failedIds = new Set([...failed, ...skipped].map((item) => item.id));
      setSelected((current) => {
        const next = new Map<string, 'review_item' | 'cash_submission'>();
        for (const [id, kind] of current) if (failedIds.has(id)) next.set(id, kind);
        return next;
      });
      if (failed.length || skipped.length) {
        toast.warning(`${succeeded.length} rejected · ${failed.length} failed · ${skipped.length} skipped`);
      } else {
        toast.success(`${succeeded.length} review item(s) rejected.`);
      }
      setConfirming(false);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Bulk rejection failed.', {duration: Infinity});
    } finally {
      setBusy(false);
    }
  };

  const checkbox = (id: string, kind: 'review_item' | 'cash_submission', state: string) => {
    const terminal = kind === 'cash_submission' ? state !== 'PENDING_REVIEW' : state !== 'PENDING';
    return (
      <input
        type="checkbox"
        aria-label={`Select item ${id}`}
        checked={selected.has(id)}
        disabled={!canBulkReject || terminal}
        onChange={() => toggle(id, kind, state)}
      />
    );
  };

  return (
    <>
      <AppToaster />
      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Cash review candidates ({cashCandidates.length})</h3></div>
          <span className="muted">Approving a candidate does not post or settle funds.</span>
        </div>
        {canBulkReject ? (
          <p className="muted" style={{marginTop: 0}}>
            Select pending items to reject them together. Approved items are excluded; use the item detail to reverse them.
          </p>
        ) : null}
        {cashCandidates.length ? (
          <table>
            <thead>
              <tr>
                {canBulkReject ? <th style={{width: 34}}><input type="checkbox" aria-label="Select all cash candidates" checked={allSelectable} onChange={toggleAll} /></th> : null}
                <th>Candidate</th><th>Category</th><th>State</th><th>Submitter</th><th>Created</th><th>Source message</th><th>Parsed</th><th>Review</th>
              </tr>
            </thead>
            <tbody>
              {cashCandidates.map((candidate) => {
                const payload = candidate.payload ?? {};
                return (
                  <tr key={candidate.id}>
                    {canBulkReject ? <td>{checkbox(candidate.id, 'cash_submission', candidate.state)}</td> : null}
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{candidate.id}</td>
                    <td><span className={`pill ${reviewCategoryTone(candidate.category)}`}>{reviewCategoryLabel(candidate.category)}</span></td>
                    <td><span className={`pill ${reviewStateTone(candidate.state)}`}>{reviewStateLabel(candidate.state)}</span></td>
                    <td>{candidate.submitter_name ?? candidate.submitted_by.slice(0, 12)}</td>
                    <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(candidate.created_at)}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      {candidate.source_message_id ? (
                        <Link href={`/messages?q=${encodeURIComponent(candidate.source_message_id)}`}>{candidate.source_message_id}</Link>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td style={{maxWidth: 320}}>
                      <div>{String(payload.employeeName ?? payload.employee_name ?? '—')}</div>
                      <div className="muted">{formatReviewAmount(payload.amountMinor as string | number | null)} · {String(payload.method ?? '—')}</div>
                    </td>
                    <td><Link href={`/review/${candidate.id}`}>Inspect →</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No cash review candidates match the current filters.</p>}
      </section>

      <section className="card">
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Review items ({rows.length})</h3></div>
          <span className="muted">Program, employee and attendance reviews.</span>
        </div>
        {rows.length ? (
          <table>
            <thead>
              <tr>
                {canBulkReject ? <th style={{width: 34}}><input type="checkbox" aria-label="Select all review items" checked={allSelectable} onChange={toggleAll} /></th> : null}
                <th>Item</th><th>Domain</th><th>Category</th><th>State</th><th>Target</th><th>Submitter</th><th>Created</th><th>Review</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  {canBulkReject ? <td>{checkbox(item.id, 'review_item', item.state)}</td> : null}
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</td>
                  <td>{reviewDomainLabel(item.domain)}</td>
                  <td><span className={`pill ${reviewCategoryTone(item.category)}`}>{reviewCategoryLabel(item.category)}</span></td>
                  <td><span className={`pill ${reviewStateTone(item.state)}`}>{reviewStateLabel(item.state)}</span></td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.target_ref ?? '—'}</td>
                  <td>{item.submitter_name ?? item.submitted_by.slice(0, 12)}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(item.created_at)}</td>
                  <td><Link href={`/review/${item.id}`}>Inspect →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No review items match the current filters.</p>}
      </section>

      {selected.size > 0 ? (
        <div className="bulk-bar" role="region" aria-label="Bulk review actions">
          <span><strong>{selected.size}</strong> selected</span>
          <button type="button" className="danger" onClick={() => setConfirming(true)} disabled={busy}>Reject Selected ({selected.size})</button>
          <button type="button" className="ghost" onClick={() => setSelected(new Map())} disabled={busy}>Clear Selection</button>
        </div>
      ) : null}

      {confirming ? (
        <div className="bulk-dialog" role="dialog" aria-modal="true" aria-labelledby="bulk-reject-title">
          <div className="bulk-dialog__panel">
            <h3 id="bulk-reject-title">Reject {selected.size} review item(s)?</h3>
            <p className="muted">This cannot be undone. Approved items will be skipped and must be reversed through their domain workflow.</p>
            <label className="wx-field" style={{marginTop: 12}}>
              <span>Reason (optional, applies to all)</span>
              <textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} />
            </label>
            <div className="row-actions" style={{justifyContent: 'flex-end', marginTop: 14}}>
              <button type="button" className="ghost" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
              <button type="button" className="danger" onClick={() => void rejectSelected()} disabled={busy}>
                {busy ? 'Rejecting…' : 'Confirm Reject'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
