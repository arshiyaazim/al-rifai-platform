import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getInstructionDetail} from '@/lib/standalone/finance';
import {DomainError} from '@/lib/standalone/db';
import {money, when} from '@/lib/standalone/session';

export const dynamic = 'force-dynamic';

export default async function CashInstructionPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  let detail;
  try {
    detail = await getInstructionDetail(decodeURIComponent(id));
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }
  const instruction = detail.instruction as unknown as {
    id: string; employee_name: string; employee_mobile: string | null; payout_mobile: string | null;
    method: string; amount_minor: string; purpose: string | null; state: string;
    source_channel: string; source_message_id: string | null; source_block_key: string | null;
    account_code: string | null; account_name: string | null;
    created_by: string; created_at: string; approved_at: string | null; approved_by: string | null;
    posted_at: string | null; posted_by: string | null; rejected_at: string | null;
    reject_reason: string | null; reversed_at: string | null; reversed_by: string | null;
    reversal_reason: string | null;
  };
  const posting = detail.posting as unknown as {id: string; posted_at: string; posted_by: string; ledger_entry_id: string | null} | null;
  const reversal = detail.reversal as unknown as {id: string; reversed_at: string; reversed_by: string; reason: string; ledger_entry_id: string} | null;
  const ledger = detail.ledger as unknown as Array<{id: string; entry_date: string; direction: string; amount_minor: string; category: string; source: string; created_by: string}>;
  const audit = detail.audit as unknown as Array<{id: string; at: string; actor: string; actor_role: string | null; action: string; detail: Record<string, unknown>; source: string; source_ref: string | null}>;
  const candidates = detail.candidates as unknown as Array<{id: string; state: string; created_at: string; decided_at: string | null; decided_by: string | null; decision_reason: string | null}>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cash instruction</h1>
          <p className="muted" style={{fontFamily: 'ui-monospace, monospace'}}>{instruction.id}</p>
        </div>
        <div className="row-actions">
          <Link href="/cash">← Back to Cash</Link>
          {instruction.source_message_id ? (
            <Link href={`/messages?q=${encodeURIComponent(instruction.source_message_id)}`}>Source message →</Link>
          ) : null}
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Amount</div><div className="value">{money(instruction.amount_minor)}</div></div>
        <div className="stat"><div className="label">State</div><div className="value">{instruction.state}</div></div>
        <div className="stat"><div className="label">Method</div><div className="value">{instruction.method}</div></div>
        <div className="stat"><div className="label">Account</div><div className="value">{instruction.account_code ?? '—'}</div></div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Instruction</h3>
          <table>
            <tbody>
              <tr><th>Payee</th><td>{instruction.employee_name}</td></tr>
              <tr><th>Employee mobile</th><td>{instruction.employee_mobile ?? '—'}</td></tr>
              <tr><th>Payout mobile</th><td>{instruction.payout_mobile ?? '—'}</td></tr>
              <tr><th>Purpose</th><td>{instruction.purpose ?? '—'}</td></tr>
              <tr><th>Account</th><td>{instruction.account_name ?? instruction.account_code ?? '—'}</td></tr>
              <tr><th>Created</th><td>{when(instruction.created_at)} · {instruction.created_by.slice(0, 12)}</td></tr>
              <tr><th>Approved</th><td>{instruction.approved_at ? `${when(instruction.approved_at)} · ${instruction.approved_by?.slice(0, 12)}` : '—'}</td></tr>
              <tr><th>Posted</th><td>{instruction.posted_at ? `${when(instruction.posted_at)} · ${instruction.posted_by?.slice(0, 12)}` : '—'}</td></tr>
              <tr><th>Rejected</th><td>{instruction.rejected_at ? `${when(instruction.rejected_at)} · ${instruction.reject_reason ?? ''}` : '—'}</td></tr>
              <tr><th>Reversed</th><td>{instruction.reversed_at ? `${when(instruction.reversed_at)} · ${instruction.reversal_reason ?? ''}` : '—'}</td></tr>
              <tr><th>Source</th><td>{instruction.source_channel}{instruction.source_message_id ? ` · ${instruction.source_message_id}` : ''}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Posting &amp; reversal</h3>
          <table>
            <tbody>
              <tr><th>Posting</th><td>{posting ? `${posting.id} · ${when(posting.posted_at)}` : '—'}</td></tr>
              <tr><th>Posting ledger entry</th><td>{posting?.ledger_entry_id ?? '—'}</td></tr>
              <tr><th>Reversal</th><td>{reversal ? `${reversal.id} · ${when(reversal.reversed_at)}` : '—'}</td></tr>
              <tr><th>Reversal reason</th><td>{reversal?.reason ?? '—'}</td></tr>
              <tr><th>Reversal ledger entry</th><td>{reversal?.ledger_entry_id ?? '—'}</td></tr>
            </tbody>
          </table>
          <p className="muted">Postings and ledger entries are immutable. A reversal adds a contra CREDIT entry; it never edits the original posting.</p>
        </section>
      </div>

      <section className="card">
        <h3>Ledger entries ({ledger.length})</h3>
        <table>
          <thead><tr><th>Date</th><th>Direction</th><th>Amount</th><th>Category</th><th>Source</th><th>By</th></tr></thead>
          <tbody>
            {ledger.map((entry) => (
              <tr key={entry.id}>
                <td>{entry.entry_date}</td>
                <td><span className={`pill ${entry.direction === 'CREDIT' ? 'ok' : 'warn'}`}>{entry.direction}</span></td>
                <td>{money(entry.amount_minor)}</td>
                <td>{entry.category}</td>
                <td>{entry.source}</td>
                <td className="muted">{entry.created_by.slice(0, 12)}</td>
              </tr>
            ))}
            {!ledger.length ? <tr><td colSpan={6} className="muted">No ledger entries.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <div className="split">
        <section className="card">
          <h3>Review candidates ({candidates.length})</h3>
          <table>
            <thead><tr><th>Candidate</th><th>State</th><th>Decided</th><th>Reason</th></tr></thead>
            <tbody>
              {candidates.map((candidate) => (
                <tr key={candidate.id}>
                  <td><Link href={`/review/${candidate.id}`}>{candidate.id}</Link></td>
                  <td>{candidate.state}</td>
                  <td>{candidate.decided_at ? when(candidate.decided_at) : '—'}</td>
                  <td>{candidate.decision_reason ?? '—'}</td>
                </tr>
              ))}
              {!candidates.length ? <tr><td colSpan={4} className="muted">No review candidate linked.</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Audit history ({audit.length})</h3>
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Detail</th></tr></thead>
            <tbody>
              {audit.map((entry) => (
                <tr key={entry.id}>
                  <td style={{whiteSpace: 'nowrap'}}>{when(entry.at)}</td>
                  <td>{entry.action}</td>
                  <td className="muted">{entry.actor.slice(0, 12)} · {entry.actor_role ?? '—'}</td>
                  <td style={{maxWidth: 360, wordBreak: 'break-word'}}><code style={{fontSize: 11}}>{JSON.stringify(entry.detail)}</code></td>
                </tr>
              ))}
              {!audit.length ? <tr><td colSpan={4} className="muted">No audit history.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
