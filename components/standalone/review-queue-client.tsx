'use client';

import {useMemo, useState} from 'react';
import {Button} from '@/components/ui/button';

export type ReviewRow = {
  kind: 'message' | 'item';
  id: string;
  sender: string;
  chatType: 'Direct' | 'Group';
  chatJid: string;
  problem: string;
  reasonCode: string;
  message: string;
  timestamp: string;
  createdAt: string;
  fields: {
    motherVessel: string; lighterVessel: string; masterMobile: string;
    escortName: string; escortMobile: string; startDate: string; shift: '' | 'D' | 'N';
  };
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const stamp = (value: string) => value ? value.replace('T', ' ').slice(0, 16) : '—';

export function ReviewQueueClient({rows}: {rows: ReviewRow[]}) {
  const [page, setPage] = useState(1);
  const limit = 20;
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<ReviewRow | null>(null);
  const [fields, setFields] = useState<Record<string, ReviewRow['fields']>>(() =>
    Object.fromEntries(rows.map((row) => [row.id, row.fields])));
  const [comments, setComments] = useState<Record<string, string>>({});

  const pages = Math.max(1, Math.ceil(rows.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = useMemo(() => rows.slice((safePage - 1) * limit, safePage * limit), [rows, safePage]);

  function update(id: string, key: keyof ReviewRow['fields'], value: string) {
    setFields((current) => ({...current, [id]: {...(current[id] ?? rows.find((row) => row.id === id)!.fields), [key]: value}}));
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

  async function decide(row: ReviewRow, decision: 'APPROVED' | 'REJECTED' | 'IGNORED') {
    setBusy(row.id);
    setError('');
    try {
      await post({
        action: 'vessel_review_decide', kind: row.kind, id: row.id, decision,
        workflow: 'Vessel', payload: fields[row.id] ?? row.fields,
        comment: comments[row.id] ?? '',
      });
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FAILED');
    } finally {
      setBusy('');
    }
  }

  async function saveDraft(row: ReviewRow) {
    setBusy(row.id);
    setError('');
    try {
      await post({
        action: 'vessel_review_draft', kind: row.kind, id: row.id,
        payload: fields[row.id] ?? row.fields, comment: comments[row.id] ?? '',
      });
      window.location.reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'FAILED');
    } finally {
      setBusy('');
    }
  }

  return (
    <>
      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
      <div className="vessel-table-wrap">
        <table className="cash-payment-table" style={{minWidth: 1060}}>
          <thead>
            <tr>
              <th>Sender</th><th>Chat Type</th><th>Problem</th><th>View Message</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row) => {
              const value = fields[row.id] ?? row.fields;
              return (
                <tr key={`${row.kind}-${row.id}`}>
                  <td style={{maxWidth: 150}}>
                    <strong className="vessel-ellipsis" title={row.sender}>{row.sender}</strong>
                    <small className="muted" style={{display: 'block'}}>{stamp(row.timestamp)}</small>
                  </td>
                  <td><span className="pill">{row.chatType}</span></td>
                  <td style={{maxWidth: 220}}>
                    <strong>{row.problem}</strong>
                    <small className="muted" style={{display: 'block', fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{row.reasonCode}</small>
                  </td>
                  <td>
                    <Button type="button" size="sm" variant="outline" onClick={() => setViewing(row)}>View message</Button>
                  </td>
                  <td style={{minWidth: 520}}>
                    <details>
                      <summary style={{cursor: 'pointer', fontSize: 12, marginBottom: 6}}>Correction fields</summary>
                      <div style={{display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: 6, marginBottom: 8}}>
                        <label style={{fontSize: 11}}>Mother<input value={value.motherVessel} onChange={(e) => update(row.id, 'motherVessel', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Lighter<input value={value.lighterVessel} onChange={(e) => update(row.id, 'lighterVessel', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Master<input value={value.masterMobile} onChange={(e) => update(row.id, 'masterMobile', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Date<input type="date" value={value.startDate} onChange={(e) => update(row.id, 'startDate', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Escort<input value={value.escortName} onChange={(e) => update(row.id, 'escortName', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Escort mobile<input value={value.escortMobile} onChange={(e) => update(row.id, 'escortMobile', e.target.value)} /></label>
                        <label style={{fontSize: 11}}>Shift
                          <select value={value.shift} onChange={(e) => update(row.id, 'shift', e.target.value)} className="vessel-select">
                            <option value="">—</option><option value="D">D</option><option value="N">N</option>
                          </select>
                        </label>
                        <label style={{fontSize: 11}}>Comment<input value={comments[row.id] ?? ''} onChange={(e) => setComments((current) => ({...current, [row.id]: e.target.value}))} /></label>
                      </div>
                    </details>
                    <div style={{display: 'flex', flexWrap: 'wrap', gap: 4}}>
                      <Button type="button" size="sm" disabled={busy === row.id} onClick={() => void decide(row, 'APPROVED')}>Approve</Button>
                      <Button type="button" size="sm" variant="outline" disabled={busy === row.id} onClick={() => void decide(row, 'REJECTED')}>Decline</Button>
                      <Button type="button" size="sm" variant="outline" disabled={busy === row.id} onClick={() => void decide(row, 'IGNORED')}>Ignore</Button>
                      <Button type="button" size="sm" variant="outline" disabled={busy === row.id} onClick={() => void saveDraft(row)}>Save Draft</Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!pageRows.length ? <tr><td colSpan={5} className="muted">No vessel review items are pending.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
        <div className="row-actions" style={{gap: 8}}>
          <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
          <span className="muted">Page {safePage} / {pages}</span>
          <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
        </div>
        <span className="muted">{rows.length} pending</span>
      </div>

      {viewing ? (
        <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
          <div className="card" style={{width: 'min(760px, 100%)', maxHeight: '85vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
            <div className="page-head" style={{marginBottom: 8}}>
              <div>
                <h3 style={{margin: 0}}>{viewing.sender}</h3>
                <p className="muted" style={{marginTop: 2}}>{viewing.chatType} · {stamp(viewing.timestamp)}</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setViewing(null)}>Close</Button>
            </div>
            <pre style={{whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace', fontSize: 12, background: '#f8fafc', padding: 12, borderRadius: 8}}>
              {viewing.message}
            </pre>
          </div>
        </div>
      ) : null}
    </>
  );
}
