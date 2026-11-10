import {listEmployees} from '@/lib/standalone/employees';
import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';
import {EmployeesTable} from '@/components/standalone/employees-table';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage({searchParams}: {searchParams: Promise<{q?: string; state?: string}>}) {
  const filters = await searchParams;
  const q = (filters.q ?? '').trim();
  const state = filters.state ?? '';
  const employees = await listEmployees({q, state: state || undefined, limit: 500});
  const user = await pageUser();
  const canManage = can(user as never, 'employee.manage');
  return (
    <>
      <div className="page-head">
        <div><h1>Employees</h1><p className="muted">Employee and escort profiles, status and assignment history.</p></div>
      </div>

      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid">
          <label><span>Search</span><input name="q" defaultValue={q} placeholder="Name or mobile" /></label>
          <label><span>Status</span>
            <select name="state" defaultValue={state}>
              <option value="">All statuses</option>
              <option value="ACTIVE">Active</option>
              <option value="INACTIVE">Inactive</option>
              <option value="SUSPENDED">Suspended</option>
            </select>
          </label>
        </div>
        <button type="submit">Filter employees</button>
      </form>

      <ActionForm
        title="Add employee"
        endpoint="/api/employees"
        submitLabel="Create employee"
        fields={[
          {name: 'employeeMobile', label: 'Mobile (01XXXXXXXXX)', required: true, placeholder: '01712345678'},
          {name: 'preferredName', label: 'Name', required: true},
          {name: 'dutyType', label: 'Duty type', type: 'select', options: [
            {value: 'escort', label: 'Escort'}, {value: 'crew', label: 'Crew'},
            {value: 'office', label: 'Office'}, {value: 'other', label: 'Other'},
          ]},
          {name: 'designation', label: 'Designation'},
          {name: 'joinedOn', label: 'Joined on', type: 'date'},
          {name: 'notes', label: 'Notes', type: 'textarea'},
        ]}
      />

      <section className="card">
        <h3>Directory ({employees.length})</h3>
        <EmployeesTable rows={employees.map((employee) => ({
          employee_mobile: employee.employee_mobile,
          preferred_name: employee.preferred_name,
          duty_type: employee.duty_type,
          state: employee.state,
          programs: employee.programs,
          attendance_days: employee.attendance_days,
        }))} canManage={canManage} />
      </section>
    </>
  );
}
