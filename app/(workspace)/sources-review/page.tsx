import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listCashReviewCandidates, listReviewQueue, reviewQueueCounts} from '@/lib/standalone/review';
import {ReviewFilters} from '@/components/standalone/review-filters';
import {reviewCategoryLabel, reviewCategoryTone, reviewStateLabel, reviewStateTone} from '@/lib/review-ui';

export const dynamic = 'force-dynamic';

export default async function SourcesReviewPage({searchParams}: {searchParams: Promise<{state?: string; domain?: string; category?: string; q?: string; mine?: string}>}) {
  const user = await pageUser();
  const params = await searchParams;
  const state = params.state ?? 'PENDING';
  const domain = params.domain ?? 'ALL';
  const category = params.category ?? 'ALL';
  const q = params.q ?? '';
  const mine = params.mine === '1';
  const [items, cashCandidates, counts] = await Promise.all([
    listReviewQueue({state, domain, category, q, mine, actor: user as never}),
    domain === 'ALL' || domain === 'CASH'
      ? listCashReviewCandidates({state: state === 'PENDING' ? 'PENDING_REVIEW' : state, q, mine, actor: user as never})
      : Promise.resolve([]),
    reviewQueueCounts(),
  ]);
  return (
    <>
      <div className="page-head">
        <div><h1>Sources &amp; Review</h1><p className="muted">Router review items and Cash candidates with source evidence and role-checked decisions.</p></div>
        <div className="row-actions">
          <span className="pill warn">{counts.pending} review</span>
          <span className="pill warn">{counts.cashPending} cash</span>
        </div>
      </div>
      <ReviewFilters state={state} domain={domain} category={category} q={q} mine={mine} />
      <section className="card">
        <h3>Review items ({items.length})</h3>
        <table>
          <thead><tr><th>Item</th><th>Domain</th><th>Category</th><th>State</th><th>Target / source</th><th>Submitter</th><th>Created</th><th /></tr></thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id}>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</td>
                <td>{item.domain}</td>
                <td><span className={`pill ${reviewCategoryTone(item.category)}`}>{reviewCategoryLabel(item.category)}</span></td>
                <td><span className={`pill ${reviewStateTone(item.state)}`}>{reviewStateLabel(item.state)}</span></td>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.target_ref ?? '—'}</td>
                <td>{item.submitter_name ?? item.submitted_by.slice(0, 12)}</td>
                <td style={{whiteSpace: 'nowrap'}}>{when(item.created_at)}</td>
                <td><Link href={`/review/${item.id}`}>Inspect →</Link></td>
              </tr>
            ))}
            {!items.length ? <tr><td colSpan={8} className="muted">No review items for this filter.</td></tr> : null}
          </tbody>
        </table>
      </section>
      <section className="card">
        <h3>Cash candidates ({cashCandidates.length})</h3>
        <table>
          <thead><tr><th>Source message</th><th>Category</th><th>State</th><th>Submitter</th><th>Created</th><th /></tr></thead>
          <tbody>
            {cashCandidates.map((candidate) => (
              <tr key={candidate.id}>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{candidate.source_message_id ?? candidate.id}</td>
                <td>{candidate.category ?? '—'}</td>
                <td><span className="pill warn">{candidate.state}</span></td>
                <td>{candidate.submitter_name ?? candidate.submitted_by.slice(0, 12)}</td>
                <td style={{whiteSpace: 'nowrap'}}>{when(candidate.created_at)}</td>
                <td><Link href="/cash/submissions">Open Cash submissions →</Link></td>
              </tr>
            ))}
            {!cashCandidates.length ? <tr><td colSpan={6} className="muted">No cash candidates for this filter.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
