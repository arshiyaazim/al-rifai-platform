'use client';

import {useRef, useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';

type ParsedPreview = {timestamp: string; sender: string; body: string};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

/**
 * WhatsApp "Export Chat" importer. Parsing is client-side for the dry-run
 * preview; the server re-parses the exact file before inserting anything.
 */
export function ChatImportDialog({onImported}: {onImported?: () => void}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ParsedPreview[]>([]);
  const [skipped, setSkipped] = useState(0);
  const [rejected, setRejected] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState<Record<string, unknown> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function choose(next: File | null) {
    setFile(next);
    setSummary(null);
    setError('');
    setPreview([]);
    setSkipped(0);
    setRejected(0);
    if (!next) return;
    try {
      const {parseWhatsAppChat} = await import('@/lib/whatsapp-chat-parser');
      const parsed = parseWhatsAppChat(await next.text());
      setPreview(parsed.messages.slice(0, 100));
      setSkipped(parsed.skipped);
      setRejected(parsed.rejected.length);
    } catch {
      setError('Could not parse this file.');
    }
  }

  async function submit() {
    if (!file) return;
    setBusy(true);
    setError('');
    try {
      const token = await csrfToken();
      const data = new FormData();
      data.append('file', file);
      const response = await fetch('/api/whatsapp/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'X-CSRF-Token': token},
        body: data,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setSummary(body as Record<string, unknown>);
      toast.success(`Imported ${String(body.imported ?? 0)} message(s).`);
      onImported?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>
        Import Chat
      </Button>
      {open ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Import WhatsApp chat export"
          style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}
        >
          <div className="card" style={{width: 'min(920px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
            <div className="page-head" style={{marginBottom: 10}}>
              <div>
                <h3 style={{margin: 0}}>Import WhatsApp chat export</h3>
                <p className="muted" style={{marginTop: 4}}>
                  Accepts the .txt file WhatsApp exports. The preview is a dry run; nothing is sent to WhatsApp.
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)} disabled={busy}>Close</Button>
            </div>

            <input
              ref={inputRef}
              type="file"
              accept=".txt,text/plain"
              onChange={(event) => void choose(event.target.files?.[0] ?? null)}
              style={{display: 'block', marginBottom: 10}}
            />

            {file ? (
              <p className="muted" style={{fontSize: 12}}>
                {file.name} · {(file.size / 1024).toFixed(1)} KB · parsed {preview.length}{preview.length === 100 ? '+' : ''} message(s)
                · skipped {skipped} · rejected {rejected}
              </p>
            ) : null}

            {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

            {preview.length ? (
              <div style={{maxHeight: 320, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 12}}>
                <table style={{width: '100%', fontSize: 12}}>
                  <thead><tr><th>Timestamp</th><th>Sender</th><th>Message</th></tr></thead>
                  <tbody>
                    {preview.map((message, index) => (
                      <tr key={`${message.timestamp}-${index}`}>
                        <td style={{whiteSpace: 'nowrap'}}>{message.timestamp.replace('T', ' ').slice(0, 19)}</td>
                        <td>{message.sender}</td>
                        <td style={{maxWidth: 420, whiteSpace: 'pre-wrap'}}>{message.body.slice(0, 160)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {summary ? (
              <div style={{border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13}}>
                Imported <strong>{String(summary.imported ?? 0)}</strong> ·
                duplicates <strong>{String(summary.duplicates ?? 0)}</strong> ·
                skipped <strong>{String(summary.skipped ?? 0)}</strong> ·
                rejected <strong>{String(summary.rejected ?? 0)}</strong>
                {Array.isArray(summary.errors) && summary.errors.length ? <div>Errors: {summary.errors.join(', ')}</div> : null}
              </div>
            ) : null}

            <div className="row-actions">
              <Button type="button" onClick={() => void submit()} disabled={!file || busy || !preview.length}>
                {busy ? 'Importing…' : 'Import messages'}
              </Button>
              <Button type="button" variant="outline" onClick={() => { void choose(null); if (inputRef.current) inputRef.current.value = ''; }} disabled={busy}>
                Clear
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
