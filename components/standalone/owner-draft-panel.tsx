import {CopyDraftButton} from '@/components/standalone/copy-draft-button';
import type {OrderDraftResult} from '@/lib/order-draft-from-record';

/**
 * Server-rendered Owner draft block. The text is the exact ten-line layout from
 * lib/order-draft-template.ts; this panel only displays and copies it.
 */
export function OwnerDraftPanel({
  result,
  title = 'Owner order draft',
  description = 'Exact Admin/Client draft layout. Escort fields stay blank until the Admin assigns them.',
}: {
  result: OrderDraftResult;
  title?: string;
  description?: string;
}) {
  return (
    <section className="card">
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>{title}</h3>
          <p className="muted" style={{marginTop: 4}}>{description}</p>
        </div>
        <div className="row-actions">
          <span className={`pill ${result.text ? 'warn' : 'bad'}`}>
            {result.text ? 'DRAFT READY' : 'DRAFT BLOCKED'}
          </span>
          {result.text ? <CopyDraftButton text={result.text} /> : null}
        </div>
      </div>

      {result.gaps.length ? (
        <div className="row-actions" style={{marginBottom: 10}}>
          {result.gaps.map((gap) => <span key={gap} className="pill bad">{gap}</span>)}
        </div>
      ) : null}

      {result.text ? (
        <pre
          aria-label={title}
          style={{
            whiteSpace: 'pre-wrap',
            overflowWrap: 'anywhere',
            background: 'var(--muted, #f6f8fa)',
            border: '1px solid var(--border, #dbe3eb)',
            borderRadius: 8,
            padding: 12,
            fontSize: 13,
            lineHeight: 1.45,
          }}
        >
          {result.text}
        </pre>
      ) : (
        <p className="muted">No draft is rendered while a required order field is missing.</p>
      )}

      <ul className="muted" style={{fontSize: 12, marginBottom: 0}}>
        {result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
      </ul>
      <p className="muted" style={{fontSize: 12, marginTop: 8, marginBottom: 0}}>
        Delivery mode: <code>{result.delivery}</code>. This platform does not send the draft
        to WhatsApp; an authorized Admin copies it, fills the escort reply and sends it from the
        existing WhatsApp client. No outbound transport is enabled.
      </p>
    </section>
  );
}
