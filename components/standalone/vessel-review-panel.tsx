'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eye, FileText, MessageSquareText, TriangleAlert} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import {reviewExtractedFieldValues, reviewExtractedFields, reviewReasons} from '@/lib/review-ui';
import type {PendingProgramReview} from '@/lib/standalone/review';

/**
 * Vessel Program Review.
 *
 * PENDING PROGRAM review items are shown separately from the raw WhatsApp
 * message queue. Each row exposes the original message, the submitted/extracted
 * fields and an ADMIN decision dialog (edit → approve, or decline).
 */

const REQUIRED_FIELDS: Array<{key: string; label: string}> = [
  {key: 'motherVessel', label: 'Mother vessel'},
  {key: 'lighterVessel', label: 'Lighter vessel'},
  {key: 'startDate', label: 'Start date'},
  {key: 'startShift', label: 'Start shift'},
];

const EDIT_FIELDS: Array<{key: string; label: string; type?: 'date' | 'textarea'; options?: Array<{value: string; label: string}>}> = [
  {key: 'motherVessel', label: 'Mother vessel'},
  {key: 'lighterVessel', label: 'Lighter vessel'},
  {key: 'masterMobile', label: 'Master mobile'},
  {key: 'destination', label: 'Destination'},
  {key: 'escortName', label: 'Escort name'},
  {key: 'escortMobile', label: 'Escort mobile'},
  {key: 'startDate', label: 'Start date', type: 'date'},
  {key: 'startShift', label: 'Start shift', options: [{value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]},
  {key: 'endDate', label: 'End date', type: 'date'},
  {key: 'endShift', label: 'End shift', options: [{value: '', label: '—'}, {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]},
  {key: 'notes', label: 'Notes', type: 'textarea'},
];

const stamp = (value: string | null) => value ? value.replace('T', ' ').slice(0, 16) : '—';
const day = (value: string | null) => value ? value.slice(0, 10) : '—';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function mergedPayload(item: PendingProgramReview) {
  return {...(item.target ?? {}), ...(item.payload ?? {})};
}

function payloadFields(item: PendingProgramReview) {
  return reviewExtractedFields({domain: 'PROGRAM', payload: mergedPayload(item)});
}

function valuesFor(item: PendingProgramReview) {
  return reviewExtractedFieldValues({payload: mergedPayload(item)});
}

export function VesselReviewPanel({items}: {items: PendingProgramReview[]}) {
  const router = useRouter();
  const [source, setSource] = useState<PendingProgramReview | null>(null);
  const [submitted, setSubmitted] = useState<PendingProgramReview | null>(null);
  const [action, setAction] = useState<PendingProgramReview | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  function openAction(item: PendingProgramReview) {
    setAction(item);
    setEdit(valuesFor(item));
    setReason('');
    setError('');
  }

  async function post(body: Record<string, unknown>) {
    const token = await csrfToken();
    const response = await fetch('/api/review', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
    return payload;
  }

  async function approve() {
    if (!action) return;
    setBusy('approve');
    setError('');
    try {
      const initial = valuesFor(action);
      const changed: Record<string, string> = {};
      for (const field of EDIT_FIELDS) {
        const next = edit[field.key] ?? '';
        const previous = initial[field.key] ?? '';
        // Identity and start date/shift are required; never send an empty
        // value that the server would turn into NULL.
        if (['motherVessel', 'lighterVessel', 'startDate', 'startShift'].includes(field.key) && !next) continue;
        if (next !== previous) changed[field.key] = next;
      }
      if (Object.keys(changed).length) {
        await post({action: 'correct', kind: 'review_item', id: action.id, domain: 'PROGRAM', ...changed});
      }
      await post({action: 'decide', kind: 'review_item', id: action.id, decision: 'APPROVED'});
      setAction(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FAILED');
    } finally {
      setBusy('');
    }
  }

  async function decline() {
    if (!action) return;
    if (!reason.trim()) {
      setError('A reason is required to decline.');
      return;
    }
    setBusy('decline');
    setError('');
    try {
      await post({action: 'decide', kind: 'review_item', id: action.id, decision: 'REJECTED', reason: reason.trim()});
      setAction(null);
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FAILED');
    } finally {
      setBusy('');
    }
  }

  const sourceFields = source ? payloadFields(source) : [];
  const submittedFields = submitted ? payloadFields(submitted) : [];
  const submittedValues = submitted ? valuesFor(submitted) : {};
  const submittedReasons = submitted ? reviewReasons({payload: submitted.payload}) : [];

  return (
    <section className="card" style={{marginBottom: 18, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Vessel Program Review</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>
            Pending WhatsApp parser failures and USER submissions. These rows never count as programs until approved.
          </p>
        </div>
        <span className="pill warn">{items.length} pending program(s)</span>
      </div>

      {!items.length ? (
        <p className="muted" style={{margin: 0}}>No pending vessel program submissions.</p>
      ) : (
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 1080}}>
            <thead>
              <tr>
                <th>Mother Vessel</th>
                <th>Lighter Vessel</th>
                <th>Escort Name</th>
                <th>Start / End</th>
                <th>Source Message</th>
                <th>Submitted Data</th>
                <th>Submitted By / At</th>
                <th><span className="sr-only">Action</span></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const values = valuesFor(item);
                return (
                  <tr key={item.id}>
                    <td>{values.motherVessel ?? <span className="muted">—</span>}</td>
                    <td>
                      {values.lighterVessel ?? (
                        <span style={{display: 'inline-flex', alignItems: 'center', gap: 6, color: '#b45309'}}>
                          <TriangleAlert size={14} aria-hidden />
                          [অমীমাংসিত বার্তা / Unparsed Message]
                        </span>
                      )}
                    </td>
                    <td>{values.escortName ?? <span className="muted">—</span>}</td>
                    <td>
                      {day(values.startDate ?? null)} {values.startShift ?? ''}
                      <br />
                      <span className="muted">{day(values.endDate ?? null)} {values.endShift ?? ''}</span>
                    </td>
                    <td>
                      <Button type="button" size="sm" variant="outline" onClick={() => setSource(item)}>
                        <MessageSquareText className="size-4" /> সোর্স মেসেজ
                      </Button>
                    </td>
                    <td>
                      <Button type="button" size="sm" variant="outline" onClick={() => setSubmitted(item)}>
                        <FileText className="size-4" /> সাবমিটেড ডাটা
                      </Button>
                    </td>
                    <td>
                      {item.submitter_name ?? item.submitted_by}
                      <br />
                      <span className="muted">{stamp(item.created_at)}</span>
                    </td>
                    <td>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label="Review submission" onClick={() => openAction(item)}>
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

      {/* Popup A — Source Message */}
      <Dialog open={Boolean(source)} onOpenChange={(open) => { if (!open) setSource(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Source Message / সোর্স মেসেজ</DialogTitle>
            <DialogDescription>
              Original WhatsApp evidence for this submission.
            </DialogDescription>
          </DialogHeader>
          {source ? (
            <div style={{display: 'grid', gap: 12, fontSize: 13}}>
              <div className="grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <div><span className="muted">Sender name</span><br /><strong>{source.sender_name ?? '—'}</strong></div>
                <div><span className="muted">Mobile</span><br /><strong>{source.sender_mobile ?? '—'}</strong></div>
                <div><span className="muted">Timestamp</span><br />{stamp(source.source_timestamp)}</div>
                <div><span className="muted">Message ID</span><br />{source.source_message_id ?? '—'}</div>
              </div>
              <div>
                <span className="muted">Original message</span>
                <pre style={{
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '6px 0 0',
                  padding: 10, background: '#f8fafc', border: '1px solid #e2e8f0', borderRadius: 6,
                }}>
                  {source.raw_text ?? 'No WhatsApp source message. This submission was entered manually.'}
                </pre>
              </div>
              {sourceFields.length ? (
                <p className="muted" style={{margin: 0}}>
                  Parsed/extracted fields: {sourceFields.map((field) => field.label).join(', ')}
                </p>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSource(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Popup B — Submitted Data */}
      <Dialog open={Boolean(submitted)} onOpenChange={(open) => { if (!open) setSubmitted(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Submitted Data / সাবমিটেড ডাটা</DialogTitle>
            <DialogDescription>
              Field-by-field view of what was parsed or submitted. Missing required fields are highlighted.
            </DialogDescription>
          </DialogHeader>
          {submitted ? (
            <div style={{display: 'grid', gap: 12, fontSize: 13}}>
              <div className="grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                <div><span className="muted">Action</span><br /><strong>{submitted.action}</strong></div>
                <div><span className="muted">Category</span><br />{submitted.category ?? '—'}</div>
                <div><span className="muted">Target</span><br />{submitted.target_ref ?? 'New program'}</div>
                <div><span className="muted">Submitted by</span><br />{submitted.submitter_name ?? submitted.submitted_by}</div>
              </div>

              {submitted.action === 'UPDATE' && submitted.target ? (
                <p className="muted" style={{margin: 0}}>
                  Current program values merged with the pending edit. Unchanged fields stay as they are.
                </p>
              ) : null}
              <div style={{display: 'grid', gap: 6}}>
                {submittedFields.length ? submittedFields.map((field) => (
                  <div key={field.label} style={{display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, padding: '4px 0', borderBottom: '1px solid #eef2f7'}}>
                    <span className="muted">{field.label}</span>
                    <span>{field.value}</span>
                  </div>
                )) : <p className="muted" style={{margin: 0}}>No structured fields were extracted.</p>}
                {(submitted.action === 'UPDATE' && submitted.target ? [] : REQUIRED_FIELDS)
                  .filter((field) => !submittedValues[field.key]).map((field) => (
                  <div key={field.key} style={{
                    display: 'grid', gridTemplateColumns: '220px 1fr', gap: 8, padding: '4px 0',
                    background: '#fff7ed', color: '#9a3412',
                  }}>
                    <span>{field.label}</span>
                    <span style={{display: 'inline-flex', alignItems: 'center', gap: 6}}>
                      <TriangleAlert size={14} aria-hidden /> Missing — fill in before approving
                    </span>
                  </div>
                ))}
              </div>

              {submittedReasons.length ? (
                <div>
                  <span className="muted">Parser / review reasons</span>
                  <ul style={{margin: '4px 0 0', paddingLeft: 18}}>
                    {submittedReasons.map((entry, index) => (
                      <li key={`${entry.label}-${index}`}><strong>{entry.label}:</strong> {entry.value}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setSubmitted(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Popup C — Admin Action */}
      <Dialog open={Boolean(action)} onOpenChange={(open) => { if (!open && !busy) setAction(null); }}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Review action / অ্যাডমিন সিদ্ধান্ত</DialogTitle>
            <DialogDescription>
              {action?.action === 'UPDATE' && action?.target
                ? `Edit fields, then approve to update program ${action.target_ref}.`
                : 'Edit fields, then approve to create the program. Decline removes the row.'}
            </DialogDescription>
          </DialogHeader>
          {action ? (
            <div style={{display: 'grid', gap: 12}}>
              <div className="grid" style={{gridTemplateColumns: '1fr 1fr'}}>
                {EDIT_FIELDS.map((field) => (
                  <label key={field.key} style={{display: 'grid', gap: 4, fontSize: 13}}>
                    <span className="muted">{field.label}</span>
                    {field.type === 'textarea' ? (
                      <textarea
                        rows={3}
                        value={edit[field.key] ?? ''}
                        onChange={(event) => setEdit((current) => ({...current, [field.key]: event.target.value}))}
                        style={{padding: 6, border: '1px solid #cbd5e1', borderRadius: 6}}
                      />
                    ) : field.options ? (
                      <select
                        value={edit[field.key] ?? ''}
                        onChange={(event) => setEdit((current) => ({...current, [field.key]: event.target.value}))}
                        style={{padding: 6, border: '1px solid #cbd5e1', borderRadius: 6}}
                      >
                        {field.options.map((option) => (
                          <option key={option.value} value={option.value}>{option.label}</option>
                        ))}
                      </select>
                    ) : (
                      <input
                        type={field.type ?? 'text'}
                        value={edit[field.key] ?? ''}
                        onChange={(event) => setEdit((current) => ({...current, [field.key]: event.target.value}))}
                        style={{padding: 6, border: '1px solid #cbd5e1', borderRadius: 6}}
                      />
                    )}
                  </label>
                ))}
              </div>

              <label style={{display: 'grid', gap: 4, fontSize: 13}}>
                <span className="muted">Decline reason (required to decline)</span>
                <input
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Why is this submission declined?"
                  style={{padding: 6, border: '1px solid #cbd5e1', borderRadius: 6}}
                />
              </label>

              {error ? <p className="error" style={{margin: 0}}>{error}</p> : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={Boolean(busy)} onClick={() => setAction(null)}>Cancel</Button>
            <Button type="button" variant="destructive" disabled={Boolean(busy)} onClick={() => void decline()}>
              {busy === 'decline' ? 'Declining…' : 'Decline'}
            </Button>
            <Button type="button" disabled={Boolean(busy)} onClick={() => void approve()}>
              {busy === 'approve' ? 'Approving…' : 'Approve'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
