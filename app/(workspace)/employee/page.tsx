import Link from 'next/link';
import {listEmployees} from '@/lib/standalone/employees';
import {pageUser} from '@/lib/standalone/session';

export const dynamic = 'force-dynamic';

export default async function EmployeeAliasPage({searchParams}: {searchParams: Promise<{q?: string; state?: string}>}) {
  await pageUser();
  const params = await searchParams;
  const employees = await listEmployees({q: params.q ?? '', state: params.state, limit: 500});
  return (
    <>
      <div className="page-head"><div><h1>Employees</h1><p className="muted">Legacy employee directory URL.</p></div><div className="row-actions"><Link href="/employees">Employee workspace →</Link></div></div>
      <form method="get" className="card form compact" style={{marginBottom: 18}}><div className="grid"><label><span>Search</span><input name="q" defaultValue={params.q ?? ''} /></label><label><span>Status</span><select name="state" defaultValue={params.state ?? ''}><option value="">All</option><option value="ACTIVE">Active</option><option value="INACTIVE">Inactive</option><option value="SUSPENDED">Suspended</option></select></label></div><button type="submit">Filter</button></form>
      <section className="card"><h3>Directory ({employees.length})</h3><table><thead><tr><th>Name</th><th>Mobile</th><th>Type</th><th>Status</th><th>Programs</th><th>Days</th></tr></thead><tbody>
        {employees.map((employee) => <tr key={employee.employee_mobile}><td><Link href={`/employee/${encodeURIComponent(employee.employee_mobile)}`}>{employee.preferred_name}</Link></td><td>{employee.employee_mobile}</td><td>{employee.duty_type ?? '—'}</td><td>{employee.state}</td><td>{employee.programs}</td><td>{employee.attendance_days}</td></tr>)}
        {!employees.length ? <tr><td colSpan={6} className="muted">No employees.</td></tr> : null}
      </tbody></table></section>
    </>
  );
}
