'use client';

import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
  baseUrlFromNotes, defaultModel, detectProvider, PROVIDER_LABEL, PROVIDER_MODELS, type AiProvider,
} from '@/lib/ai-provider';

export type EditableKey = {
  id: string;
  provider: string;
  masked_key: string;
  model: string | null;
  notes: string | null;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function ApiKeyForm({
  onCreated, editing, onSaved, onCancel,
}: {
  onCreated?: () => void;
  editing?: EditableKey | null;
  onSaved?: () => void;
  onCancel?: () => void;
}) {
  const editingMode = Boolean(editing);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [show, setShow] = useState(false);
  const [provider, setProvider] = useState<AiProvider>((editing?.provider as AiProvider) ?? 'gemini');
  const [model, setModel] = useState(editing?.model ?? defaultModel((editing?.provider as AiProvider) ?? 'gemini'));
  const [baseUrl, setBaseUrl] = useState(baseUrlFromNotes(editing?.notes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function onKeyChange(value: string) {
    setApiKey(value);
    const detected = detectProvider(value);
    setProvider(detected);
    const options = PROVIDER_MODELS[detected];
    setModel(options.includes(model) ? model : defaultModel(detected));
  }

  async function test() {
    setBusy(true); setError(''); setNotice('');
    try {
      const token = await csrfToken();
      const response = await fetch(editingMode ? '/api/settings/api-keys/test' : '/api/settings/api-keys/test-draft', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(editingMode
          ? {id: editing?.id}
          : {apiKey, model, baseUrl}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      if (!body.ok) throw new Error(`${body.error ?? 'FAILED'}${body.status ? ` (${body.status})` : ''}`);
      setNotice(`OK · ${body.provider} · ${body.model} · ${body.latency_ms} ms`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test failed'); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!apiKey.trim() && !editingMode) throw new Error('API key is required');
      if (provider === 'other' && !baseUrl.trim()) throw new Error('Base URL is required for Other provider');
      const token = await csrfToken();
      const response = await fetch('/api/settings/api-keys', {
        method: editingMode ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(editingMode
          ? {id: editing?.id, model, baseUrl: provider === 'other' ? baseUrl : undefined}
          : {apiKey, model, baseUrl: provider === 'other' ? baseUrl : undefined}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setNotice(editingMode ? 'Saved.' : 'Key added.');
      if (editingMode) onSaved?.();
      else { setApiKey(''); setBaseUrl(''); onCreated?.(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  const options = PROVIDER_MODELS[provider];
  const body = (
    <div className="grid gap-2">
      {editingMode ? (
        <label className="text-sm">API Key
          <Input value={editing?.masked_key ?? ''} readOnly disabled />
        </label>
      ) : (
        <label className="text-sm">API Key
          <span style={{display: 'flex', gap: 4}}>
            <Input type={show ? 'text' : 'password'} value={apiKey} onChange={(event) => onKeyChange(event.target.value)} autoComplete="off" placeholder="Paste the key" />
            <Button type="button" size="sm" variant="outline" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button>
          </span>
        </label>
      )}

      <div className={`pill ${provider === 'other' ? 'warn' : 'ok'}`} style={{width: 'fit-content'}}>
        Detected: {PROVIDER_LABEL[provider]}
      </div>

      <label className="text-sm">Model
        {provider === 'other' ? (
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="model-name" />
        ) : (
          <select className="vessel-select" value={model} onChange={(event) => setModel(event.target.value)}>
            {options.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        )}
      </label>

      {provider === 'other' ? (
        <label className="text-sm">Base URL
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
        </label>
      ) : null}

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
      {notice ? <p style={{color: '#15803d'}}>{notice}</p> : null}

      <div className="row-actions">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Working…' : editingMode ? 'Save' : 'Add Key'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void test()} disabled={busy || (!editingMode && !apiKey)}>
          Test Key
        </Button>
        {editingMode ? <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button> : null}
      </div>
    </div>
  );

  if (editingMode) return body;

  return (
    <section className="card" style={{marginBottom: 14, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div><h3 style={{margin: 0}}>Add New Key</h3><p className="muted" style={{marginTop: 2, fontSize: 12}}>Paste the key, pick a model, add. Provider is detected automatically.</p></div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Add New Key'}</Button>
      </div>
      {open ? body : null}
    </section>
  );
}
