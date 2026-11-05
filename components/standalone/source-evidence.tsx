import Link from 'next/link';
import type {ProgramSourceRow, SourceMessageRow} from '@/lib/standalone/review';
import {formatReviewTimestamp, type SourceEvidence} from '@/lib/review-ui';

type Props = {
  evidence: SourceEvidence;
  sourceMessages?: SourceMessageRow[];
  programSources?: ProgramSourceRow[];
};

function MessageLink({href, children}: {href: string | null; children: React.ReactNode}) {
  if (!href) return <span className="muted">{children}</span>;
  return <Link href={href}>{children}</Link>;
}

/**
 * Read-only source-message evidence. The raw WhatsApp text is shown exactly as
 * ingested; nothing here creates a business record or a second confirmation.
 */
export function SourceEvidencePanel({evidence, sourceMessages = [], programSources = []}: Props) {
  const hasEvidence = Boolean(evidence.messageId || sourceMessages.length || programSources.length);
  return (
    <section className="card">
      <h3>Source-message evidence</h3>
      {!hasEvidence ? (
        <p className="muted">No source message is linked to this item. Web-created records do not have WhatsApp provenance.</p>
      ) : null}

      {evidence.messageId ? (
        <div style={{marginBottom: 12}}>
          <table>
            <tbody>
              <tr><th style={{width: 180}}>Message ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{evidence.messageId}</td></tr>
              <tr><th>Account</th><td>{evidence.accountId ?? '—'}</td></tr>
              <tr><th>Chat JID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{evidence.chatJid ?? '—'}</td></tr>
              <tr><th>Direction</th><td>{evidence.direction ?? '—'}</td></tr>
              <tr><th>Sender</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{evidence.senderJid ?? '—'}</td></tr>
              <tr><th>Source timestamp</th><td>{formatReviewTimestamp(evidence.timestamp)}</td></tr>
              <tr><th>Parser</th><td>{evidence.parser ?? '—'}</td></tr>
              <tr><th>Classification</th><td>{evidence.classification ?? '—'}</td></tr>
            </tbody>
          </table>
          {evidence.parseReasons.length ? (
            <div className="row-actions" style={{marginTop: 8}}>
              {evidence.parseReasons.map((reason) => <span key={reason} className="pill warn">{reason}</span>)}
            </div>
          ) : null}
          {evidence.rawText ? (
            <div style={{marginTop: 10, padding: '10px 12px', background: '#f7fafc', border: '1px solid var(--line)', borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13}}>
              {evidence.rawText}
            </div>
          ) : null}
          <p style={{marginTop: 8}}>
            <MessageLink href={evidence.messageHref}>Open this message in the WhatsApp inbox →</MessageLink>
          </p>
        </div>
      ) : null}

      {sourceMessages.length ? (
        <div style={{marginTop: 10}}>
          <h4 style={{textTransform: 'none', letterSpacing: 0, color: 'var(--ink)', fontSize: 13}}>Matched source messages ({sourceMessages.length})</h4>
          <table>
            <thead><tr><th>Message</th><th>Direction</th><th>Sender</th><th>When</th><th>Processing</th><th>Text</th></tr></thead>
            <tbody>
              {sourceMessages.map((message) => (
                <tr key={message.id}>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                    <MessageLink href={`/messages?q=${encodeURIComponent(message.message_id)}`}>{message.message_id}</MessageLink>
                  </td>
                  <td>{message.direction}</td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{message.sender_jid ?? '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(message.source_timestamp)}</td>
                  <td><span className={`pill ${message.processing_status === 'COMPLETED' ? 'ok' : message.processing_status === 'FAILED' ? 'bad' : 'warn'}`}>{message.processing_status}</span></td>
                  <td style={{maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{message.text_content ?? <span className="muted">[{message.media_type ?? 'no text'}]</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {programSources.length ? (
        <div style={{marginTop: 10}}>
          <h4 style={{textTransform: 'none', letterSpacing: 0, color: 'var(--ink)', fontSize: 13}}>Multi-message program evidence ({programSources.length})</h4>
          <table>
            <thead><tr><th>Role</th><th>Message</th><th>Direction</th><th>When</th><th>Text</th></tr></thead>
            <tbody>
              {programSources.map((source) => (
                <tr key={source.id}>
                  <td><span className={`pill ${source.source_role === 'primary' ? 'ok' : ''}`}>{source.source_role}</span></td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                    <MessageLink href={`/messages?q=${encodeURIComponent(source.message_id)}`}>{source.message_id}</MessageLink>
                  </td>
                  <td>{source.direction ?? '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(source.source_timestamp)}</td>
                  <td style={{maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{source.text_content ?? <span className="muted">no text</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
