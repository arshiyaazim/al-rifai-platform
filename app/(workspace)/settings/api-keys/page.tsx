import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ApiKeysTable} from '@/components/standalone/api-keys-table';
import {ApiKeyForm} from '@/components/standalone/api-key-form';
import {llmStatus, routerStatus} from '@/lib/ai/llm';
import {apiKeyOverview, type PurposeOverview} from '@/lib/standalone/api-keys';
import {KEY_PURPOSES, providerLabel} from '@/lib/ai-provider';

export const dynamic = 'force-dynamic';

const ELLIPSIS = {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'} as const;
const shortModel = (value: string | null) => {
  const text = String(value ?? '—');
  return text.length > 28 ? `${text.slice(0, 27)}…` : text;
};

const PURPOSE_ORDER = ['platform-llm', 'platform-assistant', 'ocr', 'general', 'recruitment', 'vessel-ai'];
const RANK = new Map(PURPOSE_ORDER.map((id, index) => [id, index]));

export default async function ApiKeysPage() {
  const user = await pageUser();
  if (!can(user as never, 'settings.manage')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">ADMIN settings access is required.</p></section>;
  }

  let overview: PurposeOverview[] = [];
  try {
    overview = await apiKeyOverview();
  } catch {
    overview = [];
  }

  const router = routerStatus();
  const status = llmStatus();
  const label = (id: string) => KEY_PURPOSES.find((entry) => entry.id === id)?.label ?? id;
  const rows = [...overview].sort((a, b) => (RANK.get(a.purpose) ?? 99) - (RANK.get(b.purpose) ?? 99));
  const totals = rows.reduce((sum, entry) => ({
    total: sum.total + entry.total,
    active: sum.active + entry.active,
    cooldown: sum.cooldown + entry.cooldown,
    failed: sum.failed + entry.failed,
  }), {total: 0, active: 0, cooldown: 0, failed: 0});
  const ready = rows.filter((entry) => entry.provider && entry.active > 0).length;

  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>API Keys / এপিআই কী</h1>
        </div>
      </div>

      <div className="grid-cards" style={{marginBottom: 14}}>
        <div className="stat"><div className="label">Total Keys</div><div className="value">{totals.total}</div></div>
        <div className="stat"><div className="label">Active</div><div className="value">{totals.active}</div></div>
        <div className="stat"><div className="label">⏳ Rate-limited</div><div className="value">{totals.cooldown}</div></div>
        <div className="stat"><div className="label">❌ Failed</div><div className="value">{totals.failed}</div></div>
        <div className="stat"><div className="label">Purposes ready</div><div className="value">{ready}/{rows.length}</div></div>
      </div>

      <section className="card" style={{marginBottom: 14, padding: 14}}>
        <h3 style={{marginTop: 0}}>Key coverage per purpose</h3>
        <div style={{overflowX: 'auto', maxWidth: '100%'}}>
          <table className="cash-payment-table" style={{minWidth: 860, width: '100%', tableLayout: 'fixed'}}>
            <colgroup>
              <col style={{width: 160}} /><col style={{width: 260}} /><col style={{width: 90}} />
              <col style={{width: 80}} /><col style={{width: 70}} /><col style={{width: 70}} />
              <col style={{width: 65}} /><col style={{width: 65}} />
            </colgroup>
            <thead>
              <tr>
                <th>Purpose</th><th>First key</th><th>Mode</th><th>Priority</th>
                <th>Total</th><th>Active</th><th>⏳</th><th>❌</th>
              </tr>
            </thead>
            <tbody>
              {rows.length ? rows.map((entry) => (
                <tr key={entry.purpose}>
                  <td style={ELLIPSIS} title={entry.purpose}>{label(entry.purpose)}{entry.purpose === 'general' ? <span className="muted"> (legacy)</span> : null}</td>
                  <td style={ELLIPSIS} title={entry.provider ? `${entry.provider} · ${entry.model ?? '—'}` : 'no usable key'}>
                    {entry.provider
                      ? <>{providerLabel(entry.provider)} · <span style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{shortModel(entry.model)}</span></>
                      : <span className="muted">no usable key</span>}
                  </td>
                  <td style={ELLIPSIS} title={entry.is_free === null ? '—' : entry.is_free ? 'free tier' : 'paid'}>{entry.is_free === null ? '—' : entry.is_free ? <span className="pill ok">free</span> : <span className="pill">paid</span>}</td>
                  <td style={ELLIPSIS}>{entry.priority ?? '—'}</td>
                  <td style={ELLIPSIS}>{entry.total}</td>
                  <td style={ELLIPSIS}>{entry.active}</td>
                  <td style={ELLIPSIS}>{entry.cooldown}</td>
                  <td style={ELLIPSIS}>{entry.failed}</td>
                </tr>
              )) : <tr><td colSpan={8} className="muted">No API keys stored yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card" style={{marginBottom: 14, padding: 14}}>
        <h3 style={{marginTop: 0}}>Task routing</h3>
        <table className="cash-payment-table" style={{maxWidth: 720}}>
          <thead><tr><th>Task</th><th>Provider</th><th>Model</th><th>Status</th></tr></thead>
          <tbody>
            <tr>
              <td>Live replies / assistant</td>
              <td>Gemini / OpenAI / any</td>
              <td>{router.live.model ?? 'from database'}</td>
              <td>
                {!router.live.enabled
                  ? <span className="pill">⚫ AI_LLM_ENABLED=0</span>
                  : router.live.keySource === 'env'
                    ? <span className="pill ok">🟢 key from env</span>
                    : <span className="pill warn">🟡 database key</span>}
              </td>
            </tr>
            <tr>
              <td>Drafting / offline</td>
              <td>Ollama (local)</td>
              <td>{router.draft.model ?? '—'}</td>
              <td>{router.draft.enabled ? <span className="pill ok">🟢 ready</span> : <span className="pill">⚫ no model</span>}</td>
            </tr>
            <tr>
              <td>Vision / OCR</td>
              <td>Ollama / ocr key</td>
              <td>{router.vision.model}</td>
              <td><span className="pill">◈ on demand</span></td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{marginBottom: 0, fontSize: 12}}>
          Endpoint: {router.live.baseUrl} · timeout {status.timeoutMs} ms · max {status.maxTokens} tokens.
          {router.live.keySource === 'env' && status.configured ? ' An environment key is set; the database key is still preferred when present.' : ''}
        </p>
      </section>

      <ApiKeyForm defaultPurpose="platform-llm" />

      <ApiKeysTable />
    </div>
  );
}
