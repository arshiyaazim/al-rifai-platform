import Link from 'next/link';
import type {ProgramSourceRow, SourceMessageRow} from '@/lib/standalone/review';
import {formatDhakaDateTime, type SourceEvidence} from '@/lib/review-ui';

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
  const primary = sourceMessages[0];
  const senderName = primary?.sender_name ?? evidence.senderName ?? null;
  const senderMobile = primary?.sender_mobile ?? evidence.senderMobile ?? null;
  return (
    <section className="card">
      <h3>Source message</h3>
      {!hasEvidence ? (
        <p className="muted">No source message is linked to this item. Web-created records do not have WhatsApp provenance.</p>
      ) : null}

      {evidence.messageId ? (
        <div style={{marginBottom: 12, display: 'grid', gap: 12}}>
          <div className="grid" style={{gridTemplateColumns: '1fr 1fr'}}>
            <div><span className="muted">Sender name</span><br /><strong>{senderName ?? '—'}</strong></div>
            <div><span className="muted">Mobile</span><br /><strong>{senderMobile ?? '—'}</strong></div>
            <div><span className="muted">Date / time</span><br />{formatDhakaDateTime(evidence.timestamp)}</div>
          </div>
          {evidence.rawText ? (
            <div style={{padding: '10px 12px', background: '#f7fafc', border: '1px solid var(--line)', borderRadius: 8, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13}}>
              {evidence.rawText}
            </div>
          ) : null}
          <p style={{margin: 0}}>
            <MessageLink href={evidence.messageHref}>Open in WhatsApp inbox →</MessageLink>
          </p>
        </div>
      ) : null}

      {sourceMessages.length ? (
        <div style={{marginTop: 10}}>
          <h4 style={{textTransform: 'none', letterSpacing: 0, color: 'var(--ink)', fontSize: 13}}>Supporting messages ({sourceMessages.length})</h4>
          <table>
            <thead><tr><th>Sender</th><th>When</th><th>Text</th></tr></thead>
            <tbody>
              {sourceMessages.map((message) => (
                <tr key={message.id}>
                  <td>{message.sender_name ?? <span className="muted">—</span>}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatDhakaDateTime(message.source_timestamp)}</td>
                  <td style={{maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{message.text_content ?? <span className="muted">[{message.media_type ?? 'no text'}]</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {programSources.length ? (
        <div style={{marginTop: 10}}>
          <h4 style={{textTransform: 'none', letterSpacing: 0, color: 'var(--ink)', fontSize: 13}}>Related messages ({programSources.length})</h4>
          <table>
            <thead><tr><th>Role</th><th>When</th><th>Text</th></tr></thead>
            <tbody>
              {programSources.map((source) => (
                <tr key={source.id}>
                  <td><span className={`pill ${source.source_role === 'primary' ? 'ok' : ''}`}>{source.source_role}</span></td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatDhakaDateTime(source.source_timestamp)}</td>
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
