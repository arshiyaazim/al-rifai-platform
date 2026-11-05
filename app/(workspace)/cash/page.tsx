import Link from 'next/link';
import {incomeExpense, listAccounts, listInstructions, listLedger} from '@/lib/standalone/finance';
import {listCashReviewCandidates} from '@/lib/standalone/review';
import {rows} from '@/lib/standalone/db';
import {money} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';
import {formatReviewAmount, formatReviewTimestamp, reviewCategoryLabel, reviewCategoryTone, reviewStateLabel, reviewStateTone} from '@/lib/review-ui';

export const dynamic = 'force-dynamic';

export default async function CashPage() {
  const today = new Date().toISOString().slice(0, 10);
  const [accounts, instructions, ledger, report, submissions, cashCandidates] = await Promise.all([
    listAccounts(), listInstructions({}), listLedger({limit: 60}),
    incomeExpense(`${today.slice(0, 8)}01`, today),
    rows<{id: string; state: string; submitted_by: string; created_at: string; display_name: string | null}>(
      'SELECT s.id, s.state, s.submitted_by, s.created_at, u.display_name FROM cash_submissions s LEFT JOIN cash_portal_users u ON u.id = s.submitted_by ORDER BY s.created_at DESC LIMIT 30',
    ),
    listCashReviewCandidates({state: 'PENDING_REVIEW', limit: 50}),
  ]);
  const pending = instructions.filter((instruction) => (instruction as {state: string}).state === 'REVIEW').slice(0, 20);

  return (
    <>
      <div className="page-head">
        <div><h1>Cash &amp; Accounts</h1><p className="muted">Instructions, approvals, postings and the ledger.</p></div>
        <div className="row-actions">
          <Link href="/review?domain=CASH">Open Cash review queue →</Link>
        </div>
      </div>

      <div className="grid-cards">
        {accounts.map((account) => (
          <div className="stat" key={account.id}>
            <div className="label">{account.code} · {account.type}</div>
            <div className="value">{money(account.balance_minor)}</div>
            <div className="muted">{account.name}</div>
          </div>
        ))}
        <div className="stat"><div className="label">Income ({report.from} → {report.to})</div><div className="value">{money(report.income)}</div></div>
        <div className="stat"><div className="label">Expense</div><div className="value">{money(report.expense)}</div></div>
        <div className="stat"><div className="label">Net</div><div className="value">{money(report.net)}</div></div>
      </div>

      <div className="split">
        <ActionForm
          title="New payment instruction"
          endpoint="/api/finance"
          action="instruction.create"
          submitLabel="Create (review)"
          fields={[
            {name: 'employeeName', label: 'Employee / payee name', required: true},
            {name: 'employeeMobile', label: 'Employee mobile', placeholder: '01712345678'},
            {name: 'payoutMobile', label: 'Payout number', placeholder: '017XXXXXXXX'},
            {name: 'method', label: 'Method', type: 'select', options: [
              {value: 'bkash', label: 'bKash'}, {value: 'nagad', label: 'Nagad'}, {value: 'rocket', label: 'Rocket'},
              {value: 'bank', label: 'Bank'}, {value: 'cash', label: 'Cash'}]},
            {name: 'amount', label: 'Amount (BDT)', required: true, placeholder: '1250.00'},
            {name: 'accountId', label: 'Pay from', type: 'select', options: accounts.map((account) => ({value: account.id, label: `${account.code} — ${account.name}`}))},
            {name: 'purpose', label: 'Purpose'},
          ]}
        />
        <ActionForm
          title="Record income / expense"
          endpoint="/api/finance"
          action="ledger.create"
          submitLabel="Post entry"
          fields={[
            {name: 'accountId', label: 'Account', type: 'select', required: true,
              options: accounts.map((account) => ({value: account.id, label: `${account.code} — ${account.name}`}))},
            {name: 'entryDate', label: 'Date', type: 'date', required: true, defaultValue: today},
            {name: 'direction', label: 'Direction', type: 'select', options: [
              {value: 'CREDIT', label: 'Income (credit)'}, {value: 'DEBIT', label: 'Expense (debit)'}]},
            {name: 'amount', label: 'Amount (BDT)', required: true},
            {name: 'category', label: 'Category', required: true, placeholder: 'office / fuel / salary'},
            {name: 'description', label: 'Description'},
          ]}
        />
      </div>

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Cash review candidates ({cashCandidates.length})</h3></div>
          <span className="muted">Reviewers can inspect source evidence and correct supported fields. Approving a candidate does not post or settle funds.</span>
        </div>
        {cashCandidates.length ? (
          <table>
            <thead><tr><th>Candidate</th><th>Category</th><th>State</th><th>Submitter</th><th>Created</th><th>Source message</th><th>Parsed</th><th>Review</th></tr></thead>
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
        ) : <p className="muted">No cash review candidates are pending.</p>}
      </section>

      <section className="card">
        <h3>Instructions ({instructions.length})</h3>
        <table>
          <thead><tr><th>Payee</th><th>Method</th><th>Amount</th><th>State</th><th>Source</th><th>Actions</th></tr></thead>
          <tbody>
            {instructions.slice(0, 40).map((instruction) => {
              const item = instruction as unknown as {
                id: string; employee_name: string; method: string; amount_minor: string; state: string;
                source_channel?: string | null; source_message_id?: string | null; source_block_key?: string | null;
              };
              return (
                <tr key={item.id}>
                  <td>{item.employee_name}</td>
                  <td>{item.method}</td>
                  <td>{money(item.amount_minor)}</td>
                  <td><span className={`pill ${item.state === 'POSTED' ? 'ok' : item.state === 'REJECTED' ? 'bad' : 'warn'}`}>{item.state}</span></td>
                  <td style={{maxWidth: 260}}>
                    <div className="muted" style={{fontSize: 11}}>{item.source_channel ?? 'WEB'}</div>
                    {item.source_message_id ? (
                      <Link href={`/messages?q=${encodeURIComponent(item.source_message_id)}`} style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                        {item.source_message_id}
                      </Link>
                    ) : <span className="muted">no source message</span>}
                    {item.source_block_key ? <div className="muted" style={{fontSize: 10}}>block {item.source_block_key}</div> : null}
                  </td>
                  <td>
                    {item.state === 'REVIEW' ? (
                      <div className="row-actions">
                        <ActionForm compact endpoint="/api/finance" action="instruction.approve" submitLabel="Approve" hidden={{id: item.id}} fields={[]} />
                        <ActionForm compact endpoint="/api/finance" action="instruction.reject" submitLabel="Reject" hidden={{id: item.id}} fields={[{name: 'reason', label: 'Reason', required: true}]} />
                      </div>
                    ) : item.state === 'APPROVED' ? (
                      <ActionForm compact endpoint="/api/finance" action="instruction.post" submitLabel="Post" hidden={{id: item.id}} fields={[]} />
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
            {!instructions.length ? <tr><td colSpan={6} className="muted">No instructions yet.</td></tr> : null}
          </tbody>
        </table>
        {pending.length ? <p className="muted">{pending.length} instruction(s) awaiting approval. Posting remains a separate explicit admin action.</p> : null}
      </section>

      <div className="split">
        <section className="card">
          <h3>Ledger</h3>
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Category</th><th>Amount</th></tr></thead>
            <tbody>
              {ledger.slice(0, 30).map((entry) => {
                const item = entry as unknown as {id: string; entry_date: string; account_code: string; category: string; direction: string; amount_minor: string};
                return (
                  <tr key={item.id}>
                    <td>{item.entry_date}</td><td>{item.account_code}</td><td>{item.category}</td>
                    <td>{item.direction === 'CREDIT' ? '+' : '−'}{money(item.amount_minor)}</td>
                  </tr>
                );
              })}
              {!ledger.length ? <tr><td colSpan={4} className="muted">No ledger entries.</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Staff submissions</h3>
          <ActionForm
            endpoint="/api/finance"
            action="submission.submit"
            submitLabel="Submit for approval"
            fields={[
              {name: 'employeeName', label: 'Payee', required: true},
              {name: 'method', label: 'Method', type: 'select', options: [
                {value: 'bkash', label: 'bKash'}, {value: 'nagad', label: 'Nagad'}, {value: 'bank', label: 'Bank'}, {value: 'cash', label: 'Cash'}]},
              {name: 'amountMinor', label: 'Amount (paisa)', type: 'number', required: true},
            ]}
          />
          <table>
            <thead><tr><th>Submitted by</th><th>State</th></tr></thead>
            <tbody>
              {submissions.map((submission) => (
                <tr key={submission.id}>
                  <td>{submission.display_name ?? submission.submitted_by.slice(0, 12)}</td>
                  <td><span className={`pill ${submission.state === 'APPROVED' ? 'ok' : submission.state === 'REJECTED' ? 'bad' : 'warn'}`}>{submission.state}</span></td>
                </tr>
              ))}
              {!submissions.length ? <tr><td colSpan={2} className="muted">No submissions.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
