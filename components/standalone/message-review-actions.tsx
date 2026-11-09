'use client';

import {useState} from 'react';

export function MessageReviewActions({id}: {id: string}) {
  const [workflow, setWorkflow] = useState('Vessel');
  const [comment, setComment] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  async function submit(decision: 'APPROVED' | 'REJECTED' | 'IGNORED' | 'SENT_BACK') {
    setSaving(true);
    setError('');
    try {
      const session = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
      const csrf = (await session.json() as {csrf?: string}).csrf;
      if (!csrf) throw new Error('SESSION_EXPIRED');
      const response = await fetch('/api/review', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        body: JSON.stringify({action: 'vessel_queue_resolve', id, decision, workflow, comment}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FAILED');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-1" style={{minWidth: 220}}>
      <select value={workflow} onChange={(event) => setWorkflow(event.target.value)} className="h-8 rounded-md border bg-background px-2 text-xs">
        <option>Vessel</option><option>Cash</option><option>Employee</option><option>Release</option><option>Issue</option><option>Ignore</option>
      </select>
      <input value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Admin comment" className="h-8 rounded-md border bg-background px-2 text-xs" />
      <div className="flex flex-wrap gap-1">
        <button type="button" disabled={saving} onClick={() => void submit('APPROVED')} className="rounded border px-2 py-1 text-xs">Approve</button>
        <button type="button" disabled={saving} onClick={() => void submit('REJECTED')} className="rounded border px-2 py-1 text-xs">Reject</button>
        <button type="button" disabled={saving} onClick={() => void submit('SENT_BACK')} className="rounded border px-2 py-1 text-xs">Send back</button>
        <button type="button" disabled={saving} onClick={() => void submit('IGNORED')} className="rounded border px-2 py-1 text-xs">Ignore</button>
      </div>
      {error ? <span className="text-xs" style={{color: 'var(--danger, #b91c1c)'}}>{error}</span> : null}
    </div>
  );
}
