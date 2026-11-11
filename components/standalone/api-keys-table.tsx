'use client';

import {useEffect, useMemo, useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {ApiKeyForm} from '@/components/standalone/api-key-form';

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

const fmt = (value: string | null) => value ? new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'short', timeStyle: 'short'}) : '—';
const cooldownLeft = (value: string | null) => {
  if (!value) return 0;
  return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 1000));
};

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
        toast[payload.success ? 'success' : 'error'](payload.success ? `Key OK · ${payload.latency_ms} ms` : `Test failed: ${payload.error}`);
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
          <table className="cash-payment-table" style={{minWidth: 1180}}>
            <thead><tr><th>#</th><th>Provider</th><th>Name</th><th>Key</th><th>Model</th><th>Purpose</th><th>Active</th><th>Today</th><th>Total</th><th>Last Used</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {loading ? <tr><td colSpan={12} className="muted">Loading keys…</td></tr> : null}
              {!loading && pageRows.map((row, index) => {
                const left = cooldownLeft(row.cooldown_until);
                return (
                  <tr key={row.id}>
                    <td>{(safePage - 1) * limit + index + 1}</td>
                    <td>{row.provider}</td>
                    <td>{row.key_name}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{row.masked_key}</td>
                    <td>{row.model ?? '—'}</td>
                    <td>{row.purpose}</td>
                    <td>{row.is_active ? 'yes' : 'no'}</td>
                    <td>{row.daily_usage}{row.daily_limit ? ` / ${row.daily_limit}` : ''}</td>
                    <td>{row.usage_count}</td>
                    <td>{fmt(row.last_used_at)}</td>
                    <td>
                      {!row.is_active ? <span className="pill">⚫ Disabled</span>
                        : left > 0 ? <span className="pill warn">🟡 {left}s</span>
                          : row.last_error ? <span className="pill bad" title={row.last_error}>🔴 Error</span>
                            : <span className="pill ok">🟢 OK</span>}
                    </td>
                    <td>
                      <div className="row-actions" style={{flexWrap: 'wrap'}}>
                        <Button type="button" size="sm" variant="outline" onClick={() => void action(row, {action: 'test'})}>Test</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => setEditing(row)}>Edit</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => void action(row, {action: 'update', isActive: !row.is_active})}>{row.is_active ? 'Disable' : 'Enable'}</Button>
                        <Button type="button" size="sm" variant="outline" onClick={() => { if (window.confirm(`Delete ${row.key_name}?`)) void action(row, {action: 'delete'}); }}>Delete</Button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && !pageRows.length ? <tr><td colSpan={12} className="muted">No API keys yet.</td></tr> : null}
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
          <div className="card" style={{width: 'min(620px, 100%)', background: 'var(--background, #fff)'}}>
            <h3>Edit {editing.key_name}</h3>
            <div className="grid gap-2">
              <label className="text-sm">Name<Input defaultValue={editing.key_name} id="edit-name" /></label>
              <label className="text-sm">Model<Input defaultValue={editing.model ?? ''} id="edit-model" /></label>
              <label className="text-sm">Purpose
                <select className="vessel-select" defaultValue={editing.purpose} id="edit-purpose">
                  <option value="recruitment">Recruitment</option><option value="vessel-ai">Vessel AI</option>
                  <option value="general">General</option><option value="other">Other</option>
                </select>
              </label>
              <label className="text-sm">Daily Limit<Input type="number" defaultValue={editing.daily_limit ?? ''} id="edit-limit" /></label>
              <label className="text-sm">Notes<Textarea defaultValue={editing.notes ?? ''} id="edit-notes" /></label>
            </div>
            <div className="row-actions" style={{marginTop: 10}}>
              <Button type="button" size="sm" onClick={() => {
                const value = (id: string) => (document.getElementById(id) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null)?.value ?? '';
                void action(editing, {action: 'update', keyName: value('edit-name'), model: value('edit-model'),
                  purpose: value('edit-purpose'), dailyLimit: value('edit-limit') ? Number(value('edit-limit')) : null,
                  notes: value('edit-notes') || null}).then(() => setEditing(null));
              }}>Save</Button>
              <Button type="button" size="sm" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
