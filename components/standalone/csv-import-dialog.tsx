'use client';

import {useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';

type Mapping = {
  matched: Array<{field: string; label: string; header: string; how: string}>;
  unmatched: string[];
  missingRequired: Array<{field: string; label: string; suggestions: string[]}>;
};

type Preview = {
  dryRun: true;
  totalRows: number;
  columnMapping: Mapping;
  preview: Array<Record<string, unknown>>;
  parseErrors: Array<{line: number; reason: string}>;
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function CsvImportDialog({
  title, endpoint, templateHint, onImported,
}: {
  title: string;
  endpoint: string;
  templateHint: string;
  onImported?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function reset() {
    setFile(null);
    setPreview(null);
    setResult(null);
    setError('');
  }

  async function upload(next: File | null) {
    setFile(next);
    setPreview(null);
    setResult(null);
    setError('');
    if (!next) return;
    setBusy(true);
    try {
      const token = await csrfToken();
      const data = new FormData();
      data.append('file', next);
      const response = await fetch(`${endpoint}?dryRun=true`, {
        method: 'POST', credentials: 'same-origin',
        headers: {'X-CSRF-Token': token}, body: data,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        const missing = Array.isArray(body.missingRequired)
          ? body.missingRequired.map((item: {label?: string}) => item.label).join(', ')
          : '';
        throw new Error(`${body.error ?? `HTTP_${response.status}`}${missing ? `: ${missing}` : ''}`);
      }
      setPreview(body as Preview);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Preview failed.');
    } finally {
      setBusy(false);
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
      const response = await fetch(endpoint, {
        method: 'POST', credentials: 'same-origin',
        headers: {'X-CSRF-Token': token}, body: data,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setResult(body as Record<string, unknown>);
      toast.success(`Imported ${String(body.imported ?? 0)} row(s).`);
      onImported?.();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Import failed.');
    } finally {
      setBusy(false);
    }
  }

  const errors = Array.isArray(result?.errors) ? result.errors as Array<{row: number; reason: string}> : [];

  return (
    <>
      <Button type="button" size="sm" variant="outline" onClick={() => setOpen(true)}>Import CSV</Button>
      {open ? (
        <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}>
          <div className="card" style={{width: 'min(920px, 100%)', maxHeight: '90vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
            <div className="page-head" style={{marginBottom: 8}}>
              <div><h3 style={{margin: 0}}>{title}</h3><p className="muted" style={{marginTop: 4}}>{templateHint}</p></div>
              <Button type="button" size="sm" variant="outline" onClick={() => { reset(); setOpen(false); }} disabled={busy}>Close</Button>
            </div>

            <input type="file" accept=".csv,text/csv" onChange={(event) => void upload(event.target.files?.[0] ?? null)} style={{display: 'block', marginBottom: 10}} />
            {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

            {preview ? (
              <>
                <p className="muted" style={{fontSize: 12}}>
                  {preview.totalRows} data row(s) · mapped {preview.columnMapping.matched.length} column(s)
                </p>
                <div style={{maxHeight: 180, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, padding: 8, marginBottom: 10}}>
                  <table style={{fontSize: 12, width: '100%'}}>
                    <thead><tr><th>CSV Header</th><th>Mapped Field</th><th>How</th></tr></thead>
                    <tbody>
                      {preview.columnMapping.matched.map((item) => (
                        <tr key={`${item.header}-${item.field}`}><td>{item.header}</td><td>{item.label}</td><td>{item.how}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {preview.columnMapping.unmatched.length ? (
                    <p className="muted" style={{fontSize: 11}}>Ignored: {preview.columnMapping.unmatched.join(', ')}</p>
                  ) : null}
                </div>
                <div style={{maxHeight: 230, overflow: 'auto', border: '1px solid #e5e7eb', borderRadius: 8, marginBottom: 10}}>
                  <table style={{fontSize: 11, width: '100%'}}>
                    <thead><tr>{Object.keys(preview.preview[0] ?? {}).map((key) => <th key={key}>{key}</th>)}</tr></thead>
                    <tbody>
                      {preview.preview.map((row, index) => (
                        <tr key={index}>{Object.keys(preview.preview[0] ?? {}).map((key) => <td key={key}>{String(row[key] ?? '')}</td>)}</tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            ) : null}

            {result ? (
              <div style={{border: '1px solid #bbf7d0', background: '#f0fdf4', borderRadius: 8, padding: 10, marginBottom: 10, fontSize: 13}}>
                Imported <strong>{String(result.imported ?? 0)}</strong> ·
                duplicates <strong>{String(result.duplicates ?? 0)}</strong> ·
                skipped <strong>{String(result.skipped ?? 0)}</strong>
                {errors.length ? (
                  <details style={{marginTop: 6}}>
                    <summary>{errors.length} error row(s)</summary>
                    <ul>{errors.slice(0, 30).map((item) => <li key={`${item.row}-${item.reason}`}>Row {item.row}: {item.reason}</li>)}</ul>
                  </details>
                ) : null}
              </div>
            ) : null}

            <div className="row-actions">
              <Button type="button" onClick={() => void submit()} disabled={!preview || busy || Boolean(result)}>
                {busy ? 'Working…' : 'Confirm import'}
              </Button>
              <Button type="button" variant="outline" onClick={() => { reset(); }} disabled={busy}>Clear</Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
