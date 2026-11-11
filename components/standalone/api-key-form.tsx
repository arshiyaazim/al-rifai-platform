'use client';

import {useState} from 'react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';

const PROVIDERS = [
  ['gemini', 'Gemini'], ['openai', 'OpenAI'], ['anthropic', 'Anthropic'], ['other', 'Other'],
] as const;
const PURPOSES = [
  ['recruitment', 'Recruitment'], ['vessel-ai', 'Vessel AI'], ['general', 'General'], ['other', 'Other'],
] as const;

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function ApiKeyForm({onCreated}: {onCreated: () => void}) {
  const [open, setOpen] = useState(false);
  const [provider, setProvider] = useState('gemini');
  const [keyName, setKeyName] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [show, setShow] = useState(false);
  const [model, setModel] = useState('gemini-2.0-flash');
  const [purpose, setPurpose] = useState('recruitment');
  const [dailyLimit, setDailyLimit] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  function validate() {
    if (!keyName.trim()) return 'Key name is required.';
    if (provider === 'gemini' && !/^AIza[0-9A-Za-z_-]{35}$/.test(apiKey)) return 'Gemini key must start with AIza and be 39 characters.';
    if (provider === 'openai' && !apiKey.startsWith('sk-')) return 'OpenAI key must start with sk-.';
    if (provider === 'anthropic' && !apiKey.startsWith('sk-ant-')) return 'Anthropic key must start with sk-ant-.';
    return '';
  }

  async function testDraft() {
    setBusy(true); setError(''); setNotice('');
    try {
      const invalid = validate();
      if (invalid) throw new Error(invalid);
      const token = await csrfToken();
      const response = await fetch('/api/settings/api-keys/test-draft', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({provider, apiKey, model}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.success) throw new Error(body.error ?? 'Test failed');
      setNotice(`Key OK · ${body.latency_ms} ms`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Test failed'); }
    finally { setBusy(false); }
  }

  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const invalid = validate();
      if (invalid) throw new Error(invalid);
      const token = await csrfToken();
      const response = await fetch('/api/settings/api-keys', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({provider, keyName, apiKey, model, purpose,
          dailyLimit: dailyLimit ? Number(dailyLimit) : null, notes: notes || null}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setKeyName(''); setApiKey(''); setNotes(''); setDailyLimit('');
      setNotice('Key added.');
      onCreated();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Save failed'); }
    finally { setBusy(false); }
  }

  return (
    <section className="card" style={{marginBottom: 14, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div><h3 style={{margin: 0}}>Add New Key</h3><p className="muted" style={{marginTop: 2, fontSize: 12}}>Keys are shown masked after saving. The full key is never returned by the API.</p></div>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpen(!open)}>{open ? 'Collapse' : 'Add New Key'}</Button>
      </div>
      {open ? (
        <div className="grid gap-2">
          <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 8}}>
            <label className="text-sm">Provider
              <select className="vessel-select" value={provider} onChange={(e) => { setProvider(e.target.value); setModel(e.target.value === 'gemini' ? 'gemini-2.0-flash' : ''); }}>
                {PROVIDERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-sm">Key Name<Input value={keyName} onChange={(e) => setKeyName(e.target.value)} placeholder="Gemini Free #1" /></label>
            <label className="text-sm">Model<Input value={model} onChange={(e) => setModel(e.target.value)} /></label>
            <label className="text-sm">API Key
              <span style={{display: 'flex', gap: 4}}>
                <Input type={show ? 'text' : 'password'} value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
                <Button type="button" size="sm" variant="outline" onClick={() => setShow(!show)}>{show ? 'Hide' : 'Show'}</Button>
              </span>
            </label>
            <label className="text-sm">Purpose
              <select className="vessel-select" value={purpose} onChange={(e) => setPurpose(e.target.value)}>
                {PURPOSES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label className="text-sm">Daily Limit (empty = unlimited)<Input type="number" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} /></label>
          </div>
          <label className="text-sm">Notes<Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}
          {notice ? <p style={{color: '#15803d'}}>{notice}</p> : null}
          <div className="row-actions">
            <Button type="button" size="sm" onClick={() => void save()} disabled={busy}>{busy ? 'Saving…' : 'Add Key'}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void testDraft()} disabled={busy}>Test Key</Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
