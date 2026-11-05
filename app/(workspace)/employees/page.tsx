import Link from 'next/link';
import {listEmployees} from '@/lib/standalone/employees';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function EmployeesPage() {
  const employees = await listEmployees({});
  return (
    <>
      <div className="page-head">
        <div><h1>Employees</h1><p className="muted">Employee and escort profiles, status and assignment history.</p></div>
      </div>

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
