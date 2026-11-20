import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {Suspense} from 'react';
import {EmployeesSummaryTable} from '@/components/standalone/employees-summary-table';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const user = await pageUser();
  const canManage = can(user as never, 'employee.manage');
  const canSubmit = can(user as never, 'employee.submit');
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p className="muted">Employee ID is the mobile number.</p>
        </div>
      </div>
      <section className="card">
        <Suspense fallback={<p className="muted">Loading employees…</p>}>
          <EmployeesSummaryTable canManage={canManage} canSubmit={canSubmit} />
        </Suspense>
      </section>
    </div>
  );
}
