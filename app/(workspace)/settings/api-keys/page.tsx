import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ApiKeysTable} from '@/components/standalone/api-keys-table';
import {ApiKeyForm} from '@/components/standalone/api-key-form';
import {llmStatus, routerStatus} from '@/lib/ai/llm';

export const dynamic = 'force-dynamic';

export default async function ApiKeysPage() {
  const user = await pageUser();
  if (!can(user as never, 'settings.manage')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">ADMIN settings access is required.</p></section>;
  }
  const router = routerStatus();
  const gemini = llmStatus();
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>API Keys / এপিআই কী</h1>
          <p className="muted">Manage Gemini, OpenAI and other AI API keys. Keys are shown masked; the full value is never returned.</p>
        </div>
      </div>

      <section className="card" style={{marginBottom: 14, padding: 14}}>
        <h3 style={{marginTop: 0}}>AI / LLM — Gemini + local Ollama</h3>
        <p className="muted" style={{marginTop: 2, fontSize: 12}}>
          Paste a Gemini key below with purpose <strong>AI / LLM</strong> to enable live WhatsApp replies.
          The key is verified against Google, encrypted at rest, and never returned to the browser in full.
        </p>
        <table className="cash-payment-table" style={{maxWidth: 720}}>
          <thead><tr><th>Task</th><th>Provider</th><th>Model</th><th>Status</th></tr></thead>
          <tbody>
            <tr>
              <td>Live WhatsApp replies</td>
              <td>Gemini</td>
              <td>{router.live.model ?? '—'}</td>
              <td>
                {!router.live.enabled
                  ? <span className="pill">⚫ AI_LLM_ENABLED=0</span>
                  : router.live.keySource === 'env'
                    ? <span className="pill ok">🟢 key from env</span>
                    : <span className="pill warn">🟡 add a key below</span>}
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
              <td>Ollama (local)</td>
              <td>{router.vision.model}</td>
              <td><span className="pill">◈ on demand</span></td>
            </tr>
          </tbody>
        </table>
        <p className="muted" style={{marginBottom: 0, fontSize: 12}}>
          Endpoint: {router.live.baseUrl} · timeout {gemini.timeoutMs} ms · max {gemini.maxTokens} tokens.
          {router.live.keySource === 'env' && gemini.configured ? ' An environment key is also set; it wins over the database.' : ''}
        </p>
      </section>

      <ApiKeyForm defaultPurpose="general" />

      <ApiKeysTable />
    </div>
  );
}
