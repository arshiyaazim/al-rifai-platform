import {pageUser} from '@/lib/standalone/session';
import {listCashReviewCandidates, reviewQueueCounts} from '@/lib/standalone/review';
import {listUnifiedVesselReview} from '@/lib/standalone/vessel-review';
import {ReviewQueueTables} from '@/components/standalone/review-queue-tables';
import {ReviewQueueClient} from '@/components/standalone/review-queue-client';
import {ActionForm} from '@/components/standalone/action-form';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{state?: string}>;

export default async function ReviewQueuePage({searchParams}: {searchParams: SearchParams}) {
  const user = await pageUser();
  await searchParams;

  const [rows, cashCandidates, counts] = await Promise.all([
    listUnifiedVesselReview(300),
    listCashReviewCandidates({state: 'PENDING_REVIEW', actor: user as never}),
    reviewQueueCounts(),
  ]);
  const messageCount = rows.filter((row) => row.kind === 'message').length;

  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Review Queue</h1>
          <p className="muted">
            Human-readable WhatsApp evidence. No internal review/program/message identifier is used as the label.
            Approve writes the program; Decline and Ignore close the item; Save Draft stores corrections without deciding.
          </p>
        </div>
        <div className="row-actions">
          <span className="pill warn">{rows.length} vessel item(s)</span>
          <span className="pill warn">{messageCount} raw message(s)</span>
          <span className="pill warn">{counts.cashPending} cash candidate(s)</span>
          <RealtimeRefresher domain="REVIEW" label="Live queue" />
        </div>
      </div>

      {user.role === 'ADMIN' ? (
        <details className="card" style={{marginBottom: 16, padding: 12}}>
          <summary style={{cursor: 'pointer', fontWeight: 600}}>Router checkpoint</summary>
          <p className="muted" style={{marginTop: 6}}>
            Processes staged WhatsApp messages. It never approves or settles anything.
          </p>
          <ActionForm
            endpoint="/api/whatsapp"
            action="route"
            submitLabel="Process pending messages"
            fields={[{name: 'limit', label: 'Batch limit', type: 'number', defaultValue: '100'}]}
          />
        </details>
      ) : null}

      <section className="card" style={{marginBottom: 18, padding: 14}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3 style={{margin: 0}}>Vessel / message review</h3></div>
          <span className="muted">Sender · chat type · Bengali problem · full message · correction fields</span>
        </div>
        <ReviewQueueClient rows={rows} />
      </section>

      <section className="card" style={{marginBottom: 18, padding: 14}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3 style={{margin: 0}}>Cash review candidates</h3></div>
          <span className="muted">Cash queue is unchanged (v1.12.0); shown here for a single review surface.</span>
        </div>
        <ReviewQueueTables
          rows={[]}
          cashCandidates={cashCandidates.map((candidate) => ({
            id: candidate.id,
            category: candidate.category,
            state: candidate.state,
            submitter_name: candidate.submitter_name,
            submitted_by: candidate.submitted_by,
            created_at: candidate.created_at,
            source_message_id: candidate.source_message_id,
            payload: candidate.payload,
          }))}
        />
      </section>

      <section className="card">
        <h3>How this queue works</h3>
        <ul style={{marginTop: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6}}>
          <li><strong>Approve</strong> creates or updates the program, assigns/auto-creates the escort and marks the item resolved.</li>
          <li><strong>Decline</strong> is final and audited. <strong>Ignore</strong> keeps the evidence but removes it from the queue.</li>
          <li><strong>Save Draft</strong> stores the correction fields and leaves the item pending for a later decision.</li>
          <li>Dates and shifts are edited in Dhaka local time; the server re-checks authority and state.</li>
        </ul>
      </section>
    </div>
  );
}
