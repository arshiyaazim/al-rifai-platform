import {displayMobile} from '@/lib/display-mobile';
import {notFound} from 'next/navigation';
import {getEmployee} from '@/lib/standalone/employees';
import {money, pageUser} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';
import {DomainError} from '@/lib/standalone/db';
import {unifiedAttendance} from '@/lib/standalone/attendance-records';
import {
  cashTransactionView, countCashTransactions, getCashEmployeeSummary, listCashTransactions,
} from '@/lib/standalone/finance';
import {CashEmployeeHistory, type CashEmployeePayload} from '@/components/standalone/cash-employee-history';
import {dateDdMmYyyy} from '@/lib/export-format';

export const dynamic = 'force-dynamic';

export default async function EmployeeDetailPage({params}: {params: Promise<{mobile: string}>}) {
  const {mobile} = await params;
  const user = await pageUser();
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
  const legacyAttendance = data.attendance as Array<{
    duty_date: string; shift: string; state: string; hours: string | null;
  }>;

  const today = new Date().toISOString().slice(0, 10);
  const currentMonth = today.slice(0, 7);
  const [attendanceHistory, cashEmployee, cashRows, cashTotal] = await Promise.all([
    unifiedAttendance({employeeMobile: employee.employee_mobile, month: currentMonth, from: '2000-01-01', to: today}),
    getCashEmployeeSummary(employee.employee_mobile),
    listCashTransactions({employeeId: employee.employee_mobile, limit: 20, offset: 0}),
    countCashTransactions({employeeId: employee.employee_mobile}),
  ]);
  const cashInitial: CashEmployeePayload = {
    employee: cashEmployee ? {
      employeeId: cashEmployee.employee_mobile,
      nameOfEmployee: cashEmployee.name_of_employee,
      designation: cashEmployee.designation,
      dateOfJoin: cashEmployee.date_of_join,
      totalPayouts: Number(cashEmployee.total_payouts),
      totalPaid: cashEmployee.total_paid_minor,
      totalPaidMinor: cashEmployee.total_paid_minor,
    } : null,
    transactions: cashRows.map(cashTransactionView),
    total: cashTotal,
    page: 1,
    limit: 20,
    totalPages: Math.max(1, Math.ceil(cashTotal / 20)),
  };
  const joinDate = employee.date_of_join ?? employee.joined_on;

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
              <tr><th>Mobile</th><td>{displayMobile(employee.employee_mobile)}</td></tr>
              <tr><th>Designation</th><td>{employee.designation ?? '—'}</td></tr>
              <tr><th>Join date</th><td>{joinDate ? dateDdMmYyyy(joinDate) : '—'}</td></tr>
              <tr><th>Aliases</th><td>{employee.name_aliases.length ? employee.name_aliases.join(', ') : '—'}</td></tr>
              <tr><th>Alt mobile</th><td>{employee.alt_mobile ? displayMobile(employee.alt_mobile) : '—'}</td></tr>
              <tr><th>Home phone</th><td>{employee.home_phone ? displayMobile(employee.home_phone) : '—'}</td></tr>
              <tr><th>Present address</th><td>{employee.present_address ?? '—'}</td></tr>
              <tr><th>Permanent address</th><td>{employee.permanent_address ?? '—'}</td></tr>
              <tr><th>Reference</th><td>{employee.reference_name ?? '—'}{employee.reference_mobile ? ` · ${displayMobile(employee.reference_mobile)}` : ''}</td></tr>
              <tr><th>NID</th><td>{employee.nid_number ?? '—'}</td></tr>
              <tr><th>Birth certificate</th><td>{employee.birth_cert_number ?? '—'}</td></tr>
              <tr><th>Passport</th><td>{employee.passport_number ?? '—'}</td></tr>
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
              {name: 'dateOfJoin', label: 'Join date', type: 'date', defaultValue: joinDate ?? ''},
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
          <h3>Attendance history</h3>
          <div className="table-wrap" style={{overflowX: 'auto'}}>
            <table>
              <thead><tr><th>Date</th><th>Shift</th><th>Source</th><th>Location</th><th>Remarks</th></tr></thead>
              <tbody>
                {attendanceHistory.rows.map((entry, index) => (
                  <tr key={`${entry.source}-${entry.source_id}-${entry.shift}-${index}`}>
                    <td>{dateDdMmYyyy(String(entry.attendance_date))}</td>
                    <td>{String(entry.shift)}</td>
                    <td>{entry.source === 'VESSEL' ? 'Vessel' : 'Manual'}</td>
                    <td>{String(entry.location ?? '—')}</td>
                    <td>{String(entry.remarks ?? '—')}</td>
                  </tr>
                ))}
                {!attendanceHistory.rows.length ? <tr><td colSpan={5} className="muted">No attendance recorded.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <details style={{marginTop: 10}}>
            <summary className="muted">Legacy imported attendance ({legacyAttendance.length})</summary>
            <table>
              <thead><tr><th>Date</th><th>Shift</th><th>State</th><th>Hours</th></tr></thead>
              <tbody>
                {legacyAttendance.map((entry, index) => (
                  <tr key={`${entry.duty_date}-${entry.shift}-${index}`}>
                    <td>{dateDdMmYyyy(entry.duty_date)}</td><td>{entry.shift}</td><td>{entry.state}</td><td>{entry.hours ?? '—'}</td>
                  </tr>
                ))}
                {!legacyAttendance.length ? <tr><td colSpan={4} className="muted">No legacy attendance.</td></tr> : null}
              </tbody>
            </table>
          </details>
        </section>
      </div>

      <section className="card" style={{marginBottom: 18}}>
        <h3>Program history</h3>
        <div className="table-wrap" style={{overflowX: 'auto'}}>
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
        </div>
      </section>

      {/* Full cash payment history — the same component as /cash/employee/[employeeId]. */}
      <CashEmployeeHistory
        employeeId={employee.employee_mobile}
        initial={cashInitial}
        canManage={user.role === 'ADMIN' && user.capabilities.includes('cash.review')}
        generatedBy={user.displayName}
      />
    </>
  );
}
