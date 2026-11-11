'use client';

import Link from 'next/link';
import {Fragment, useEffect, useMemo, useState} from 'react';
import {AppToaster} from '@/components/standalone/app-toaster';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import type {AuditEventView} from '@/lib/standalone/audit-view';

export type AuditPagePayload = {
  events: AuditEventView[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type Filters = {from: string; to: string; domain: string; action: string; actor: string; targetId: string};
const EMPTY: Filters = {from: '', to: '', domain: '', action: '', actor: '', targetId: ''};
const DOMAINS = ['ALL', 'CASH', 'VESSEL', 'REVIEW', 'AUTH', 'SYSTEM'];
const ACTIONS = ['ALL', 'CREATED', 'UPDATED', 'DELETED', 'CORRECTION', 'REVERSAL', 'REJECTED', 'APPROVED'];

function dhaka(value: string) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'medium',
  }).format(new Date(value));
}

function query(filters: Filters, page: number, limit: number) {
  const params = new URLSearchParams({page: String(page), limit: String(limit)});
  for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
  return params;
}

function Diff({before, after}: {before: unknown; after: unknown}) {
  if (!before && !after) return null;
  const left = (before ?? {}) as Record<string, unknown>;
  const right = (after ?? {}) as Record<string, unknown>;
  const keys = Array.from(new Set([...Object.keys(left), ...Object.keys(right)]));
  return (
    <table className="audit-diff">
      <thead><tr><th>Field</th><th>Before</th><th>After</th></tr></thead>
      <tbody>
        {keys.map((key) => {
          const a = JSON.stringify(left[key] ?? null);
          const b = JSON.stringify(right[key] ?? null);
          return (
            <tr key={key} className={a !== b ? 'is-changed' : ''}>
              <td>{key}</td>
              <td><code>{a}</code></td>
              <td><code>{b}</code></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function AuditTrailViewer({initial}: {initial: AuditPagePayload}) {
  const [data, setData] = useState(initial);
  const [draft, setDraft] = useState<Filters>(EMPTY);
  const [applied, setApplied] = useState<Filters>(EMPTY);
  const [page, setPage] = useState(initial.page);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [related, setRelated] = useState<Record<string, AuditEventView[]>>({});

  async function load(nextPage: number, nextFilters: Filters, quiet = false) {
    if (!quiet) setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/audit?${query(nextFilters, nextPage, 50).toString()}`, {
        headers: {accept: 'application/json'}, cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
      setData(body as AuditPagePayload);
      setPage(nextPage);
      setApplied(nextFilters);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Audit trail could not be loaded.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }

  useEffect(() => {
    if (!expanded) return;
    const event = data.events.find((item) => item.id === expanded);
    if (!event?.targetId || related[expanded]) return;
    const params = new URLSearchParams({targetId: event.targetId, limit: '20'});
    void fetch(`/api/audit?${params.toString()}`, {headers: {accept: 'application/json'}, cache: 'no-store'})
      .then((response) => response.ok ? response.json() : null)
      .then((payload: AuditPagePayload | null) => {
        if (payload) setRelated((current) => ({...current, [expanded]: payload.events}));
      })
      .catch(() => undefined);
  }, [expanded, data.events, related]);

  const active = useMemo(() => Object.values(applied).filter(Boolean).length, [applied]);
  const selected = data.events.find((event) => event.id === expanded) ?? null;

  return (
    <>
      <AppToaster />
      <form
        className="card form compact print-hidden"
        onSubmit={(event) => { event.preventDefault(); setExpanded(null); void load(1, draft); }}
        style={{marginBottom: 18}}
      >
        <div className="grid">
          <label><span>From</span><Input type="date" value={draft.from} onChange={(e) => setDraft({...draft, from: e.target.value})} /></label>
          <label><span>To</span><Input type="date" value={draft.to} onChange={(e) => setDraft({...draft, to: e.target.value})} /></label>
          <label><span>Domain</span>
            <select value={draft.domain} onChange={(e) => setDraft({...draft, domain: e.target.value})}>
              {DOMAINS.map((value) => <option key={value} value={value === 'ALL' ? '' : value}>{value}</option>)}
            </select>
          </label>
          <label><span>Action</span>
            <select value={draft.action} onChange={(e) => setDraft({...draft, action: e.target.value})}>
              {ACTIONS.map((value) => <option key={value} value={value === 'ALL' ? '' : value}>{value}</option>)}
            </select>
          </label>
          <label><span>Actor</span><Input value={draft.actor} onChange={(e) => setDraft({...draft, actor: e.target.value})} placeholder="Name or id" /></label>
          <label><span>Target ID</span><Input value={draft.targetId} onChange={(e) => setDraft({...draft, targetId: e.target.value})} placeholder="Program, instruction, review…" /></label>
        </div>
        <div className="row-actions">
          <Button type="submit" size="sm" disabled={loading}>{loading ? 'Loading…' : 'Apply filters'}</Button>
          <Button type="button" size="sm" variant="outline" onClick={() => { setDraft(EMPTY); setExpanded(null); void load(1, EMPTY); }} disabled={loading}>
            Clear{active ? ` (${active})` : ''}
          </Button>
          <span className="muted" style={{marginLeft: 'auto'}}>{data.total.toLocaleString()} event(s)</span>
        </div>
      </form>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <section className="card">
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Audit Trail ({data.total.toLocaleString()})</h3></div>
          <span className="muted">Newest first · append-only</span>
        </div>
        <div style={{overflowX: 'auto'}}>
          <table>
            <thead><tr><th>Timestamp</th><th>Actor</th><th>Action</th><th>Domain</th><th>Target</th><th>Details</th><th>Source</th></tr></thead>
            <tbody>
              {data.events.map((event) => (
                <Fragment key={event.id}>
                  <tr className="audit-row" onClick={() => setExpanded(expanded === event.id ? null : event.id)}>
                    <td style={{whiteSpace: 'nowrap'}}>{dhaka(event.timestamp)}</td>
                    <td>{event.actorName ?? event.actor.slice(0, 12)}</td>
                    <td><span className="pill">{event.action}</span></td>
                    <td><span className={`pill audit-domain audit-domain--${event.domain.toLowerCase()}`}>{event.domain}</span></td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{event.targetType}{event.targetId ? ` · ${event.targetId.slice(0, 24)}` : ''}</td>
                    <td className="muted">{event.before || event.after ? 'changed' : '—'}</td>
                    <td>{event.source ?? '—'}{event.sourceMessageId ? <div><Link href={`/messages?q=${encodeURIComponent(event.sourceMessageId)}`}>message</Link></div> : null}</td>
                  </tr>
                  {expanded === event.id ? (
                    <tr key={`${event.id}-detail`}>
                      <td colSpan={7} className="audit-detail">
                        <div className="audit-detail__grid">
                          <div>
                            <h4>Event payload</h4>
                            <pre>{JSON.stringify(event.metadata, null, 2)}</pre>
                          </div>
                          <div>
                            <h4>Before / after</h4>
                            <Diff before={event.before} after={event.after} />
                            <h4>Related events for this target</h4>
                            <ul className="audit-related">
                              {(related[event.id] ?? []).filter((item) => item.id !== event.id).slice(0, 10).map((item) => (
                                <li key={item.id}><span>{dhaka(item.timestamp)}</span> · {item.action}</li>
                              ))}
                              {!related[event.id]?.length ? <li className="muted">Loading or no related events.</li> : null}
                            </ul>
                            {event.sourceMessageId ? <p><Link href={`/messages?q=${encodeURIComponent(event.sourceMessageId)}`}>Open source WhatsApp message →</Link></p> : null}
                          </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
              {!data.events.length ? <tr><td colSpan={7} className="muted">No audit events match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="row-actions" style={{marginTop: 12}}>
          <Button type="button" size="sm" variant="outline" disabled={loading || page <= 1} onClick={() => void load(page - 1, applied)}>← Previous</Button>
          <span className="muted">Page {data.page} / {data.totalPages}</span>
          <Button type="button" size="sm" variant="outline" disabled={loading || page >= data.totalPages} onClick={() => void load(page + 1, applied)}>Next →</Button>
        </div>
        {selected ? null : <p className="muted">Click a row to expand the payload, before/after diff and related events.</p>}
      </section>
    </>
  );
}
