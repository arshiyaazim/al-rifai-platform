'use client';

import {useEffect, useRef, useState} from 'react';
import {usePathname} from 'next/navigation';

/**
 * Floating, read-only dashboard helper. Available to every authenticated user.
 *
 * It never drafts, approves, deletes or sends anything: the API answers from the
 * same totals the dashboard cards use. The admin kill-switch lives in Settings.
 */
type Message = {role: 'user' | 'assistant'; text: string};

const SUGGESTIONS = [
  'How many employees joined this month?',
  'Cash payments today?',
  'Attendance today?',
  'Vessel programmes this month?',
];

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

const ERROR_TEXT: Record<string, string> = {
  ASSISTANT_DISABLED: 'The assistant has been turned off by the administrator.',
  RATE_LIMITED: 'Hourly limit reached. Please try again later.',
  SESSION_EXPIRED: 'Your session expired. Reload the page and sign in again.',
};

export function FloatingAssistant() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || messages.length) return;
    setMessages([{
      role: 'assistant',
      text: 'Hello. I can look up dashboard totals for employees, attendance, vessel programmes and cash. What would you like to know?',
    }]);
  }, [open, messages.length]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [messages, busy, open]);

  async function send(question: string) {
    const text = question.trim();
    if (!text || busy) return;
    setMessages((current) => [...current, {role: 'user', text}]);
    setInput('');
    setBusy(true);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/assistant/chat', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({message: text, page: pathname}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) {
        const code = String(body.error ?? `HTTP_${response.status}`);
        throw new Error(ERROR_TEXT[code] ?? code);
      }
      if (typeof body.remaining === 'number') setRemaining(body.remaining);
      setMessages((current) => [...current, {role: 'assistant', text: String(body.answer ?? '')}]);
    } catch (cause) {
      const message = cause instanceof Error ? ERROR_TEXT[cause.message] ?? cause.message : 'Something went wrong.';
      setMessages((current) => [...current, {role: 'assistant', text: `Sorry — ${message}`}]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <style>{`
        @keyframes alrifai-pulse {0%{box-shadow:0 0 0 0 rgba(13,148,136,.45)}70%{box-shadow:0 0 0 14px rgba(13,148,136,0)}100%{box-shadow:0 0 0 0 rgba(13,148,136,0)}}
        @keyframes alrifai-blink {0%,80%,100%{opacity:.25}40%{opacity:1}}
        .alrifai-fab{animation:alrifai-pulse 2.6s infinite}
        .alrifai-fab:hover{transform:translateY(-2px)}
        .alrifai-dot{animation:alrifai-blink 1.2s infinite}
        @media (max-width: 520px){
          .alrifai-panel{left:8px !important;right:8px !important;bottom:8px !important;width:auto !important;height:min(76vh,560px) !important}
          .alrifai-label{display:none !important}
        }
      `}</style>

      {open ? (
        <section
          role="dialog"
          aria-label="Dashboard assistant"
          className="alrifai-panel"
          style={{
            position: 'fixed', right: 20, bottom: 20, zIndex: 80,
            width: 'min(380px, calc(100vw - 24px))', height: 'min(560px, calc(100vh - 96px))',
            display: 'flex', flexDirection: 'column', overflow: 'hidden',
            background: 'var(--panel, #ffffff)', color: 'var(--ink, #0f172a)',
            border: '1px solid var(--line, #e2e8f0)', borderRadius: 16,
            boxShadow: '0 24px 48px rgba(15, 23, 42, .22)',
          }}
        >
          <header style={{display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', borderBottom: '1px solid var(--line, #e2e8f0)'}}>
            <span aria-hidden style={{
              width: 30, height: 30, borderRadius: 9, display: 'grid', placeItems: 'center',
              background: 'var(--accent, #0f766e)', color: '#fff', fontWeight: 700,
            }}>AI</span>
            <div style={{flex: 1, minWidth: 0}}>
              <div style={{fontWeight: 600, fontSize: 13}}>AL-RIFA&apos;I Assistant</div>
              <div className="muted" style={{fontSize: 11}}>Read-only dashboard help</div>
            </div>
            <button type="button" onClick={() => setOpen(false)} aria-label="Minimize assistant"
              style={{border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', borderRadius: 8, width: 28, height: 28, cursor: 'pointer'}}>–</button>
          </header>

          <div ref={listRef} style={{flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8}}>
            {messages.map((message, index) => (
              <div key={index} style={{display: 'flex', justifyContent: message.role === 'user' ? 'flex-end' : 'flex-start'}}>
                <div style={{
                  maxWidth: '86%', padding: '8px 10px', borderRadius: 12, fontSize: 13, lineHeight: 1.45,
                  whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                  background: message.role === 'user' ? 'var(--accent, #0f766e)' : 'var(--dash-soft, #f1f5f9)',
                  color: message.role === 'user' ? '#fff' : 'inherit',
                  borderBottomRightRadius: message.role === 'user' ? 4 : 12,
                  borderBottomLeftRadius: message.role === 'user' ? 12 : 4,
                }}>{message.text}</div>
              </div>
            ))}
            {busy ? (
              <div style={{display: 'flex', gap: 4, padding: '8px 10px', width: 54, borderRadius: 12, background: 'var(--dash-soft, #f1f5f9)'}} aria-label="Assistant is typing">
                {[0, 1, 2].map((dot) => (
                  <span key={dot} className="alrifai-dot" style={{width: 6, height: 6, borderRadius: 3, background: 'var(--muted, #64748b)', animationDelay: `${dot * 0.16}s`}} />
                ))}
              </div>
            ) : null}
            {!messages.length || messages.length === 1 ? (
              <div style={{display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4}}>
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={busy}
                    style={{fontSize: 11, padding: '5px 8px', borderRadius: 999, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', cursor: 'pointer'}}>
                    {suggestion}
                  </button>
                ))}
              </div>
            ) : null}
          </div>

          <form onSubmit={(event) => { event.preventDefault(); void send(input); }}
            style={{display: 'flex', gap: 8, padding: 10, borderTop: '1px solid var(--line, #e2e8f0)'}}>
            <input value={input} onChange={(event) => setInput(event.target.value)} maxLength={500}
              placeholder="Ask about your dashboard…" aria-label="Your question"
              style={{flex: 1, minWidth: 0, padding: '8px 10px', borderRadius: 10, border: '1px solid var(--line, #e2e8f0)', background: 'transparent', color: 'inherit', fontSize: 13}} />
            <button type="submit" disabled={busy || !input.trim()}
              style={{padding: '8px 12px', borderRadius: 10, border: 0, background: 'var(--accent, #0f766e)', color: '#fff', fontWeight: 600, cursor: busy || !input.trim() ? 'default' : 'pointer', opacity: busy || !input.trim() ? 0.6 : 1}}>
              Send
            </button>
          </form>
          <p className="muted" style={{margin: 0, padding: '0 12px 8px', fontSize: 10}}>
            Read-only · dashboard totals only · no drafts or changes
            {remaining !== null ? ` · ${remaining} questions left this hour` : ''}
          </p>
        </section>
      ) : (
        <div style={{position: 'fixed', right: 20, bottom: 20, zIndex: 80, display: 'flex', alignItems: 'center', gap: 8}}>
          <span className="alrifai-label" style={{
            background: 'var(--panel, #ffffff)', color: 'var(--ink, #0f172a)', border: '1px solid var(--line, #e2e8f0)',
            borderRadius: 999, padding: '5px 10px', fontSize: 11, boxShadow: '0 6px 16px rgba(15, 23, 42, .12)',
          }}>Need help? Ask a question</span>
          <button type="button" className="alrifai-fab" onClick={() => setOpen(true)} aria-label="Open dashboard assistant"
            title="Need Help? Ask a Question"
            style={{
              width: 56, height: 56, borderRadius: 28, border: 0, cursor: 'pointer',
              background: 'linear-gradient(135deg, #0f766e, #0d9488)', color: '#fff',
              fontSize: 22, fontWeight: 700, transition: 'transform .15s ease',
            }}>?</button>
        </div>
      )}
    </>
  );
}
