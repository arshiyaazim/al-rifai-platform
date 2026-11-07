'use client';

import {useState} from 'react';

export function AssistantConsole() {
  const [query, setQuery] = useState('');
  const [answer, setAnswer] = useState<string | null>(null);
  const [meta, setMeta] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setAnswer(null);
    setMeta(null);
    try {
      const session = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
      if (!session.ok) throw new Error('AUTHENTICATION_REQUIRED');
      const {csrf} = (await session.json()) as {csrf: string};
      const response = await fetch('/api/assistant', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': csrf},
        body: JSON.stringify({action: 'query', query}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      const result = body as {answer?: unknown; tool?: unknown; data?: unknown};
      setAnswer(typeof result.answer === 'string' ? result.answer : JSON.stringify(result, null, 2));
      setMeta({tool: result.tool ?? null, data: result.data ?? null});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'QUERY_FAILED');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card form">
      <form onSubmit={submit}>
        <label>
          <span>Ask the Admin Assistant</span>
          <textarea
            name="query"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="employee <name or mobile> | cash <YYYY-MM-DD> | vessel <name> | attendance <YYYY-MM-DD>"
            required
          />
        </label>
        <button type="submit" disabled={busy}>{busy ? 'Querying…' : 'Ask'}</button>
      </form>
      {error ? <p className="error">{error}</p> : null}
      {answer ? <pre style={{whiteSpace: 'pre-wrap', marginTop: 16}}>{answer}</pre> : null}
      {meta ? (
        <details style={{marginTop: 12}}>
          <summary className="muted">Tool evidence</summary>
          <pre style={{whiteSpace: 'pre-wrap', fontSize: 11}}>{JSON.stringify(meta, null, 2)}</pre>
        </details>
      ) : null}
      <p className="muted" style={{marginTop: 12}}>
        Answers are grounded in authorized database tools. Outbound messaging and automatic replies remain disabled.
      </p>
    </div>
  );
}
