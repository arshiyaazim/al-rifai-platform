import {pageUser} from '@/lib/standalone/session';
import {listCashReviewCandidates, listReviewQueue, reviewQueueCounts} from '@/lib/standalone/review';
import {ReviewFilters} from '@/components/standalone/review-filters';
import {ActionForm} from '@/components/standalone/action-form';
import {ReviewQueueTables} from '@/components/standalone/review-queue-tables';
import {MessageReviewActions} from '@/components/standalone/message-review-actions';
import {listMessageReviewQueue} from '@/lib/standalone/message-review-queue';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  state?: string;
  domain?: string;
  category?: string;
  q?: string;
  mine?: string;
}>;

export default async function ReviewQueuePage({searchParams}: {searchParams: SearchParams}) {
  const user = await pageUser();
  const params = await searchParams;
  const state = params.state ?? 'PENDING';
  const domain = params.domain ?? 'ALL';
  const category = params.category ?? 'ALL';
  const q = params.q ?? '';
  const mine = params.mine === '1';

  const [rows, cashCandidates, counts, vesselQueue] = await Promise.all([
    listReviewQueue({state, domain, category, q, mine, actor: user as never}),
    domain === 'ALL' || domain === 'CASH'
      ? listCashReviewCandidates({state: state === 'PENDING' ? 'PENDING_REVIEW' : state, q, mine, actor: user as never})
      : Promise.resolve([]),
    reviewQueueCounts(),
    listMessageReviewQueue({state: state === 'PENDING' ? 'PENDING' : state, limit: 100}),
  ]);

  return (
    <div className="wx-page">
      <div className="page-head">
        <div>
          <h1>Review Queue</h1>
          <p className="muted">
            Pending, resolved and rejected items from the WhatsApp router and staff submissions. Source evidence, extracted fields,
            review reasons and the append-only audit trail are shown for every item. Actions are role-checked again on the server.
          </p>
        </div>
        <div className="row-actions">
          <span className="pill warn">{counts.pending} review item(s) pending</span>
          <span className="pill warn">{counts.cashPending} cash candidate(s) pending</span>
          <RealtimeRefresher domain="REVIEW" label="Live queue" />
        </div>
      </div>

      <ReviewFilters state={state} domain={domain} category={category} q={q} mine={mine} />

      {user.role === 'ADMIN' ? (
        <div className="card form" style={{marginBottom: 18}}>
          <h3>Router checkpoint</h3>
          <p className="muted" style={{marginTop: -6}}>
            Reuses the existing authenticated <code>/api/whatsapp?action=route</code> endpoint. It only processes staged messages;
            it does not approve, post or settle anything. Review items are created for errors and ambiguity.
          </p>
          <ActionForm
            endpoint="/api/whatsapp"
            action="route"
            submitLabel="Process pending messages"
            fields={[{name: 'limit', label: 'Batch limit', type: 'number', defaultValue: '100'}]}
          />
        </div>
      ) : null}

      <ReviewQueueTables
        canBulkReject={user.role === 'ADMIN'}
        rows={rows.map((item) => ({
          id: item.id,
          domain: item.domain,
          category: item.category,
          state: item.state,
          target_ref: item.target_ref,
          submitter_name: item.submitter_name,
          submitted_by: item.submitted_by,
          created_at: item.created_at,
        }))}
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

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Vessel Queue ({vesselQueue.length} pending)</h3></div>
          <span className="muted">Raw messages from the Phase 2 message_review_queue: confirmations, release gaps and client issues.</span>
        </div>
        {vesselQueue.length ? (
          <div style={{overflowX: 'auto'}}>
            <table>
              <thead><tr><th>Source</th><th>Reason</th><th>Workflow</th><th>Message</th><th>Actions</th></tr></thead>
              <tbody>
                {vesselQueue.map((item) => (
                  <tr key={item.id}>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      {item.sender_display_name ?? item.sender_jid}<br />
                      <span className="muted">{item.source_chat_jid}</span>
                    </td>
                    <td><span className="pill warn">{item.confusion_reason}</span></td>
                    <td>{item.suggested_workflow ?? '—'}</td>
                    <td style={{maxWidth: 420, whiteSpace: 'pre-wrap'}}>{item.message_text.slice(0, 500)}</td>
                    <td><MessageReviewActions id={item.id} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="muted">No vessel queue items are pending.</p>}
      </section>

      <section className="card">
        <h3>How this queue works</h3>
        <ul style={{marginTop: 0, paddingLeft: 18, fontSize: 13, lineHeight: 1.6}}>
          <li><strong>Pending</strong> items await a reviewer. <strong>Resolved</strong> includes approved and withdrawn items. <strong>Rejected</strong> items are final and audited.</li>
          <li>Domain and category filters narrow the queue without hiding unrelated legitimate issues.</li>
          <li>Cash candidates live in <code>cash_submissions</code>; program/employee/attendance reviews live in <code>review_items</code>. Both are shown here with their own state machines.</li>
          <li>Reviewers can inspect source evidence and correct supported fields. Corrections never approve, post or settle.</li>
          <li>Only ADMIN can decide; a reviewer can never decide their own submission. The server enforces this, not the button visibility.</li>
        </ul>
      </section>
    </div>
  );
}
