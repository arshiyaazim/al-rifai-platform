'use client';

import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {
  baseUrlFromNotes, defaultBaseUrl, KEY_PURPOSES, normalizeProvider,
  PROVIDER_SPECS, providerLabel, requiresBaseUrl,
} from '@/lib/ai-provider';

export type EditableKey = {
  id: string;
  provider: string;
  masked_key: string;
  model: string | null;
  notes: string | null;
  purpose?: string;
  base_url?: string | null;
  priority?: number;
  is_free?: boolean;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const initialBaseUrl = (editing?: EditableKey | null) =>
  editing ? (editing.base_url || baseUrlFromNotes(editing.notes) || defaultBaseUrl(editing.provider)) : defaultBaseUrl('gemini');

/** The recruitment worker only understands these providers. */
const RECRUITMENT_PROVIDERS = ['gemini', 'openai', 'anthropic', 'other'];

export function ApiKeyForm({
  onCreated, editing, onSaved, onCancel, defaultPurpose = 'platform-llm',
}: {
  onCreated?: () => void;
  editing?: EditableKey | null;
  onSaved?: () => void;
  onCancel?: () => void;
  defaultPurpose?: string;
}) {
  const editingMode = Boolean(editing);
  const [open, setOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [show, setShow] = useState(false);
  const [provider, setProvider] = useState<string>(normalizeProvider(editing?.provider) || 'gemini');
  const [model, setModel] = useState(editing?.model ?? '');
  const [baseUrl, setBaseUrl] = useState(initialBaseUrl(editing));
  const [purpose, setPurpose] = useState<string>(editing?.purpose ?? defaultPurpose);
  const [priority, setPriority] = useState<string>(String(editing?.priority ?? 0));
  const [isFree, setIsFree] = useState<boolean>(editing?.is_free === true);
  const [verifiedModels, setVerifiedModels] = useState<string[]>([]);
  const [customEndpoint, setCustomEndpoint] = useState(requiresBaseUrl(normalizeProvider(editing?.provider) || 'gemini'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function onProviderChange(next: string) {
    const value = normalizeProvider(next);
    setProvider(value);
    // Base URL follows the provider unless the operator typed their own.
    setBaseUrl(defaultBaseUrl(value));
    setCustomEndpoint(requiresBaseUrl(value));
    setVerifiedModels([]);
    if (!model) setModel('');
  }

  const needsBaseUrl = requiresBaseUrl(provider);
  const recruitmentPurpose = purpose === 'recruitment';

  function onPurposeChange(next: string) {
    setPurpose(next);
    if (next !== 'recruitment') return;
    // Recruitment never uses free-tier routing and cannot reach every provider.
    setIsFree(false);
    if (!RECRUITMENT_PROVIDERS.includes(provider)) {
      setProvider('openai');
      setBaseUrl(defaultBaseUrl('openai'));
      setCustomEndpoint(false);
      setVerifiedModels([]);
    }
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
          : {apiKey, provider, model, baseUrl}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      if (!body.ok) throw new Error(`${body.error ?? 'FAILED'}${body.status ? ` (${body.status})` : ''}`);
      setNotice(`OK · ${body.provider} · ${body.model} · ${body.latency_ms} ms`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test failed'); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setError(''); setNotice('');
    try {
      const token = await csrfToken();
      const response = await fetch('/api/settings/api-keys/models', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(editingMode ? {id: editing?.id, baseUrl} : {apiKey, provider, baseUrl}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      if (!body.ok) throw new Error(`${body.error ?? 'FAILED'}${body.status ? ` (${body.status})` : ''}`);
      const models = (body.models ?? []) as string[];
      setVerifiedModels(models);
      if (models.length && !models.includes(model)) setModel(models[0]);
      setNotice(`Verified · ${models.length} models available`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Verify failed'); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      if (!apiKey.trim() && !editingMode && provider !== 'ollama') throw new Error('API key is required');
      if (needsBaseUrl && !baseUrl.trim()) throw new Error('Base URL is required for this provider');
      if (!model.trim()) throw new Error('Select or type a model first');
      const token = await csrfToken();
      const response = await fetch('/api/settings/api-keys', {
        method: editingMode ? 'PATCH' : 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          ...(editingMode ? {id: editing?.id} : {apiKey}),
          provider, model, purpose, baseUrl, priority: Number(priority) || 0, isFree,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setNotice(editingMode ? 'Saved.' : 'Key added.');
      if (editingMode) onSaved?.();
      else { setApiKey(''); setVerifiedModels([]); onCreated?.(); }
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  const body = (
    <div className="grid gap-2">
      {editingMode ? (
        <label className="text-sm">API Key
          <Input value={editing?.masked_key ?? ''} readOnly disabled />
        </label>
      ) : (
        <label className="text-sm">API Key
          <span style={{display: 'flex', gap: 4}}>
            <Input type={show ? 'text' : 'password'} value={apiKey} onChange={(event) => setApiKey(event.target.value)} autoComplete="off" placeholder={provider === 'ollama' ? 'Not required for Ollama' : 'Paste the key'} />
            <Button type="button" size="sm" variant="outline" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button>
          </span>
        </label>
      )}

      <label className="text-sm">Provider
        <select className="vessel-select" value={provider} onChange={(event) => onProviderChange(event.target.value)}>
          {PROVIDER_SPECS.map((spec) => <option key={spec.id} value={spec.id}>{spec.label}</option>)}
        </select>
      </label>

      {needsBaseUrl || customEndpoint ? (
        <label className="text-sm">Base URL {needsBaseUrl ? <span style={{color: '#b91c1c'}}>(required)</span> : <span className="muted">(optional — default {defaultBaseUrl(provider) || 'none'})</span>}
          <Input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder={defaultBaseUrl(provider) || 'https://api.example.com/v1'} />
        </label>
      ) : (
        <div className="text-sm">Base URL
          <div style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 4}}>
            <span className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{baseUrl || 'none'}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => setCustomEndpoint(true)}>Custom endpoint</Button>
          </div>
        </div>
      )}

      <label className="text-sm">Model
        {verifiedModels.length ? (
          <select className="vessel-select" value={model} onChange={(event) => setModel(event.target.value)}>
            {verifiedModels.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        ) : (
          <Input value={model} onChange={(event) => setModel(event.target.value)} placeholder="Verify & Load Models, or type a model name" />
        )}
      </label>

      <label className="text-sm">Purpose
        <select className="vessel-select" value={purpose} onChange={(event) => onPurposeChange(event.target.value)}>
          {KEY_PURPOSES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>

      {recruitmentPurpose ? (
        <p role="note" style={{margin: 0, padding: '6px 8px', borderRadius: 6, background: '#fef3c7', border: '1px solid #f59e0b', color: '#92400e', fontSize: 12}}>
          Recruitment keys are stored as plaintext and only work with providers: Gemini, OpenAI, Anthropic, Other. Free-tier routing does not apply.
        </p>
      ) : null}

      <div style={{display: 'flex', gap: 12, alignItems: 'flex-end'}}>
        <label className="text-sm" style={{width: 130}}>Priority
          <Input type="number" min={0} value={priority} onChange={(event) => setPriority(event.target.value)} />
        </label>
        <label className="text-sm" style={{display: 'flex', gap: 6, alignItems: 'center', paddingBottom: 6, opacity: recruitmentPurpose ? 0.5 : 1}}>
          <input type="checkbox" checked={isFree} disabled={recruitmentPurpose} onChange={(event) => setIsFree(event.target.checked)} />
          Free-tier model
        </label>
      </div>
      <p className="muted" style={{fontSize: 11, margin: 0}}>
        Lower priority is tried first. Free-tier keys win ties. Provider: {providerLabel(provider)}.
      </p>

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
      {notice ? <p style={{color: '#15803d'}}>{notice}</p> : null}

      <div className="row-actions">
        <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>
          {busy ? 'Working…' : editingMode ? 'Save' : 'Add Key'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void verify()} disabled={busy || (!editingMode && !apiKey && provider !== 'ollama')}>
          Verify &amp; Load Models
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={() => void test()} disabled={busy || (!editingMode && !apiKey && provider !== 'ollama')}>
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
        <div><h3 style={{margin: 0}}>Add New Key</h3><p className="muted" style={{marginTop: 2, fontSize: 12}}>Pick the provider, paste the key, verify, choose a model, add.</p></div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Add New Key'}</Button>
      </div>
      {open ? body : null}
    </section>
  );
}
