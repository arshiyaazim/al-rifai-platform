'use client';

import {useState} from 'react';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

/** Admin kill-switch for the floating assistant. */
export function AssistantToggle({initial}: {initial: boolean}) {
  const [enabled, setEnabled] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function toggle() {
    setBusy(true); setError('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/settings/assistant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({enabled: !enabled}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setEnabled(body.enabled === true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not save.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{display: 'flex', alignItems: 'center', gap: 10}}>
      <button type="button" onClick={() => void toggle()} disabled={busy}
        aria-pressed={enabled}
        style={{
          minWidth: 92, padding: '6px 12px', borderRadius: 999, cursor: busy ? 'default' : 'pointer',
          border: `1px solid ${enabled ? 'var(--accent, #0f766e)' : 'var(--line, #e2e8f0)'}`,
          background: enabled ? 'var(--accent, #0f766e)' : 'transparent',
          color: enabled ? '#fff' : 'inherit', fontWeight: 600, fontSize: 12,
        }}>
        {busy ? 'Saving…' : enabled ? 'Enabled' : 'Disabled'}
      </button>
      <span className="muted" style={{fontSize: 11}}>
        {enabled ? 'Floating button is visible to all signed-in users.' : 'The floating button is hidden everywhere.'}
      </span>
      {error ? <span role="alert" style={{fontSize: 11, color: 'var(--danger, #b91c1c)'}}>{error}</span> : null}
    </div>
  );
}
