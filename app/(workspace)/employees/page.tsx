import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {EmployeesSummaryTable} from '@/components/standalone/employees-summary-table';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const user = await pageUser();
  const canManage = can(user as never, 'employee.manage');
  return (
    <div className="vessel-workspace">
      <div className="page-head">
        <div>
          <h1>Employees</h1>
          <p className="muted">
            Employee and escort profiles, attendance days, salary at ৳400/day, cash paid and due.
            Employee ID is the mobile number; one mobile is one person across cash and vessel.
          </p>
        </div>
      </div>
      <section className="card">
        <EmployeesSummaryTable canManage={canManage} />
      </section>
    </div>
  );
}
