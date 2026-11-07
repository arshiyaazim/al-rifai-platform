import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getEmployee} from '@/lib/standalone/employees';
import {DomainError} from '@/lib/standalone/db';
import {pageUser, money, when} from '@/lib/standalone/session';
import {listInstructions} from '@/lib/standalone/finance';

export const dynamic = 'force-dynamic';

export default async function EmployeeTransactionsPage({params}: {params: Promise<{phone: string}>}) {
  await pageUser();
  const {phone} = await params;
  const mobile = decodeURIComponent(phone);
  let employee;
  try { employee = (await getEmployee(mobile)).employee; } catch (error) { if (error instanceof DomainError && error.status === 404) notFound(); throw error; }
  const payments = await listInstructions({q: mobile, limit: 200});
  return (
    <>
      <div className="page-head"><div><h1>Transactions · {employee.preferred_name}</h1><p className="muted">{employee.employee_mobile}</p></div><div className="row-actions"><Link href="/transactions">← Transactions</Link><Link href={`/employee/${encodeURIComponent(mobile)}`}>Employee →</Link></div></div>
      <section className="card"><h3>Instructions ({payments.length})</h3><table><thead><tr><th>ID</th><th>Date</th><th>Method</th><th>Amount</th><th>State</th><th>Source</th></tr></thead><tbody>
        {payments.map((payment) => { const item = payment as unknown as {id: string; created_at: string; method: string; amount_minor: string; state: string; source_channel?: string | null; source_message_id?: string | null}; return <tr key={item.id}><td><Link href={`/cash/${item.id}`}>{item.id}</Link></td><td>{when(item.created_at)}</td><td>{item.method}</td><td>{money(item.amount_minor)}</td><td>{item.state}</td><td>{item.source_channel ?? 'WEB'}{item.source_message_id ? <div className="muted" style={{fontSize: 10}}>{item.source_message_id}</div> : null}</td></tr>; })}
        {!payments.length ? <tr><td colSpan={6} className="muted">No transactions for this employee.</td></tr> : null}
      </tbody></table></section>
    </>
  );
}
