import Link from 'next/link';
import {cleanEmployeeName} from '@/lib/display-name';
import {ReviewActionsPanel} from '@/components/standalone/review-actions';
import {SourceEvidencePanel} from '@/components/standalone/source-evidence';
import {AuditHistory} from '@/components/standalone/audit-history';
import {OwnerDraftPanel} from '@/components/standalone/owner-draft-panel';
import {ownerDraftFromReviewPayload} from '@/lib/order-draft-from-record';
import type {ReviewDetail} from '@/lib/standalone/review';
import {
  formatReviewAmount,
  formatReviewTimestamp,
  reviewActionsFor,
  reviewCategoryLabel,
  reviewCategoryTone,
  reviewConfirmationEvidence,
  reviewDomainLabel,
  reviewEscortConflict,
  reviewExtractedFieldValues,
  reviewExtractedFields,
  reviewMissingFields,
  reviewReasons,
  reviewSourceEvidence,
  reviewStateLabel,
  reviewStateTone,
  reviewVesselNames,
  type ReviewActor,
} from '@/lib/review-ui';

type Props = {
  detail: ReviewDetail;
  actor: ReviewActor;
};

type NormalizedItem = {
  id: string;
  domain: string;
  category: string | null;
  action: string;
  target_ref: string | null;
  payload: Record<string, unknown>;
  state: string;
  submitted_by: string;
  submitter_name: string | null;
  created_at: string;
  decided_at: string | null;
  decision: string | null;
  decision_reason: string | null;
};

function normalize(detail: ReviewDetail): NormalizedItem {
  if (detail.kind === 'review_item') {
    const item = detail.item as NormalizedItem;
    return {
      ...item,
      payload: item.payload ?? {},
      submitter_name: detail.submitter_name,
      decision: detail.decision?.decision ?? item.decision ?? null,
      decision_reason: detail.decision?.reason ?? item.decision_reason ?? null,
    };
  }
  const item = detail.item as Record<string, unknown>;
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  return {
    id: String(item.id),
    domain: 'CASH',
    category: (payload.category as string) ?? (item.category as string) ?? null,
    action: 'CREATE',
    target_ref: (item.source_message_id as string) ?? (payload.sourceMessageId as string) ?? null,
    payload,
    state: String(item.state),
    submitted_by: String(item.submitted_by),
    submitter_name: detail.submitter_name,
    created_at: String(item.created_at),
    decided_at: (item.decision_at as string) ?? null,
    decision: (item.decision as string) ?? detail.decision?.decision ?? null,
    decision_reason: (item.decision_reason as string) ?? detail.decision?.reason ?? null,
  };
}

function RelatedProgram({program}: {program: Record<string, unknown> | null}) {
  if (!program) return null;
  const confirmation = typeof program.confirmation_message_id === 'string' ? program.confirmation_message_id : null;
  return (
    <section className="card">
      <h3>Related vessel program</h3>
      <table>
        <tbody>
          <tr><th style={{width: 180}}>Program ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{String(program.id)}</td></tr>
          <tr><th>Mother → lighter</th><td>{String(program.mother_vessel ?? '—')} → {String(program.lighter_vessel ?? '—')}</td></tr>
          <tr><th>State</th><td><span className="pill">{String(program.state ?? '—')}</span></td></tr>
          <tr><th>Escort</th><td>{String(program.escort_name ?? '—')}<div className="muted">{String(program.escort_mobile ?? '')}</div></td></tr>
          <tr><th>Start</th><td>{String(program.start_date ?? '—')} · {String(program.start_shift ?? '—')}</td></tr>
          <tr><th>End</th><td>{program.end_date ? `${String(program.end_date)} · ${String(program.end_shift ?? '—')}` : '—'}</td></tr>
          <tr><th>Source message</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{String(program.source_message_id ?? '—')}</td></tr>
          <tr><th>Confirmation message</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{confirmation ?? '—'}</td></tr>
        </tbody>
      </table>
      <p className="muted">Confirmation is applied from the admin&apos;s outgoing WhatsApp reply via applyConfirmation(); no second confirmation is required.</p>
    </section>
  );
}

function RelatedInstruction({instruction}: {instruction: Record<string, unknown> | null}) {
  if (!instruction) return null;
  return (
    <section className="card">
      <h3>Related cash instruction</h3>
      <table>
        <tbody>
          <tr><th style={{width: 180}}>Instruction ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{String(instruction.id)}</td></tr>
          <tr><th>Payee</th><td>{cleanEmployeeName(instruction.employee_name)}<div className="muted">{String(instruction.employee_mobile ?? '')}</div></td></tr>
          <tr><th>Method</th><td>{String(instruction.method ?? '—')}</td></tr>
          <tr><th>Amount</th><td>{formatReviewAmount(instruction.amount_minor as string | number | null)}</td></tr>
          <tr><th>State</th><td><span className="pill">{String(instruction.state ?? '—')}</span></td></tr>
          <tr><th>Source message</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{String(instruction.source_message_id ?? '—')}</td></tr>
          <tr><th>Source block key</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{String(instruction.source_block_key ?? '—')}</td></tr>
        </tbody>
      </table>
      <p className="muted">The instruction remains in REVIEW until an authorized admin approves and posts it through the existing Cash workflow.</p>
    </section>
  );
}

/**
 * Full Review Queue detail. Works for both review_items and cash_submissions.
 * All actions are projected from the same server-side authorization rule used
 * by the API; no action here posts, settles or confirms anything by itself.
 */
export function ReviewItemDetail({detail, actor}: Props) {
  const item = normalize(detail);
  const actions = reviewActionsFor(actor, item);
  const source = reviewSourceEvidence({
    payload: item.payload,
    sourceMessageId: detail.kind === 'cash_submission' ? (detail.item as Record<string, unknown>).source_message_id as string | null : null,
    sourceChatJid: detail.kind === 'cash_submission' ? (detail.item as Record<string, unknown>).source_chat_jid as string | null : null,
    sourceAccountId: detail.kind === 'cash_submission' ? (detail.item as Record<string, unknown>).source_account_id as string | null : null,
  });
  const fields = reviewExtractedFields({domain: item.domain, payload: item.payload});
  const missing = reviewMissingFields({payload: item.payload});
  const reasons = reviewReasons({payload: item.payload, decisionReason: item.decision_reason});
  const names = reviewVesselNames({payload: item.payload});
  const confirmation = reviewConfirmationEvidence({
    payload: item.payload,
    confirmationMessageId: detail.relatedProgram && typeof detail.relatedProgram.confirmation_message_id === 'string'
      ? detail.relatedProgram.confirmation_message_id
      : null,
  });
  const escortConflict = reviewEscortConflict({payload: item.payload});
  const values = reviewExtractedFieldValues({payload: item.payload});
  const kind = detail.kind;

  return (
    <div className="wx-page">
      <div className="page-head">
        <div>
          <div className="muted" style={{fontSize: 12}}>
            <Link href="/review">← Review Queue</Link>
          </div>
          <h1>{reviewDomainLabel(item.domain)} review · {item.id.slice(0, 18)}</h1>
          <p className="muted">
            {reviewCategoryLabel(item.category)} · {reviewStateLabel(item.state)} · submitted by {item.submitter_name ?? item.submitted_by.slice(0, 12)}
          </p>
        </div>
        <div className="row-actions">
          <span className={`pill ${reviewStateTone(item.state)}`}>{reviewStateLabel(item.state)}</span>
          <span className={`pill ${reviewCategoryTone(item.category)}`}>{reviewCategoryLabel(item.category)}</span>
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Item ID</div><div className="value" style={{fontSize: 13, fontFamily: 'ui-monospace, monospace', wordBreak: 'break-all'}}>{item.id}</div></div>
        <div className="stat"><div className="label">Domain / action</div><div className="value" style={{fontSize: 14}}>{reviewDomainLabel(item.domain)} · {item.action}</div></div>
        <div className="stat"><div className="label">Created</div><div className="value" style={{fontSize: 14}}>{formatReviewTimestamp(item.created_at)}</div></div>
        <div className="stat"><div className="label">Decided</div><div className="value" style={{fontSize: 14}}>{item.decided_at ? formatReviewTimestamp(item.decided_at) : '—'}</div></div>
      </div>

      <div className="split">
        <div>
          <SourceEvidencePanel evidence={source} sourceMessages={detail.sourceMessages} programSources={detail.programSources} />

          <section className="card">
            <h3>Extracted fields</h3>
            {!fields.length ? <p className="muted">No extracted fields were recorded for this item.</p> : (
              <table>
                <thead><tr><th>Field</th><th>Value</th></tr></thead>
                <tbody>
                  {fields.map((field) => (
                    <tr key={field.label}><td style={{width: 220}}>{field.label}</td><td style={{wordBreak: 'break-word'}}>{field.value}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {item.domain === 'PROGRAM' ? (
            <OwnerDraftPanel
              result={ownerDraftFromReviewPayload(item.payload)}
              title="Owner order draft"
              description="Exact layout the Admin copies into the client reply. Blank escort fields are intentional."
            />
          ) : null}

          {item.domain === 'PROGRAM' && (names.original.length || names.normalized.length) ? (
            <section className="card">
              <h3>Vessel name normalization</h3>
              <table>
                <tbody>
                  <tr><th style={{width: 180}}>Original</th><td>{names.original.length ? names.original.join(' · ') : '—'}</td></tr>
                  <tr><th>Normalized</th><td>{names.normalized.length ? names.normalized.join(' · ') : '—'}</td></tr>
                </tbody>
              </table>
            </section>
          ) : null}

          <section className="card">
            <h3>Missing / conflicting fields</h3>
            {!missing.length ? <p className="muted">No missing or conflicting fields were recorded.</p> : (
              <div className="row-actions">
                {missing.map((field) => <span key={field} className="pill warn">{field}</span>)}
              </div>
            )}
          </section>

          <section className="card">
            <h3>Review reasons</h3>
            {!reasons.length ? <p className="muted">No review reason was recorded.</p> : (
              <table>
                <tbody>
                  {reasons.map((reason) => (
                    <tr key={`${reason.label}-${reason.value}`}><td style={{width: 180}}>{reason.label}</td><td>{reason.value}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {item.domain === 'PROGRAM' ? (
            <section className="card">
              <h3>Confirmation evidence</h3>
              <table>
                <tbody>
                  <tr><th style={{width: 220}}>confirmation_message_id</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{confirmation.messageId ?? '—'}</td></tr>
                </tbody>
              </table>
              {confirmation.href ? <p><Link href={confirmation.href}>Open confirmation message in the WhatsApp inbox →</Link></p> : null}
              {escortConflict ? <p><span className="pill bad">Escort assignment conflict</span> {escortConflict}</p> : null}
              <p className="muted">Confirmation is applied from the admin&apos;s outgoing WhatsApp reply via applyConfirmation(); no second confirmation is required.</p>
            </section>
          ) : null}

          <RelatedProgram program={detail.relatedProgram} />
          <RelatedInstruction instruction={detail.relatedInstruction} />
          <AuditHistory events={detail.audit} />
        </div>

        <div>
          <ReviewActionsPanel
            id={item.id}
            kind={kind}
            domain={item.domain}
            state={item.state}
            actions={actions}
            values={values}
          />
          <section className="card">
            <h3>Decision</h3>
            <table>
              <tbody>
                <tr><th style={{width: 140}}>Decision</th><td>{item.decision ? <span className={`pill ${reviewStateTone(item.decision)}`}>{reviewStateLabel(item.decision)}</span> : <span className="muted">Pending</span>}</td></tr>
                <tr><th>Reason</th><td>{item.decision_reason ?? '—'}</td></tr>
                <tr><th>Decided by</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 12}}>{detail.decision?.actor ?? '—'}</td></tr>
                <tr><th>Decided at</th><td>{detail.decision?.created_at ? formatReviewTimestamp(detail.decision.created_at) : '—'}</td></tr>
              </tbody>
            </table>
          </section>
          <section className="card">
            <h3>Boundary</h3>
            <p className="muted">
              This screen never approves, posts or settles funds by itself. Approving a review item applies the existing domain service
              (for example createProgram or decideCashSubmission); posting a cash instruction remains a separate, explicit admin action
              in the Cash workflow. Cash Freeze and permission boundaries are unchanged.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
