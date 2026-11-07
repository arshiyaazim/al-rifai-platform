import Link from 'next/link';
import {countInstructions, countLedger, listAccounts, listInstructions, listLedger, listReconciliations} from '@/lib/standalone/finance';
import {cashDashboardSummary, currentMonthRange, previousMonthRange, shiftIsoDate} from '@/lib/standalone/cash-dashboard';
import {listCashReviewCandidates} from '@/lib/standalone/review';
import {rows} from '@/lib/standalone/db';
import {money, pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';
import {CashPaymentForm} from '@/components/standalone/cash-payment-form';
import {formatReviewAmount, formatReviewTimestamp, reviewCategoryLabel, reviewCategoryTone, reviewStateLabel, reviewStateTone} from '@/lib/review-ui';

export const dynamic = 'force-dynamic';

type SummaryCardProps = {
  label: string;
  value: string;
  hint: string;
  href?: string;
};

function SummaryCard({label, value, hint, href}: SummaryCardProps) {
  const body = (
    <>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      <div className="hint">{hint}</div>
    </>
  );
  return href
    ? <Link href={href} className="cash-dashboard-card">{body}</Link>
    : <div className="cash-dashboard-card">{body}</div>;
}

export default async function CashPage({searchParams}: {searchParams: Promise<{
  q?: string; state?: string; page?: string; ledgerPage?: string; from?: string; to?: string;
  employeeName?: string; employeeMobile?: string; payoutMobile?: string; openPayment?: string;
}>}) {
  const user = await pageUser();
  const canReview = can(user as never, 'cash.review');
  const canReverse = can(user as never, 'cash.reverse');
  const canReconcile = can(user as never, 'cash.reconcile');
  const today = new Date().toISOString().slice(0, 10);
  const filters = await searchParams;
  const q = (filters.q ?? '').trim();
  const state = filters.state ?? '';
  const from = filters.from ?? '';
  const to = filters.to ?? '';
  const employeeName = (filters.employeeName ?? '').trim();
  const employeeMobile = (filters.employeeMobile ?? '').trim();
  const payoutMobile = (filters.payoutMobile ?? '').trim();
  const paymentOpen = filters.openPayment === '1' || Boolean(employeeName || employeeMobile || payoutMobile);
  const page = Math.max(1, Number(filters.page) || 1);
  const ledgerPage = Math.max(1, Number(filters.ledgerPage) || 1);
  const pageSize = 100;
  const ledgerSize = 50;
  const [accounts, instructions, instructionTotal, ledger, ledgerTotal, summary, submissions, cashCandidates, reconciliations] = await Promise.all([
    listAccounts(),
    listInstructions({q, state: state || undefined, limit: pageSize, offset: (page - 1) * pageSize}),
    countInstructions({q, state: state || undefined}),
    listLedger({from: from || undefined, to: to || undefined, limit: ledgerSize, offset: (ledgerPage - 1) * ledgerSize}),
    countLedger({from: from || undefined, to: to || undefined}),
    cashDashboardSummary(),
    rows<{id: string; state: string; submitted_by: string; created_at: string; instruction_id: string | null; display_name: string | null}>(
      'SELECT s.id, s.state, s.submitted_by, s.created_at, s.instruction_id, u.display_name FROM cash_submissions s LEFT JOIN cash_portal_users u ON u.id = s.submitted_by ORDER BY s.created_at DESC LIMIT 30',
    ),
    listCashReviewCandidates({state: 'PENDING_REVIEW', limit: 50}),
    listReconciliations(25),
  ]);
  const pending = instructions.filter((instruction) => (instruction as {state: string}).state === 'REVIEW').slice(0, 20);
  const instructionPages = Math.max(1, Math.ceil(instructionTotal / pageSize));
  const ledgerPages = Math.max(1, Math.ceil(ledgerTotal / ledgerSize));
  const monthRange = currentMonthRange(summary.asOfDate);
  const lastMonthRange = previousMonthRange(summary.asOfDate);
  const rangeHref = (range: {from: string; to: string}) => `/cash/transactions?from=${range.from}&to=${range.to}`;
  const dateHref = (date: string) => `/cash/transactions?date=${date}`;
  const href = (overrides: Record<string, string | number>) => {
    const values: Record<string, string> = {};
    if (q) values.q = q;
    if (state) values.state = state;
    if (from) values.from = from;
    if (to) values.to = to;
    if (page > 1) values.page = String(page);
    if (ledgerPage > 1) values.ledgerPage = String(ledgerPage);
    for (const [key, value] of Object.entries(overrides)) {
      if (String(value) === '' || value === 1) delete values[key];
      else values[key] = String(value);
    }
    const search = new URLSearchParams(values).toString();
    return search ? `/cash?${search}` : '/cash';
  };

  return (
    <>
      <div className="page-head">
        <div><h1>Cash &amp; Accounts</h1><p className="muted">Instructions, approvals, postings and the ledger.</p></div>
        <div className="row-actions">
          <Link href="/review?domain=CASH">Open Cash review queue →</Link>
        </div>
      </div>

      <div className="cash-dashboard-grid">
        <SummaryCard label="Total Paid Amount" value={money(summary.totalPaidMinor)} hint="All posted payments" href="/cash/transactions" />
        <SummaryCard label="Current Month Paid" value={money(summary.currentMonthPaidMinor)} hint="Posted this month" href={rangeHref(monthRange)} />
        <SummaryCard label="Today's Paid Amount" value={money(summary.todayPaidMinor)} hint="Posted today" href={dateHref(summary.asOfDate)} />
        <SummaryCard label="Yesterday Paid" value={money(summary.yesterdayPaidMinor)} hint="Posted yesterday" href={dateHref(shiftIsoDate(summary.asOfDate, -1))} />
        <SummaryCard label="Paid Via WA" value={money(summary.viaWhatsAppPaidMinor)} hint="Posted from WhatsApp source" href="/cash/transactions?source=WHATSAPP" />
        <SummaryCard label="Paid By Office" value={money(summary.byOfficePaidMinor)} hint="Posted non-WhatsApp payments" href="/cash/transactions?source=OFFICE" />
        <SummaryCard label="Number of Employee" value={String(summary.employeeCount)} hint="Employees on record" href="/employees" />
        <SummaryCard label="Last Month Paid" value={money(summary.lastMonthPaidMinor)} hint="Posted last month" href={rangeHref(lastMonthRange)} />
      </div>

      <div className="cash-form-grid">
        <details className="cash-form-panel" id="new-payment" open={paymentOpen}>
          <summary>New payment instruction</summary>
          <CashPaymentForm
            key={`${employeeName}|${employeeMobile}|${payoutMobile}|${paymentOpen ? '1' : '0'}`}
            accounts={accounts.map((account) => ({id: account.id, code: account.code, name: account.name}))}
            defaults={{employeeName, employeeMobile, payoutMobile}}
          />
        </details>
        <details className="cash-form-panel">
          <summary>Record income / expense</summary>
          <ActionForm
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
        </details>
      </div>

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Cash review candidates ({cashCandidates.length})</h3></div>
          <span className="muted">Reviewers can inspect source evidence and correct supported fields. Approving a candidate creates a linked REVIEW instruction; it never posts or settles funds.</span>
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

      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid">
          <label><span>Search payee</span><input name="q" defaultValue={q} placeholder="Name or mobile" /></label>
          <label><span>State</span>
            <select name="state" defaultValue={state}>
              <option value="">All states</option>
              {['REVIEW','APPROVED','POSTED','REJECTED','VOID'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Ledger from</span><input name="from" type="date" defaultValue={from} /></label>
          <label><span>Ledger to</span><input name="to" type="date" defaultValue={to} /></label>
        </div>
        <button type="submit">Filter Cash</button>
      </form>

      <section className="card">
        <h3>Instructions ({instructionTotal})</h3>
        {canReview ? (
          <ActionForm
            compact
            title="Assign paying account (REVIEW only)"
            endpoint="/api/finance"
            action="instruction.account"
            submitLabel="Assign account"
            fields={[
              {name: 'id', label: 'Instruction id', required: true},
              {name: 'accountId', label: 'Account', type: 'select', required: true,
                options: accounts.map((account) => ({value: account.id, label: `${account.code} — ${account.name}`}))},
            ]}
          />
        ) : null}
        <table>
          <thead><tr><th>Instruction</th><th>Payee</th><th>Account</th><th>Method</th><th>Amount</th><th>State</th><th>Source</th><th>Actions</th></tr></thead>
          <tbody>
            {instructions.map((instruction) => {
              const item = instruction as unknown as {
                id: string; employee_name: string; method: string; amount_minor: string; state: string;
                account_code?: string | null; source_channel?: string | null; source_message_id?: string | null; source_block_key?: string | null;
                reversal_id?: string | null; reversed_at?: string | null; reversal_reason?: string | null;
              };
              return (
                <tr key={item.id}>
                  <td><Link href={`/cash/${item.id}`} style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</Link></td>
                  <td>{item.employee_name}</td>
                  <td>{item.account_code ?? <span className="muted">unassigned</span>}</td>
                  <td>{item.method}</td>
                  <td>{money(item.amount_minor)}</td>
                  <td>
                    <span className={`pill ${item.state === 'POSTED' ? 'ok' : item.state === 'VOID' || item.state === 'REJECTED' ? 'bad' : 'warn'}`}>{item.state}</span>
                    {item.reversal_id ? <div className="muted" style={{fontSize: 10}}>reversed {when(item.reversed_at)}</div> : null}
                  </td>
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
                    ) : item.state === 'POSTED' && canReverse ? (
                      <ActionForm compact endpoint="/api/finance" action="instruction.reverse" submitLabel="Reverse" hidden={{id: item.id}} fields={[{name: 'reason', label: 'Reversal reason', required: true}]} />
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              );
            })}
            {!instructions.length ? <tr><td colSpan={8} className="muted">No instructions yet.</td></tr> : null}
          </tbody>
        </table>
        {pending.length ? <p className="muted">{pending.length} instruction(s) awaiting approval. Posting remains a separate explicit admin action.</p> : null}
        {instructionPages > 1 ? (
          <div className="row-actions">
            {page > 1 ? <Link href={href({page: page - 1})}>← Previous</Link> : null}
            <span className="muted">Page {page} / {instructionPages}</span>
            {page < instructionPages ? <Link href={href({page: page + 1})}>Next →</Link> : null}
          </div>
        ) : null}
      </section>

      <div className="split">
        <section className="card">
          <h3>Ledger ({ledgerTotal})</h3>
          <table>
            <thead><tr><th>Date</th><th>Account</th><th>Category</th><th>Amount</th></tr></thead>
            <tbody>
              {ledger.map((entry) => {
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
          {ledgerPages > 1 ? (
            <div className="row-actions">
              {ledgerPage > 1 ? <Link href={href({ledgerPage: ledgerPage - 1})}>← Previous</Link> : null}
              <span className="muted">Page {ledgerPage} / {ledgerPages}</span>
              {ledgerPage < ledgerPages ? <Link href={href({ledgerPage: ledgerPage + 1})}>Next →</Link> : null}
            </div>
          ) : null}
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
            <thead><tr><th>Submitted by</th><th>State</th><th>Instruction</th><th>Decision</th></tr></thead>
            <tbody>
              {submissions.map((submission) => (
                <tr key={submission.id}>
                  <td>{submission.display_name ?? submission.submitted_by.slice(0, 12)}</td>
                  <td><span className={`pill ${submission.state === 'APPROVED' ? 'ok' : submission.state === 'REJECTED' ? 'bad' : 'warn'}`}>{submission.state}</span></td>
                  <td>{submission.instruction_id ? <Link href={`/cash/${submission.instruction_id}`}>{submission.instruction_id}</Link> : <span className="muted">—</span>}</td>
                  <td>
                    {submission.state === 'PENDING_REVIEW' && canReview ? (
                      <div className="row-actions">
                        <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Approve candidate" hidden={{id: submission.id, kind: 'cash_submission', decision: 'APPROVED'}} fields={[]} />
                        <ActionForm compact endpoint="/api/review" action="decide" submitLabel="Reject candidate" hidden={{id: submission.id, kind: 'cash_submission', decision: 'REJECTED'}} fields={[{name: 'reason', label: 'Reason', required: true}]} />
                      </div>
                    ) : <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
              {!submissions.length ? <tr><td colSpan={4} className="muted">No submissions.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Reconciliation ({reconciliations.length})</h3></div>
          <span className="muted">Expected balance is derived from the immutable ledger. A non-zero variance must be explained; closing never posts an automatic adjustment.</span>
        </div>
        {canReconcile ? (
          <div className="split" style={{marginBottom: 12}}>
            <ActionForm
              title="Start reconciliation"
              endpoint="/api/finance"
              action="reconciliation.create"
              submitLabel="Record count"
              fields={[
                {name: 'accountId', label: 'Account', type: 'select', required: true,
                  options: accounts.map((account) => ({value: account.id, label: `${account.code} — ${account.name}`}))},
                {name: 'periodStart', label: 'Period start', type: 'date', required: true, defaultValue: today.slice(0, 8) + '01'},
                {name: 'periodEnd', label: 'Period end', type: 'date', required: true, defaultValue: today},
                {name: 'countedBalance', label: 'Counted balance (BDT)', required: true, placeholder: '0.00'},
                {name: 'note', label: 'Note'},
              ]}
            />
            <ActionForm
              title="Close reconciliation"
              endpoint="/api/finance"
              action="reconciliation.close"
              submitLabel="Close"
              fields={[
                {name: 'id', label: 'Reconciliation id', required: true},
                {name: 'note', label: 'Closing note (required for variance)', type: 'textarea'},
              ]}
            />
          </div>
        ) : null}
        <table>
          <thead><tr><th>Period</th><th>Account</th><th>Expected</th><th>Counted</th><th>Variance</th><th>State</th><th>Note</th></tr></thead>
          <tbody>
            {reconciliations.map((row) => {
              const item = row as unknown as {
                id: string; account_code: string; period_start: string; period_end: string;
                expected_balance_minor: string; counted_balance_minor: string; variance_minor: string;
                state: string; note: string | null;
              };
              return (
                <tr key={item.id}>
                  <td>{when(item.period_start).slice(0, 10)} → {when(item.period_end).slice(0, 10)}<div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{item.id}</div></td>
                  <td>{item.account_code}</td>
                  <td>{money(item.expected_balance_minor)}</td>
                  <td>{money(item.counted_balance_minor)}</td>
                  <td><span className={`pill ${Number(item.variance_minor) === 0 ? 'ok' : 'warn'}`}>{money(item.variance_minor)}</span></td>
                  <td>{item.state}</td>
                  <td>{item.note ?? '—'}</td>
                </tr>
              );
            })}
            {!reconciliations.length ? <tr><td colSpan={7} className="muted">No reconciliations recorded.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
