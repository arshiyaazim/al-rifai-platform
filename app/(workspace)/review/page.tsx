import Link from 'next/link';
import {pageUser} from '@/lib/standalone/session';
import {listCashReviewCandidates, listReviewQueue, reviewQueueCounts} from '@/lib/standalone/review';
import {ReviewFilters} from '@/components/standalone/review-filters';
import {ActionForm} from '@/components/standalone/action-form';
import {
  formatReviewAmount,
  formatReviewTimestamp,
  reviewCategoryLabel,
  reviewCategoryTone,
  reviewDomainLabel,
  reviewStateLabel,
  reviewStateTone,
} from '@/lib/review-ui';

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

  const [rows, cashCandidates, counts] = await Promise.all([
    listReviewQueue({state, domain, category, q, mine, actor: user as never}),
    domain === 'ALL' || domain === 'CASH'
      ? listCashReviewCandidates({state: state === 'PENDING' ? 'PENDING_REVIEW' : state, q, mine, actor: user as never})
      : Promise.resolve([]),
    reviewQueueCounts(),
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

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Cash review candidates ({cashCandidates.length})</h3></div>
          <span className="muted">Approving a candidate does not post or settle funds.</span>
        </div>
        {cashCandidates.length ? (
          <table>
            <thead>
              <tr><th>Candidate</th><th>Category</th><th>State</th><th>Submitter</th><th>Created</th><th>Source message</th><th>Parsed</th><th>Review</th></tr>
            </thead>
            <tbody>
              {cashCandidates.map((candidate) => {
                const payload = (candidate.payload ?? {}) as Record<string, unknown>;
                return (
                  <tr key={candidate.id}>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{candidate.id}</td>
                    <td><span className={`pill ${reviewCategoryTone(candidate.category)}`}>{reviewCategoryLabel(candidate.category)}</span></td>
                    <td><span className={`pill ${reviewStateTone(candidate.state)}`}>{reviewStateLabel(candidate.state)}</span></td>
                    <td>{candidate.submitter_name ?? candidate.submitted_by.slice(0, 12)}</td>
                    <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(candidate.created_at)}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      {candidate.source_message_id ? (
                        <Link href={`/messages?q=${encodeURIComponent(candidate.source_message_id)}`}>{candidate.source_message_id}</Link>
                      ) : <span className="muted">—</span>}
                    </td>
                    <td style={{maxWidth: 320}}>
                      <div>{String(payload.employeeName ?? payload.employee_name ?? '—')}</div>
                      <div className="muted">{formatReviewAmount(payload.amountMinor as string | number | null)} · {String(payload.method ?? '—')}</div>
                    </td>
                    <td><Link href={`/review/${candidate.id}`}>Inspect →</Link></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No cash review candidates match the current filters.</p>}
      </section>

      <section className="card">
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Review items ({rows.length})</h3></div>
          <span className="muted">Program, employee and attendance reviews.</span>
        </div>
        {rows.length ? (
          <table>
            <thead>
              <tr><th>Item</th><th>Domain</th><th>Category</th><th>State</th><th>Target</th><th>Submitter</th><th>Created</th><th>Review</th></tr>
            </thead>
            <tbody>
              {rows.map((item) => (
                <tr key={item.id}>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</td>
                  <td>{reviewDomainLabel(item.domain)}</td>
                  <td><span className={`pill ${reviewCategoryTone(item.category)}`}>{reviewCategoryLabel(item.category)}</span></td>
                  <td><span className={`pill ${reviewStateTone(item.state)}`}>{reviewStateLabel(item.state)}</span></td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.target_ref ?? '—'}</td>
                  <td>{item.submitter_name ?? item.submitted_by.slice(0, 12)}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(item.created_at)}</td>
                  <td><Link href={`/review/${item.id}`}>Inspect →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No review items match the current filters.</p>}
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
