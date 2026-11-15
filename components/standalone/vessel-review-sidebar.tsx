'use client';

import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {displayMobile} from '@/lib/display-mobile';
import {formatDhakaDateTime} from '@/lib/review-ui';
import type {ReviewFields, UnifiedVesselReview} from '@/lib/standalone/vessel-review';

const withMv = (value: string) => {
  const name = String(value ?? '').trim();
  if (!name) return '—';
  return /^m\.?\s*v\.?\s+/i.test(name) ? name : `MV ${name}`;
};

const emptyFields: ReviewFields = {
  motherVessel: '', lighterVessel: '', masterMobile: '', masterName: '', destination: '',
  escortName: '', escortMobile: '', startDate: '', shift: '', endDate: '', endShift: '', notes: '',
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function reviewPayload(fields: ReviewFields): Record<string, unknown> {
  return {
    motherVessel: fields.motherVessel,
    lighterVessel: fields.lighterVessel,
    masterMobile: fields.masterMobile || null,
    destination: fields.destination || null,
    escortName: fields.escortName || null,
    escortMobile: fields.escortMobile || null,
    startDate: fields.startDate,
    startShift: fields.shift || undefined,
    endDate: fields.endDate || null,
    endShift: fields.endShift || null,
    notes: fields.notes || null,
  };
}

export function VesselReviewSidebar({
  row, onClose, onDone, canDecide, mothers, lighters, escortNames, escortMobiles,
}: {
  row: UnifiedVesselReview | null;
  onClose: () => void;
  onDone: () => void;
  canDecide: boolean;
  mothers: string[];
  lighters: string[];
  escortNames: string[];
  escortMobiles: string[];
}) {
  const [form, setForm] = useState<ReviewFields>(() => ({...emptyFields, ...(row?.fields ?? {})}));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');

  if (!row) return null;

  const manualOnly = row.suggestedWorkflow === 'cash'
    || row.suggestedWorkflow === 'confirmation'
    || (row.kind === 'item' && row.suggestedWorkflow === 'release');

  async function post(body: Record<string, unknown>) {
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

  async function save() {
    if (!row) return;
    setBusy('save');
    setError('');
    try {
      await post({
        action: 'vessel_review_draft', kind: row.kind, id: row.id,
        payload: reviewPayload(form), comment: 'Saved from review sidebar',
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Save failed.');
    } finally {
      setBusy('');
    }
  }

  async function approve() {
    if (!row) return;
    if (manualOnly) {
      setError('This item needs manual matching. Use Save and Decline, or handle it after v3.3.5 matching is available.');
      return;
    }
    setBusy('approve');
    setError('');
    try {
      await post({
        action: 'vessel_review_decide', kind: row.kind, id: row.id,
        decision: 'APPROVED', workflow: row.suggestedWorkflow,
        payload: reviewPayload(form), comment: 'Approved from review sidebar',
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approve failed.');
    } finally {
      setBusy('');
    }
  }

  async function decline() {
    if (!row) return;
    const why = reason.trim() || 'Declined from review queue';
    setBusy('decline');
    setError('');
    try {
      await post({
        action: 'vessel_review_decide', kind: row.kind, id: row.id,
        decision: 'REJECTED', workflow: row.suggestedWorkflow,
        payload: reviewPayload(form), comment: why,
      });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Decline failed.');
    } finally {
      setBusy('');
    }
  }

  return (
    <DetailSidebar
      open={Boolean(row)}
      onClose={onClose}
      title={`${withMv(form.motherVessel)} → ${withMv(form.lighterVessel)}`}
      description={<span className="pill warn">{row.kind === 'message' ? 'WhatsApp parser' : 'Review item'}</span>}
      footer={canDecide ? (
        <>
          <Button type="button" size="sm" variant="outline" onClick={onClose} disabled={Boolean(busy)}>Close</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void save()} disabled={Boolean(busy)}>
            {busy === 'save' ? 'Saving…' : 'Save Edit'}
          </Button>
          <Button type="button" size="sm" onClick={() => void approve()} disabled={Boolean(busy) || manualOnly}>
            {busy === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void decline()} disabled={Boolean(busy)}>
            {busy === 'decline' ? 'Declining…' : 'Decline'}
          </Button>
        </>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button>
      )}
    >
      <div className="grid gap-4">
        {error ? (
          <p className="error" style={{margin: 0, padding: '8px 10px', borderRadius: 6, background: '#fef2f2', border: '1px solid #fecaca', color: '#991b1b'}}>
            {error}
          </p>
        ) : null}

        <section>
          <h4 className="mb-2 text-sm font-semibold">Source message</h4>
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Sender</dt><dd>{row.sender || '—'}</dd>
            <dt className="text-muted-foreground">Mobile</dt><dd>{row.senderMobile ? displayMobile(row.senderMobile) : '—'}</dd>
            <dt className="text-muted-foreground">Date / time</dt><dd>{formatDhakaDateTime(row.timestamp)}</dd>
            <dt className="text-muted-foreground">Problem</dt><dd>{row.problem || '—'}</dd>
            <dt className="text-muted-foreground">Original text</dt>
            <dd style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{row.message || <span className="muted">No message text</span>}</dd>
          </dl>
        </section>

        <section>
          <h4 className="mb-2 text-sm font-semibold">Program</h4>
          <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
            <dt className="text-muted-foreground">Mother Vessel</dt>
            <dd>
              <Input list="review-vessel-mothers" value={form.motherVessel} onChange={(e) => setForm({...form, motherVessel: e.target.value})} />
              <datalist id="review-vessel-mothers">{mothers.map((name) => <option key={name} value={name} />)}</datalist>
            </dd>
            <dt className="text-muted-foreground">Lighter Vessel</dt>
            <dd>
              <Input list="review-vessel-lighters" value={form.lighterVessel} onChange={(e) => setForm({...form, lighterVessel: e.target.value})} />
              <datalist id="review-vessel-lighters">{lighters.map((name) => <option key={name} value={name} />)}</datalist>
            </dd>
            <dt className="text-muted-foreground">Master Name</dt>
            <dd>{form.masterName || '—'}</dd>
            <dt className="text-muted-foreground">Master Mobile</dt>
            <dd><Input value={form.masterMobile} onChange={(e) => setForm({...form, masterMobile: e.target.value})} inputMode="tel" /></dd>
            <dt className="text-muted-foreground">Destination</dt>
            <dd><Input value={form.destination} onChange={(e) => setForm({...form, destination: e.target.value})} /></dd>
            <dt className="text-muted-foreground">Escort Name</dt>
            <dd>
              <Input list="review-escort-names" value={form.escortName} onChange={(e) => setForm({...form, escortName: e.target.value})} />
              <datalist id="review-escort-names">{escortNames.map((name) => <option key={name} value={name} />)}</datalist>
            </dd>
            <dt className="text-muted-foreground">Escort Mobile</dt>
            <dd>
              <Input list="review-escort-mobiles" value={form.escortMobile} onChange={(e) => setForm({...form, escortMobile: e.target.value})} inputMode="tel" />
              <datalist id="review-escort-mobiles">{escortMobiles.map((mobile) => <option key={mobile} value={mobile} />)}</datalist>
            </dd>
            <dt className="text-muted-foreground">Start</dt>
            <dd>
              <span className="flex gap-2">
                <Input type="date" value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} />
                <select value={form.shift} onChange={(e) => setForm({...form, shift: e.target.value as ReviewFields['shift']})} className="h-9 rounded-md border bg-background px-2 text-sm">
                  <option value="">—</option><option value="D">D</option><option value="N">N</option>
                </select>
              </span>
            </dd>
            <dt className="text-muted-foreground">End</dt>
            <dd>
              <span className="flex gap-2">
                <Input type="date" value={form.endDate} onChange={(e) => setForm({...form, endDate: e.target.value})} />
                <select value={form.endShift} onChange={(e) => setForm({...form, endShift: e.target.value as ReviewFields['endShift']})} className="h-9 rounded-md border bg-background px-2 text-sm">
                  <option value="">—</option><option value="D">D</option><option value="N">N</option>
                </select>
              </span>
            </dd>
            <dt className="text-muted-foreground">Notes</dt>
            <dd><Textarea rows={2} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} /></dd>
          </dl>
        </section>

        <section>
          <h4 className="mb-2 text-sm font-semibold">Decline reason</h4>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Required to decline" />
        </section>

        <p className="muted" style={{margin: 0, fontSize: 12}}>
          {row.kind === 'message' ? 'Raw WhatsApp queue item.' : 'Review item.'} Approved rows leave the review queue and appear in the domain list.
        </p>
      </div>
    </DetailSidebar>
  );
}
