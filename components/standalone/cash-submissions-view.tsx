import Link from 'next/link';
import {rows} from '@/lib/standalone/db';
import {pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';

type SubmissionRow = {
  id: string;
  state: string;
  category: string | null;
  submitted_by: string;
  display_name: string | null;
  created_at: string;
  instruction_id: string | null;
  source_message_id: string | null;
  source_chat_jid: string | null;
};

export async function CashSubmissionsView({title = 'Cash Submissions & Review'}: {title?: string}) {
  const user = await pageUser();
  const canReview = can(user as never, 'cash.review');
  const submissions = await rows<SubmissionRow>(
    `SELECT s.id, s.state, s.category, s.submitted_by, u.display_name, s.created_at,
            s.instruction_id, s.source_message_id, s.source_chat_jid
       FROM cash_submissions s
       LEFT JOIN cash_portal_users u ON u.id = s.submitted_by
      ORDER BY s.created_at DESC LIMIT 300`,
  );
  const pending = submissions.filter((submission) => submission.state === 'PENDING_REVIEW').length;

  return (
    <>
      <div className="page-head">
        <div><h1>{title}</h1><p className="muted">Staff submissions and router review candidates. Approval creates a REVIEW instruction; it does not post funds.</p></div>
        <div className="row-actions"><span className="pill warn">{pending} pending</span><Link href="/cash">Cash control →</Link></div>
      </div>

      <section className="card">
        <h3>Submissions ({submissions.length})</h3>
        <table>
          <thead><tr><th>Submitted by</th><th>State</th><th>Category</th><th>Source message</th><th>Instruction</th><th>Created</th><th>Actions</th></tr></thead>
          <tbody>
            {submissions.map((submission) => (
              <tr key={submission.id}>
                <td>{submission.display_name ?? submission.submitted_by.slice(0, 12)}</td>
                <td><span className={`pill ${submission.state === 'APPROVED' ? 'ok' : submission.state === 'REJECTED' ? 'bad' : 'warn'}`}>{submission.state}</span></td>
                <td>{submission.category ?? '—'}</td>
                <td style={{maxWidth: 260}}>
                  {submission.source_message_id ? (
                    <Link href={`/messages?q=${encodeURIComponent(submission.source_message_id)}`} style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      {submission.source_message_id}
                    </Link>
                  ) : <span className="muted">—</span>}
                  {submission.source_chat_jid ? <div className="muted" style={{fontSize: 10}}>{submission.source_chat_jid}</div> : null}
                </td>
                <td>{submission.instruction_id ? <Link href={`/cash/${submission.instruction_id}`}>{submission.instruction_id}</Link> : <span className="muted">—</span>}</td>
                <td style={{whiteSpace: 'nowrap'}}>{when(submission.created_at)}</td>
                <td>
                  {submission.state === 'PENDING_REVIEW' && canReview ? (
                    <div className="row-actions">
                      <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Approve candidate" hidden={{id: submission.id, kind: 'cash_submission', decision: 'APPROVED'}} fields={[]} />
                      <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Reject candidate" hidden={{id: submission.id, kind: 'cash_submission', decision: 'REJECTED'}} fields={[{name: 'reason', label: 'Reason', required: true}]} />
                    </div>
                  ) : <Link href="/review?domain=CASH">Open review</Link>}
                </td>
              </tr>
            ))}
            {!submissions.length ? <tr><td colSpan={7} className="muted">No submissions or review candidates.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
