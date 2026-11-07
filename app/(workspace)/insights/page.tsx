import Link from 'next/link';
import {rows} from '@/lib/standalone/db';
import {pageUser, money} from '@/lib/standalone/session';
import {incomeExpense} from '@/lib/standalone/finance';
import {reviewQueueCounts} from '@/lib/standalone/review';

export const dynamic = 'force-dynamic';

export default async function InsightsPage() {
  await pageUser();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 8)}01`;
  const [people, programStates, attendance, cashStates, postings, messages, review, report] = await Promise.all([
    rows<{employees: number; active: number}>("SELECT count(*)::int AS employees, count(*) FILTER (WHERE state='ACTIVE')::int AS active FROM employees"),
    rows<{state: string; n: number}>('SELECT state, count(*)::int AS n FROM programs GROUP BY state ORDER BY state'),
    rows<{records: number; people: number}>('SELECT count(*)::int AS records, count(DISTINCT employee_mobile)::int AS people FROM attendance'),
    rows<{state: string; n: number; total: string}>('SELECT state, count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS total FROM cash_instructions GROUP BY state ORDER BY state'),
    rows<{n: number; total: string}>('SELECT count(*)::int AS n, coalesce(sum(amount_minor),0)::text AS total FROM cash_postings'),
    rows<{n: number; chats: number}>('SELECT count(*)::int AS n, count(DISTINCT chat_jid)::int AS chats FROM whatsapp_messages'),
    reviewQueueCounts(),
    incomeExpense(monthStart, today),
  ]);
  return (
    <>
      <div className="page-head"><div><h1>Operational Insights</h1><p className="muted">Read-only operational totals from the authoritative Phase 3 database.</p></div><div className="row-actions"><Link href="/reports">Reports →</Link></div></div>
      <div className="grid-cards">
        <div className="stat"><div className="label">Employees</div><div className="value">{people[0]?.employees ?? 0}</div><div className="muted">{people[0]?.active ?? 0} active</div></div>
        <div className="stat"><div className="label">Programs</div><div className="value">{programStates.reduce((sum, row) => sum + row.n, 0)}</div><div className="muted">{programStates.map((row) => `${row.state} ${row.n}`).join(' · ')}</div></div>
        <div className="stat"><div className="label">Attendance</div><div className="value">{attendance[0]?.records ?? 0}</div><div className="muted">{attendance[0]?.people ?? 0} employees</div></div>
        <div className="stat"><div className="label">Messages</div><div className="value">{messages[0]?.n ?? 0}</div><div className="muted">{messages[0]?.chats ?? 0} chats</div></div>
        <div className="stat"><div className="label">Pending reviews</div><div className="value">{review.pending + review.cashPending}</div><div className="muted">review + cash</div></div>
        <div className="stat"><div className="label">This month net</div><div className="value">{money(report.net)}</div><div className="muted">{report.from} → {report.to}</div></div>
      </div>
      <div className="split">
        <section className="card"><h3>Cash by state</h3><table><thead><tr><th>State</th><th>Count</th><th>Amount</th></tr></thead><tbody>
          {cashStates.map((row) => <tr key={row.state}><td>{row.state}</td><td>{row.n}</td><td>{money(row.total)}</td></tr>)}
          <tr><th>Postings</th><th>{postings[0]?.n ?? 0}</th><th>{money(postings[0]?.total ?? 0)}</th></tr>
        </tbody></table></section>
        <section className="card"><h3>Program states</h3><table><thead><tr><th>State</th><th>Count</th></tr></thead><tbody>
          {programStates.map((row) => <tr key={row.state}><td>{row.state}</td><td>{row.n}</td></tr>)}
        </tbody></table></section>
      </div>
    </>
  );
}
