import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {listPrograms} from '@/lib/standalone/programs';
import {listReviewQueue} from '@/lib/standalone/review';
import {
  OWNER_DRAFT_DELIVERY,
  ownerDraftFromProgram,
  ownerDraftFromReviewPayload,
} from '@/lib/order-draft-from-record';
import {OwnerDraftPanel} from '@/components/standalone/owner-draft-panel';

export const dynamic = 'force-dynamic';

/**
 * Admin order-draft workspace.
 *
 * This page is the missing bridge between an authorized WA-01 order and the
 * Admin's confirmation reply. It renders the exact Owner draft for every DRAFT
 * program and every unresolved PROGRAM review item. It is deliberately
 * read-only: no WhatsApp message is sent and no assignment is applied here.
 */
export default async function VesselDraftsPage() {
  const user = await pageUser();
  const canRead = can(user as never, 'vessel.read');

  const [draftPrograms, confirmedPrograms, programReviews] = await Promise.all([
    listPrograms({state: 'DRAFT', limit: 200}),
    listPrograms({state: 'CONFIRMED', limit: 100}),
    listReviewQueue({domain: 'PROGRAM', state: 'PENDING', limit: 200}),
  ]);

  const programDrafts = [...draftPrograms, ...confirmedPrograms]
    .map((program) => ({program, draft: ownerDraftFromProgram(program)}));
  const reviewDrafts = programReviews
    .map((item) => ({item, draft: ownerDraftFromReviewPayload(item.payload)}))
    .filter(({draft}) => !(draft.gaps.includes('MISSING_MOTHER_VESSEL')
      && draft.gaps.includes('MISSING_LIGHTER_VESSEL')));
  const unparsedReviews = programReviews.length - reviewDrafts.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vessel Order Drafts</h1>
          <p className="muted">
            Authorized WA-01 order → extracted fields → Owner draft → Admin assignment → confirmation → Vessel Program.
          </p>
        </div>
        <div className="row-actions">
          <Link href="/vessel">Vessel Register →</Link>
          <Link href="/review?domain=PROGRAM">Program review queue →</Link>
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat">
          <div className="label">Draft programs</div>
          <div className="value">{draftPrograms.length}</div>
          <div className="muted">state DRAFT</div>
        </div>
        <div className="stat">
          <div className="label">Awaiting confirmation</div>
          <div className="value">{confirmedPrograms.length}</div>
          <div className="muted">state CONFIRMED</div>
        </div>
        <div className="stat">
          <div className="label">Program reviews</div>
          <div className="value">{programReviews.length}</div>
          <div className="muted">{unparsedReviews} without vessel fields</div>
        </div>
        <div className="stat">
          <div className="label">Delivery</div>
          <div className="value" style={{fontSize: 15}}>{OWNER_DRAFT_DELIVERY}</div>
          <div className="muted">no outbound sender</div>
        </div>
      </div>

      {!canRead ? (
        <section className="card">
          <h3>Read permission required</h3>
          <p className="muted">This account cannot read vessel records. No draft data is shown.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h3>Why the draft may not reach WhatsApp</h3>
            <table>
              <tbody>
                <tr><th style={{width: 260}}>Router</th><td>Live WA-01 messages above the cutover rowid are processed; older messages stay historical by design.</td></tr>
                <tr><th>Draft creation</th><td>An authorized order creates a vessel Program in state <code>DRAFT</code>.</td></tr>
                <tr><th>Template</th><td>This page renders the exact Owner layout from the program or review record.</td></tr>
                <tr><th>Transport</th><td>No outbound WhatsApp sender is enabled, so the platform cannot deliver the draft. <strong>MANUAL_COPY_ONLY</strong>.</td></tr>
                <tr><th>Confirmation</th><td>The Admin&apos;s outgoing reply (escort name/mobile/date/shift) is still applied by <code>applyConfirmation()</code>.</td></tr>
              </tbody>
            </table>
          </section>

          <h2 style={{marginTop: 24}}>Draft programs ({programDrafts.length})</h2>
          {programDrafts.length ? programDrafts.map(({program, draft}) => (
            <div key={program.id}>
              <div className="row-actions" style={{marginBottom: 6}}>
                <span className="pill">{program.state}</span>
                <span className="muted">
                  {program.mother_vessel} → {program.lighter_vessel} · start {program.start_date} · {program.start_shift}
                </span>
                <Link href={`/vessel/${encodeURIComponent(program.id)}`}>Open program →</Link>
                {program.source_message_id ? <Link href={`/messages?q=${encodeURIComponent(program.source_message_id)}`}>Source message →</Link> : null}
              </div>
              <OwnerDraftPanel result={draft} title="Owner order draft" />
            </div>
          )) : <p className="muted">No DRAFT or CONFIRMED vessel programs are waiting for an Admin draft.</p>}

          <h2 style={{marginTop: 24}}>Unresolved order reviews ({reviewDrafts.length})</h2>
          {reviewDrafts.length ? reviewDrafts.map(({item, draft}) => (
            <div key={item.id}>
              <div className="row-actions" style={{marginBottom: 6}}>
                <span className="pill warn">{item.category ?? 'PROGRAM'}</span>
                <span className="muted">{item.id.slice(0, 18)} · {when(item.created_at)}</span>
                <Link href={`/review/${encodeURIComponent(item.id)}`}>Open review item →</Link>
              </div>
              <OwnerDraftPanel result={draft} title="Owner order draft (from review item)" />
            </div>
          )) : <p className="muted">No unresolved PROGRAM review item contains vessel fields.</p>}

          {unparsedReviews > 0 ? (
            <p className="muted">
              {unparsedReviews} PROGRAM review item(s) contain no Mother/Lighter vessel fields (release, food-bill or
              free-text messages). They stay in the Review Queue and are not turned into invented drafts.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
