'use client';

import {useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {ApiKeyForm} from '@/components/standalone/api-key-form';
import {RowActionsMenu} from '@/components/standalone/row-actions-menu';

type KeyRow = {
  id: string; provider: string; key_name: string; masked_key: string; model: string | null;
  purpose: string; is_active: boolean; usage_count: number; last_used_at: string | null;
  last_error: string | null; last_error_at: string | null; cooldown_until: string | null;
  daily_limit: number | null; daily_usage: number; daily_reset_at: string | null;
  created_at: string; updated_at: string; notes: string | null;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const cooldownLeft = (value: string | null) => {
  if (!value) return 0;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000));
};
const providerBadge = (provider: string) => provider === 'gemini' ? '✦ Gemini'
  : provider === 'openai' ? '◎ OpenAI' : provider === 'anthropic' ? '✳ Anthropic' : '◈ Other';

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
      if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
      if (body.action === 'test') {
        if (payload.ok) toast.success(`Key OK · ${payload.provider} · ${payload.model} · ${payload.latency_ms} ms`);
        else toast.error(`Test failed: ${payload.error ?? 'FAILED'}${payload.status ? ` (${payload.status})` : ''}`, {duration: Infinity});
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
        <div className="stat"><div className="label">Cooldown</div><div className="value">{stats.cooldown}</div></div>
      </div>

      <ApiKeyForm onCreated={() => void load()} />

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

      <section className="card">
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 900}}>
            <colgroup>
              <col style={{width: 12}} />
              <col style={{width: 160}} />
              <col style={{width: 100}} />
              <col style={{width: 190}} />
              <col style={{width: 220}} />
              <col style={{width: 110}} />
              <col style={{width: 70}} />
            </colgroup>
            <thead><tr><th>#</th><th>Key Name</th><th>Provider</th><th>Model</th><th>Masked Key</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={7} className="muted">Loading keys…</td></tr> : null}
              {!loading && pageRows.map((row, index) => {
                const left = cooldownLeft(row.cooldown_until);
                return (
                  <tr key={row.id}>
                    <td style={{width: 12, padding: '2px 0', fontSize: 10, textAlign: 'center'}}>{(safePage - 1) * limit + index + 1}</td>
                    <td>{row.key_name}</td>
                    <td><span className="pill">{providerBadge(row.provider)}</span></td>
                    <td>{row.model ?? '—'}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{row.masked_key}</td>
                    <td>
                      {!row.is_active ? <span className="pill">⚫ Disabled</span>
                        : left > 0 ? <span className="pill warn">🟡 {left}s</span>
                          : row.last_error ? <span className="pill bad" title={row.last_error}>🔴 Error</span>
                            : <span className="pill ok">🟢 OK</span>}
                    </td>
                    <td>
                      <RowActionsMenu items={[
                        {label: 'Test', onClick: () => void action(row, {action: 'test'})},
                        {label: 'Edit', onClick: () => setEditing(row)},
                        {label: row.is_active ? 'Disable' : 'Enable', onClick: () => void action(row, {action: 'update', isActive: !row.is_active})},
                        {label: 'Delete', danger: true, onClick: () => {
                          if (window.confirm(`Delete ${row.key_name}?`)) void action(row, {action: 'delete'});
                        }},
                      ]} label={`Actions for ${row.key_name}`} />
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
