'use client';

import {useEffect, useMemo, useState, type CSSProperties} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {ApiKeyForm} from '@/components/standalone/api-key-form';
import {providerLabel} from '@/lib/ai-provider';
import {isAuthenticationFailure, redirectToLogin} from '@/components/standalone/session-redirect';

/** Every cell is single-line; long values are clipped and exposed via title. */
const ELLIPSIS: CSSProperties = {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'};

const shortModel = (value: string | null) => {
  const text = String(value ?? '—');
  return text.length > 24 ? `${text.slice(0, 23)}…` : text;
};

type KeyRow = {
  id: string; provider: string; key_name: string; masked_key: string; has_key: boolean;
  model: string | null;
  purpose: string; purpose_tags: string[]; base_url: string | null; priority: number;
  is_free: boolean; fail_count: number; is_active: boolean; usage_count: number;
  last_used_at: string | null; last_error: string | null; last_error_at: string | null;
  cooldown_until: string | null; daily_limit: number | null; daily_usage: number;
  daily_reset_at: string | null; created_at: string; updated_at: string; notes: string | null;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json().catch(() => ({}));
  if (isAuthenticationFailure(response.status, body)) {
    redirectToLogin();
    throw new Error('Session expired — sign in again.');
  }
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf as string;
}

const cooldownLeft = (value: string | null) => {
  if (!value) return 0;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000));
};

type StatusView = {label: 'Active' | 'Disabled' | 'Error'; color: string; title: string};

function statusOf(row: KeyRow): StatusView {
  const left = cooldownLeft(row.cooldown_until);
  if (!row.is_active) {
    return {label: 'Disabled', color: 'var(--muted, #64748b)', title: row.last_error ?? 'Disabled by an administrator'};
  }
  if (row.last_error || left > 0) {
    const title = [row.last_error ?? 'Last request failed', left > 0 ? `cooldown ${left}s remaining` : '']
      .filter(Boolean).join(' · ');
    return {label: 'Error', color: 'var(--danger, #b91c1c)', title};
  }
  return {label: 'Active', color: '#15803d', title: 'Active and available'};
}

export function ApiKeysTable() {
  const [keys, setKeys] = useState<KeyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [editing, setEditing] = useState<KeyRow | null>(null);
  const limit = 20;

  async function load() {
    setLoading(true); setError('');
    try {
      const response = await fetch('/api/settings/api-keys', {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setKeys(body.keys as KeyRow[]);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load keys.'); }
    finally { setLoading(false); }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async read
  useEffect(() => { void load(); }, []);

  const stats = useMemo(() => ({
    total: keys.length,
    active: keys.filter((key) => key.is_active).length,
    today: keys.reduce((sum, key) => sum + key.daily_usage, 0),
    cooldown: keys.filter((key) => cooldownLeft(key.cooldown_until) > 0).length,
    failed: keys.filter((key) => key.is_active && cooldownLeft(key.cooldown_until) === 0 && key.last_error).length,
  }), [keys]);

  const pages = Math.max(1, Math.ceil(keys.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = keys.slice((safePage - 1) * limit, safePage * limit);

  async function action(row: KeyRow, body: Record<string, unknown>) {
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/settings/api-keys${body.action === 'test' ? '/test' : ''}`, {
        method: body.action === 'delete' ? 'DELETE' : body.action === 'test' ? 'POST' : 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({...body, id: row.id}),
      });
      const payload = await response.json().catch(() => ({}));
      if (isAuthenticationFailure(response.status, payload)) {
        redirectToLogin();
        throw new Error('Session expired — sign in again.');
      }
      if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
      if (body.action === 'test') {
        if (payload.ok) toast.success(`Key OK · ${payload.provider} · ${payload.model} · ${payload.latency_ms} ms`);
        else toast.error(`Test failed: ${payload.error ?? 'FAILED'}${payload.status ? ` (${payload.status})` : ''}`, {duration: Infinity});
      } else if (body.action === 'delete') {
        toast.success('Key deleted.');
      } else {
        toast.success('Key updated.');
      }
      await load();
    } catch (cause) { toast.error(cause instanceof Error ? cause.message : 'Action failed.', {duration: Infinity}); }
  }

  return (
    <>
      <div className="grid-cards" style={{marginBottom: 14}}>
        <div className="stat"><div className="label">Total Keys</div><div className="value">{stats.total}</div></div>
        <div className="stat"><div className="label">Active</div><div className="value">{stats.active}</div></div>
        <div className="stat"><div className="label">Today&apos;s Usage</div><div className="value">{stats.today}</div></div>
        <div className="stat"><div className="label">⏳ Rate-limited</div><div className="value">{stats.cooldown}</div></div>
        <div className="stat"><div className="label">❌ Failed</div><div className="value">{stats.failed}</div></div>
      </div>

      <ApiKeyForm onCreated={() => void load()} />

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

      <section className="card">
        <p className="muted" style={{margin: '0 0 8px', fontSize: 12}}>
          Status: <span className="pill ok">● Active</span>{' '}
          <span className="pill">● Disabled</span>{' '}
          <span className="pill bad">● Error</span>
        </p>
        <div className="table-wrap" style={{overflowX: 'auto', maxWidth: '100%'}}>
          <table className="cash-payment-table" style={{minWidth: 900, width: '100%', tableLayout: 'fixed'}}>
            <colgroup>
              <col style={{width: 36}} />
              <col style={{width: 110}} />
              <col style={{width: 220}} />
              <col style={{width: 90}} />
              <col style={{width: 140}} />
              <col style={{width: 100}} />
              <col style={{width: 240}} />
            </colgroup>
            <thead>
              <tr><th>#</th><th>Provider</th><th>Model</th><th>API Key</th><th>Purpose</th><th>Status</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="muted">Loading keys…</td></tr> : null}
              {!loading && pageRows.map((row, index) => {
                const status = statusOf(row);
                const tags = [row.purpose, ...(row.purpose_tags ?? []).filter((tag) => tag !== row.purpose)];
                return (
                  <tr key={row.id} title={row.key_name}>
                    <td style={{...ELLIPSIS, textAlign: 'center', fontSize: 10}}>{(safePage - 1) * limit + index + 1}</td>
                    <td style={ELLIPSIS} title={providerLabel(row.provider)}>{providerLabel(row.provider)}</td>
                    <td style={ELLIPSIS}
                      title={`${row.model ?? '—'}\nBase URL: ${row.base_url ?? '(provider default)'}`}>
                      <span style={{textDecoration: 'underline', textDecorationStyle: 'dotted', textUnderlineOffset: 2, cursor: 'help'}}>
                        {shortModel(row.model)}
                      </span>
                    </td>
                    <td style={{...ELLIPSIS, fontWeight: 600}}>
                      {row.has_key
                        ? <span style={{color: '#15803d'}}>✓ Set</span>
                        : <span style={{color: '#b91c1c'}}>✗ None</span>}
                    </td>
                    <td style={ELLIPSIS} title={tags.join(', ')}><span className="pill">{row.purpose}</span></td>
                    <td style={ELLIPSIS} title={status.title}>
                      <span style={{color: status.color, fontWeight: 600}}>● {status.label}</span>
                    </td>
                    <td>
                      <div style={{display: 'flex', gap: 4, flexWrap: 'nowrap'}}>
                        <Button type="button" size="sm" variant="outline" title="Edit this key"
                          aria-label="Edit key" onClick={() => setEditing(row)}>✎</Button>
                        <Button type="button" size="sm" variant="outline" title="Send a tiny test prompt"
                          aria-label="Test key" onClick={() => void action(row, {action: 'test'})}>▶</Button>
                        <Button type="button" size="sm" variant="outline"
                          title={row.is_active ? 'Disable this key' : 'Enable this key'}
                          aria-label={row.is_active ? 'Disable key' : 'Enable key'}
                          onClick={() => {
                            // Soft guard: a `general` key is shared with the
                            // recruitment worker, which reads plaintext only.
                            if (!row.is_active && row.purpose === 'general'
                              && !window.confirm('This key is encrypted. Enabling it may cause issues with the recruitment app. Are you sure?')) return;
                            void action(row, {action: 'update', isActive: !row.is_active});
                          }}>⏻</Button>
                        <Button type="button" size="sm" variant="outline" title="Delete this key"
                          aria-label="Delete key" style={{color: 'var(--danger, #b91c1c)'}}
                          onClick={() => {
                            if (window.confirm(`Delete ${row.key_name}? This cannot be undone.`)) void action(row, {action: 'delete'});
                          }}>✕</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !pageRows.length ? <tr><td colSpan={7} className="muted">No API keys yet.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
          <div className="row-actions" style={{gap: 8}}>
            <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
            <span className="muted">Page {safePage} / {pages}</span>
            <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
          </div>
        </div>
      </section>

      {editing ? (
        <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}>
          <div className="card" style={{width: 'min(560px, 100%)', background: 'var(--background, #fff)'}}>
            <h3>Edit {editing.key_name}</h3>
            <ApiKeyForm
              editing={editing}
              onSaved={() => { setEditing(null); void load(); }}
              onCancel={() => setEditing(null)}
            />
          </div>
        </div>
      ) : null}
    </>
  );
}
