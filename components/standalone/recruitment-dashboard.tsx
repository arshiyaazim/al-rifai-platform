'use client';

import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {Button} from '@/components/ui/button';

type LogRow = {
  id: string; timestamp: string; chat_jid: string; sender_name: string | null;
  sender_mobile: string | null; incoming_message: string | null; incoming_message_type: string | null;
  category: string | null; ai_reply: string | null; status: string; skip_reason: string | null;
  gemini_key_id: string | null; gemini_latency_ms: number | null; error: string | null;
};
type Payload = {
  mode: string; env: {dryRun: string; sendEnabled: string; allowSendStep3: string};
  liveEffective: boolean; stats: Record<string, number>;
  byStatus: Array<{status: string; count: number}>;
  byCategory: Array<{category: string | null; count: number}>;
  logs: LogRow[]; blocked: string[];
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const when = (value: string) => new Date(value).toLocaleString('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'short', timeStyle: 'short'});
const pill = (status: string) => status === 'SENT' ? 'ok' : status === 'FAILED' ? 'bad'
  : status === 'QUEUED' ? 'warn' : '';

export function RecruitmentDashboard() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState('');
  const [viewing, setViewing] = useState<LogRow | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch('/api/settings/recruitment', {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setData(body as Payload);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load dashboard.'); }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect -- initial async read
  useEffect(() => { void load(); }, []);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/settings/recruitment', {
        method: 'POST', credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify(body),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
      await load();
      return payload;
    } finally { setBusy(false); }
  }

  async function toggleMode() {
    if (!data) return;
    if (data.mode === 'LIVE') {
      if (!window.confirm('Switch recruitment AI back to DRY_RUN?')) return;
      await post({action: 'mode', mode: 'DRY_RUN'});
      toast.success('Mode: DRY_RUN');
      return;
    }
    const typed = window.prompt('Type LIVE_APPROVED to request LIVE mode. Live is still blocked unless SEND_ENABLED=1, ALLOW_SEND_STEP3=1 and DRY_RUN=0.');
    if (typed !== 'LIVE_APPROVED') return;
    const result = await post({action: 'mode', mode: 'LIVE', confirm: typed});
    toast.success(`Mode: ${result.mode}`);
  }

  if (error) return <p role="alert" style={{color: '#b91c1c'}}>{error}</p>;
  if (!data) return <p className="muted">Loading recruitment dashboard…</p>;

  const s = data.stats;
  return (
    <>
      <div className="grid-cards" style={{marginBottom: 14}}>
        <div className="stat"><div className="label">Messages (24h)</div><div className="value">{s.messages ?? 0}</div></div>
        <div className="stat"><div className="label">Replies sent</div><div className="value">{s.sent ?? 0}</div></div>
        <div className="stat"><div className="label">Dry-run</div><div className="value">{s.dry_run ?? 0}</div></div>
        <div className="stat"><div className="label">Skipped</div><div className="value">{s.skipped ?? 0}</div></div>
        <div className="stat"><div className="label">Failed</div><div className="value">{s.failed ?? 0}</div></div>
        <div className="stat"><div className="label">Known filtered</div><div className="value">{s.known_filtered ?? 0}</div></div>
      </div>

      <section className="card" style={{marginBottom: 14, padding: 14}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div>
            <h3 style={{margin: 0}}>Mode: {data.mode} {data.liveEffective ? '· LIVE EFFECTIVE' : '· not live'}</h3>
            <p className="muted" style={{marginTop: 2, fontSize: 12}}>
              Env: DRY_RUN={data.env.dryRun} · SEND_ENABLED={data.env.sendEnabled} · ALLOW_SEND_STEP3={data.env.allowSendStep3}
            </p>
          </div>
          <Button type="button" size="sm" variant={data.mode === 'LIVE' ? 'outline' : 'default'} disabled={busy} onClick={() => void toggleMode()}>
            {data.mode === 'LIVE' ? 'Switch to DRY_RUN' : 'Request LIVE mode'}
          </Button>
        </div>
        {!data.liveEffective ? <p className="muted" style={{fontSize: 12}}>Live sending remains blocked by at least one environment gate. This is intentional until the Owner explicitly approves.</p> : null}
      </section>

      <section className="card" style={{marginBottom: 14}}>
        <h3>By category (24h)</h3>
        <div className="row-actions" style={{flexWrap: 'wrap'}}>
          {data.byCategory.length ? data.byCategory.map((item) => (
            <span className="pill" key={item.category ?? 'none'}>{item.category ?? 'UNKNOWN'}: {item.count}</span>
          )) : <span className="muted">No entries yet.</span>}
        </div>
      </section>

      <section className="card">
        <h3>Reply Audit Log (last 50)</h3>
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 1100}}>
            <thead><tr><th>Time</th><th>Sender</th><th>Category</th><th>Incoming</th><th>AI Reply</th><th>Status</th><th>Action</th></tr></thead>
            <tbody>
              {data.logs.map((log) => (
                <tr key={log.id}>
                  <td style={{whiteSpace: 'nowrap'}}>{when(log.timestamp)}</td>
                  <td>{log.sender_name ?? '—'}<small className="muted" style={{display: 'block'}}>{log.sender_mobile ?? log.chat_jid}</small></td>
                  <td>{log.category ?? '—'}</td>
                  <td style={{maxWidth: 260, whiteSpace: 'pre-wrap'}}>{(log.incoming_message ?? '').slice(0, 160)}</td>
                  <td style={{maxWidth: 320, whiteSpace: 'pre-wrap'}}>{(log.ai_reply ?? '').slice(0, 200)}</td>
                  <td><span className={`pill ${pill(log.status)}`}>{log.status}</span>{log.skip_reason ? <small className="muted" style={{display: 'block'}}>{log.skip_reason}</small> : null}</td>
                  <td>
                    <div className="row-actions">
                      <Button type="button" size="sm" variant="outline" onClick={() => setViewing(log)}>View</Button>
                      {log.sender_mobile ? (
                        <Button type="button" size="sm" variant="outline" disabled={busy}
                          onClick={() => { if (window.confirm(`Block ${log.sender_mobile}?`)) void post({action: 'block', mobile: log.sender_mobile}); }}>
                          Block
                        </Button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
              {!data.logs.length ? <tr><td colSpan={7} className="muted">No audit entries yet. Add a Gemini key, then run the AI in dry-run.</td></tr> : null}
            </tbody>
          </table>
        </div>
      </section>

      {viewing ? (
        <div role="dialog" aria-modal="true" style={{position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(15,23,42,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16}}
          onMouseDown={(event) => { if (event.target === event.currentTarget) setViewing(null); }}>
          <div className="card" style={{width: 'min(760px, 100%)', maxHeight: '85vh', overflow: 'auto', background: 'var(--background, #fff)'}}>
            <div className="page-head" style={{marginBottom: 8}}>
              <div><h3 style={{margin: 0}}>{viewing.sender_name ?? viewing.chat_jid}</h3><p className="muted" style={{marginTop: 2}}>{when(viewing.timestamp)} · {viewing.status}</p></div>
              <Button type="button" size="sm" variant="outline" onClick={() => setViewing(null)}>Close</Button>
            </div>
            <h4>Incoming</h4>
            <pre style={{whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 10, borderRadius: 8}}>{viewing.incoming_message || '—'}</pre>
            <h4>AI Reply</h4>
            <pre style={{whiteSpace: 'pre-wrap', background: '#f8fafc', padding: 10, borderRadius: 8}}>{viewing.ai_reply || '—'}</pre>
            {viewing.skip_reason ? <p className="muted">Skip: {viewing.skip_reason}</p> : null}
            {viewing.error ? <p style={{color: '#b91c1c'}}>Error: {viewing.error}</p> : null}
          </div>
        </div>
      ) : null}
    </>
  );
}
