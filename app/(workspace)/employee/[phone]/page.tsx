import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getEmployee} from '@/lib/standalone/employees';
import {DomainError} from '@/lib/standalone/db';
import {pageUser, money, when} from '@/lib/standalone/session';
import {listInstructions} from '@/lib/standalone/finance';

export const dynamic = 'force-dynamic';

export default async function EmployeeAliasDetailPage({params}: {params: Promise<{phone: string}>}) {
  await pageUser();
  const {phone} = await params;
  const mobile = decodeURIComponent(phone);
  let data;
  try { data = await getEmployee(mobile); } catch (error) { if (error instanceof DomainError && error.status === 404) notFound(); throw error; }
  const payments = await listInstructions({q: mobile, limit: 100});
  return (
    <>
      <div className="page-head"><div><h1>{data.employee.preferred_name}</h1><p className="muted">{data.employee.employee_mobile} · {data.employee.duty_type ?? 'no duty type'} · {data.employee.state}</p></div><div className="row-actions"><Link href="/employee">← Employees</Link><Link href={`/employees/${encodeURIComponent(mobile)}`}>Full profile →</Link></div></div>
      <div className="split">
        <section className="card"><h3>Profile</h3><table><tbody><tr><th>Designation</th><td>{data.employee.designation ?? '—'}</td></tr><tr><th>Joined</th><td>{data.employee.joined_on ?? '—'}</td></tr><tr><th>Aliases</th><td>{data.employee.name_aliases.length ? data.employee.name_aliases.join(', ') : '—'}</td></tr><tr><th>Notes</th><td>{data.employee.notes ?? '—'}</td></tr></tbody></table></section>
        <section className="card"><h3>Payment history ({payments.length})</h3><table><thead><tr><th>Date</th><th>Amount</th><th>State</th></tr></thead><tbody>{payments.map((payment) => { const item = payment as unknown as {id: string; created_at: string; amount_minor: string; state: string}; return <tr key={item.id}><td>{when(item.created_at as unknown as Date)}</td><td>{money(item.amount_minor)}</td><td>{item.state}</td></tr>; })}{!payments.length ? <tr><td colSpan={3} className="muted">No payments.</td></tr> : null}</tbody></table></section>
      </div>
    </>
  );
}
