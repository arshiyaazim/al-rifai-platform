import {attendanceSummary, listAttendance} from '@/lib/standalone/attendance';
import {listEmployees} from '@/lib/standalone/employees';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function AttendancePage({searchParams}: {searchParams: Promise<{from?: string; to?: string; employee?: string}>}) {
  const filters = await searchParams;
  const from = filters.from ?? '';
  const to = filters.to ?? '';
  const employee = filters.employee ?? '';
  const [records, summary, employees] = await Promise.all([
    listAttendance({from: from || undefined, to: to || undefined, employee: employee || undefined}),
    attendanceSummary(), listEmployees({state: 'ACTIVE'}),
  ]);
  return (
    <>
      <div className="page-head">
        <div><h1>Attendance</h1><p className="muted">Day/night duty attendance per employee, corrections and monthly summary.</p></div>
      </div>

      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid">
          <label><span>From</span><input name="from" type="date" defaultValue={from} /></label>
          <label><span>To</span><input name="to" type="date" defaultValue={to} /></label>
          <label><span>Employee</span>
            <select name="employee" defaultValue={employee}>
              <option value="">All employees</option>
              {employees.map((entry) => (
                <option key={entry.employee_mobile} value={entry.employee_mobile}>{entry.preferred_name} ({entry.employee_mobile})</option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit">Filter attendance</button>
      </form>

      <ActionForm
        title="Record or correct attendance"
        endpoint="/api/attendance"
        submitLabel="Record"
        fields={[
          {name: 'employeeMobile', label: 'Employee', type: 'select', required: true,
            options: employees.map((employee) => ({value: employee.employee_mobile, label: `${employee.preferred_name} (${employee.employee_mobile})`}))},
          {name: 'dutyDate', label: 'Date', type: 'date', required: true},
          {name: 'shift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
          {name: 'state', label: 'State', type: 'select', options: [
            {value: 'PRESENT', label: 'Present'}, {value: 'ABSENT', label: 'Absent'}, {value: 'LEAVE', label: 'Leave'}]},
          {name: 'hours', label: 'Hours', type: 'number'},
          {name: 'reason', label: 'Correction reason (only when changing an existing day)'},
        ]}
      />
      <p className="muted" style={{marginTop: -8}}>Saving the same employee, date and shift updates the record and writes an ATTENDANCE_CORRECTED audit entry.</p>

      <div className="split">
        <section className="card">
          <h3>This month</h3>
          <table>
            <thead><tr><th>Employee</th><th>Present</th><th>Absent</th><th>Leave</th></tr></thead>
            <tbody>
              {summary.map((line) => (
                <tr key={line.employee_mobile}>
                  <td>{line.employee_mobile}</td><td>{line.present}</td><td>{line.absent}</td><td>{line.leave}</td>
                </tr>
              ))}
              {!summary.length ? <tr><td colSpan={4} className="muted">No attendance this month.</td></tr> : null}
            </tbody>
          </table>
        </section>
        <section className="card">
          <h3>Recent records</h3>
          <table>
            <thead><tr><th>Date</th><th>Employee</th><th>Shift</th><th>State</th><th>Hours</th></tr></thead>
            <tbody>
              {records.slice(0, 40).map((record) => (
                <tr key={record.id as string}>
                  <td>{record.duty_date as string}</td>
                  <td>{(record.preferred_name as string) ?? (record.employee_mobile as string)}</td>
                  <td>{record.shift as string}</td>
                  <td>{record.state as string}</td>
                  <td>{(record.hours as string) ?? '—'}</td>
                </tr>
              ))}
              {!records.length ? <tr><td colSpan={5} className="muted">No attendance yet.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
