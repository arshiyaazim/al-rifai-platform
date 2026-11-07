import Link from 'next/link';
import {pageUser, money} from '@/lib/standalone/session';
import {incomeExpense, listAccounts} from '@/lib/standalone/finance';

export const dynamic = 'force-dynamic';

export default async function IncomeExpenditurePage({searchParams}: {searchParams: Promise<{from?: string; to?: string}>}) {
  await pageUser();
  const params = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const from = params.from ?? `${today.slice(0, 8)}01`;
  const to = params.to ?? today;
  const [report, accounts] = await Promise.all([incomeExpense(from, to), listAccounts()]);
  const breakdown = (report as unknown as {breakdown: Array<{direction: string; category: string; source: string; total_minor: string}>}).breakdown ?? [];
  return (
    <>
      <div className="page-head"><div><h1>Income &amp; Expenditure</h1><p className="muted">Posted ledger totals for the selected range. Instructions are not postings.</p></div><div className="row-actions"><Link href="/transactions">Transactions →</Link></div></div>
      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid"><label><span>From</span><input name="from" type="date" defaultValue={from} /></label><label><span>To</span><input name="to" type="date" defaultValue={to} /></label></div>
        <button type="submit">Apply range</button>
      </form>
      <div className="grid-cards">
        <div className="stat"><div className="label">Income</div><div className="value">{money(report.income)}</div><div className="muted">CREDIT ledger</div></div>
        <div className="stat"><div className="label">Expenses</div><div className="value">{money(report.expense)}</div><div className="muted">DEBIT ledger</div></div>
        <div className="stat"><div className="label">Reversals</div><div className="value">{money(report.reversals)}</div><div className="muted">posted reversals</div></div>
        <div className="stat"><div className="label">Net</div><div className="value">{money(report.net)}</div><div className="muted">{from} → {to}</div></div>
      </div>
      <div className="split">
        <section className="card"><h3>Account balances</h3><table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th>Balance</th></tr></thead><tbody>
          {accounts.map((account) => <tr key={account.id}><td>{account.code}</td><td>{account.name}</td><td>{account.type}</td><td>{money(account.balance_minor)}</td></tr>)}
        </tbody></table></section>
        <section className="card"><h3>Ledger breakdown</h3><table><thead><tr><th>Direction</th><th>Category</th><th>Source</th><th>Amount</th></tr></thead><tbody>
          {breakdown.map((row, index) => <tr key={`${row.direction}-${row.category}-${row.source}-${index}`}><td>{row.direction}</td><td>{row.category}</td><td>{row.source}</td><td>{money(row.total_minor)}</td></tr>)}
          {!breakdown.length ? <tr><td colSpan={4} className="muted">No posted ledger entries in this range.</td></tr> : null}
        </tbody></table></section>
      </div>
    </>
  );
}
