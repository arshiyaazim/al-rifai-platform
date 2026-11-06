import Link from 'next/link';
import {listEmployees} from '@/lib/standalone/employees';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage({searchParams}: {searchParams: Promise<{q?: string; state?: string}>}) {
  const filters = await searchParams;
  const q = (filters.q ?? '').trim();
  const state = filters.state ?? '';
  const employees = await listEmployees({q, state: state || undefined, limit: 500});
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
        <table>
          <thead><tr><th>Name</th><th>Mobile</th><th>Type</th><th>Status</th><th>Programs</th><th>Days</th><th /></tr></thead>
          <tbody>
            {employees.map((employee) => (
              <tr key={employee.employee_mobile}>
                <td><Link href={`/employees/${encodeURIComponent(employee.employee_mobile)}`}>{employee.preferred_name}</Link></td>
                <td>{employee.employee_mobile}</td>
                <td>{employee.duty_type ?? '—'}</td>
                <td><span className={`pill ${employee.state === 'ACTIVE' ? 'ok' : 'warn'}`}>{employee.state}</span></td>
                <td>{employee.programs}</td>
                <td>{employee.attendance_days}</td>
                <td><Link href={`/employees/${encodeURIComponent(employee.employee_mobile)}`}>Open</Link></td>
              </tr>
            ))}
            {!employees.length ? <tr><td colSpan={7} className="muted">No employees yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
