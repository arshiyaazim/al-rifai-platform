import {displayMobile} from '@/lib/display-mobile';
import {notFound} from 'next/navigation';
import {getEmployee} from '@/lib/standalone/employees';
import {money} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';
import {DomainError} from '@/lib/standalone/db';

export const dynamic = 'force-dynamic';

export default async function EmployeeDetailPage({params}: {params: Promise<{mobile: string}>}) {
  const {mobile} = await params;
  let data;
  try {
    data = await getEmployee(decodeURIComponent(mobile));
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }
  const {employee} = data;
  const programs = data.programs as Array<{
    id: string; mother_vessel: string; lighter_vessel: string; start_date: string;
    end_date: string | null; state: string; total_minor: string | null;
  }>;
  const attendance = data.attendance as Array<{
    duty_date: string; shift: string; state: string; hours: string | null;
  }>;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{employee.preferred_name}</h1>
          <p className="muted">{displayMobile(employee.employee_mobile)} · {employee.duty_type ?? 'no duty type'} · {employee.state}</p>
        </div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Profile</h3>
          <table>
            <tbody>
              <tr><th>Designation</th><td>{employee.designation ?? '—'}</td></tr>
              <tr><th>Joined</th><td>{employee.joined_on ?? '—'}</td></tr>
              <tr><th>Aliases</th><td>{employee.name_aliases.length ? employee.name_aliases.join(', ') : '—'}</td></tr>
              <tr><th>Notes</th><td>{employee.notes ?? '—'}</td></tr>
            </tbody>
          </table>
          <ActionForm
            title="Update employee"
            endpoint="/api/employees"
            method="PATCH"
            submitLabel="Save changes"
            hidden={{employeeMobile: employee.employee_mobile}}
            fields={[
              {name: 'preferredName', label: 'Name', defaultValue: employee.preferred_name},
              {name: 'designation', label: 'Designation', defaultValue: employee.designation ?? ''},
              {name: 'state', label: 'Status', type: 'select', defaultValue: employee.state, options: [
                {value: 'ACTIVE', label: 'Active'}, {value: 'INACTIVE', label: 'Inactive'},
                {value: 'SUSPENDED', label: 'Suspended'},
              ]},
              {name: 'notes', label: 'Notes', type: 'textarea', defaultValue: employee.notes ?? ''},
            ]}
          />
        </section>

        <section className="card">
          <h3>Record attendance</h3>
          <ActionForm
            endpoint="/api/attendance"
            submitLabel="Record"
            hidden={{employeeMobile: employee.employee_mobile}}
            fields={[
              {name: 'dutyDate', label: 'Date', type: 'date', required: true},
              {name: 'shift', label: 'Shift', type: 'select', options: [
                {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
              ]},
              {name: 'state', label: 'State', type: 'select', options: [
                {value: 'PRESENT', label: 'Present'}, {value: 'ABSENT', label: 'Absent'},
                {value: 'LEAVE', label: 'Leave'},
              ]},
              {name: 'hours', label: 'Hours', type: 'number'},
            ]}
          />
          <h3>Recent attendance</h3>
          <table>
            <thead><tr><th>Date</th><th>Shift</th><th>State</th><th>Hours</th></tr></thead>
            <tbody>
              {attendance.map((entry, index) => (
                <tr key={`${entry.duty_date}-${entry.shift}-${index}`}>
                  <td>{entry.duty_date}</td><td>{entry.shift}</td><td>{entry.state}</td><td>{entry.hours ?? '—'}</td>
                </tr>
              ))}
              {!attendance.length ? <tr><td colSpan={4} className="muted">No attendance recorded.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>

      <section className="card">
        <h3>Program history</h3>
        <table>
          <thead><tr><th>Program</th><th>Vessel</th><th>Start</th><th>End</th><th>State</th><th>Pay</th></tr></thead>
          <tbody>
            {programs.map((program) => (
              <tr key={program.id}>
                <td>{program.id.slice(0, 16)}</td>
                <td>{program.mother_vessel} → {program.lighter_vessel}</td>
                <td>{program.start_date}</td>
                <td>{program.end_date ?? '—'}</td>
                <td><span className="pill">{program.state}</span></td>
                <td>{money(program.total_minor)}</td>
              </tr>
            ))}
            {!programs.length ? <tr><td colSpan={6} className="muted">No programs for this employee.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
