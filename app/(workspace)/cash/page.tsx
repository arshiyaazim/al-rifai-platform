import Link from 'next/link';
import {cashTransactionView, countCashTransactions, listAccounts, listCashTransactions, listReconciliations} from '@/lib/standalone/finance';
import {cashDashboardSummary, currentMonthRange, previousMonthRange, shiftIsoDate, paidEventsReportingEnabled} from '@/lib/standalone/cash-dashboard';
import {money, pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';
import {CashTransactionsTable} from '@/components/standalone/cash-transactions-table';

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
  q?: string; state?: string; search?: string;
  employeeName?: string; employeeMobile?: string; payoutMobile?: string; openPayment?: string;
  employee_mobile?: string;
}>}) {
  const user = await pageUser();
  const canSubmit = can(user as never, 'cash.submit');
  const canReview = can(user as never, 'cash.review');
  const canLedger = can(user as never, 'cash.ledger');
  const canReconcile = can(user as never, 'cash.reconcile');
  const paidBasis = paidEventsReportingEnabled();
  const cashDetailPath = paidBasis ? '/cash/paid' : '/cash/transactions';
  const today = new Date().toISOString().slice(0, 10);
  const filters = await searchParams;
  const state = filters.state ?? '';
  const txSearch = (filters.search ?? '').trim();
  const employeeName = (filters.employeeName ?? '').trim();
  const employeeMobile = (filters.employeeMobile ?? '').trim();
  const payoutMobile = (filters.payoutMobile ?? '').trim();
  const paymentOpen = filters.openPayment === '1' || Boolean(employeeName || employeeMobile || payoutMobile);
  const txLimit = 20;
  const [accounts, summary, reconciliations, txRows, txTotal] = await Promise.all([
    listAccounts(),
    cashDashboardSummary(),
    listReconciliations(25),
    listCashTransactions({q: txSearch, state: state || undefined, employeeId: filters.employee_mobile || undefined, limit: txLimit, offset: 0}),
    countCashTransactions({q: txSearch, state: state || undefined, employeeId: filters.employee_mobile || undefined}),
  ]);
  const initialTransactions = txRows.map(cashTransactionView);
  const monthRange = currentMonthRange(summary.asOfDate);
  const lastMonthRange = previousMonthRange(summary.asOfDate);
  const rangeHref = (range: {from: string; to: string}) => `${cashDetailPath}?from=${range.from}&to=${range.to}`;
  const dateHref = (date: string) => `${cashDetailPath}?date=${date}`;

  return (
    <>
      <div className="page-head">
        <div><h1>Cash &amp; Accounts</h1><p className="muted">Instructions, postings and the ledger.</p></div>
        <div className="row-actions">
          <Link href="/review?domain=CASH">Open Cash review queue →</Link>
          {paidBasis ? <Link href="/cash/transactions">Financial POSTED →</Link> : <Link href="/cash/paid">Business Paid →</Link>}
        </div>
      </div>

      <div className="cash-dashboard-grid">
        <SummaryCard label="Total Paid Amount" value={money(summary.totalPaidMinor)} hint={paidBasis ? 'Business Paid Events' : 'Posted payments'} href={cashDetailPath} />
        <SummaryCard label="Current Month Paid" value={money(summary.currentMonthPaidMinor)} hint={paidBasis ? 'Business paid this month' : 'Posted this month'} href={rangeHref(monthRange)} />
        <SummaryCard label="Today's Paid Amount" value={money(summary.todayPaidMinor)} hint={paidBasis ? 'Business paid today' : 'Posted today'} href={dateHref(summary.asOfDate)} />
        <SummaryCard label="Yesterday Paid" value={money(summary.yesterdayPaidMinor)} hint={paidBasis ? 'Business paid yesterday' : 'Posted yesterday'} href={dateHref(shiftIsoDate(summary.asOfDate, -1))} />
        <SummaryCard label="Paid Via WA" value={money(summary.viaWhatsAppPaidMinor)} hint={paidBasis ? 'Business paid from WhatsApp' : 'Posted from WhatsApp source'} href={`${cashDetailPath}?source=WHATSAPP`} />
        <SummaryCard label="Paid By Office" value={money(summary.byOfficePaidMinor)} hint={paidBasis ? 'Business paid via Office' : 'Posted non-WhatsApp payments'} href={`${cashDetailPath}?source=OFFICE`} />
        <SummaryCard label="Number of Employee" value={String(summary.employeeCount)} hint="Employees on record" href="/employees" />
        <SummaryCard label="Last Month Paid" value={money(summary.lastMonthPaidMinor)} hint={paidBasis ? 'Business paid last month' : 'Posted last month'} href={rangeHref(lastMonthRange)} />
      </div>

      <CashTransactionsTable canManage={user.role === 'ADMIN' && canReview} canSubmit={canSubmit} initialPaymentOpen={paymentOpen}
        paymentDefaults={{employeeName, employeeMobile, payoutMobile}}
        accounts={accounts.map((account) => ({id: account.id, code: account.code, name: account.name}))}
        initialSearch={txSearch} initialState={state} initialEmployeeMobile={filters.employee_mobile ?? ''} initial={{
        transactions: initialTransactions,
        total: txTotal,
        page: 1,
        limit: txLimit,
        totalPages: Math.max(1, Math.ceil(txTotal / txLimit)),
      }} />

      {/* Income/expense posting has no other route (the ledger views are read-only),
          so the form stays here even though the ledger table moved out of this page. */}
      <div className="cash-form-grid">
        {canLedger ? (
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
        ) : null}
      </div>

      {/* Reconciliation exists only on this page; removing it would make the
          feature unreachable, so it stays (see the batch report). */}
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
