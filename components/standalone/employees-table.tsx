'use client';

import {displayMobile} from '@/lib/display-mobile';
import Link from 'next/link';
import {useState} from 'react';
import {Eye} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {EmployeeDetailSidebar} from '@/components/standalone/employee-detail-sidebar';

export type EmployeeRowView = {
  employee_mobile: string;
  preferred_name: string;
  duty_type: string | null;
  state: string;
  programs: string;
  attendance_days: string;
};

export function EmployeesTable({rows, canManage}: {rows: EmployeeRowView[]; canManage: boolean}) {
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      <table>
        <thead>
          <tr><th>Name</th><th>Mobile</th><th>Type</th><th>Status</th><th>Programs</th><th>Days</th><th><span className="sr-only">View</span></th></tr>
        </thead>
        <tbody>
          {rows.map((employee) => (
            <tr key={employee.employee_mobile}>
              <td><Link href={`/employees/${encodeURIComponent(employee.employee_mobile)}`}>{employee.preferred_name}</Link></td>
              <td>{displayMobile(employee.employee_mobile)}</td>
              <td>{employee.duty_type ?? '—'}</td>
              <td><span className={`pill ${employee.state === 'ACTIVE' ? 'ok' : 'warn'}`}>{employee.state}</span></td>
              <td>{employee.programs}</td>
              <td>{employee.attendance_days}</td>
              <td>
                <Button type="button" size="icon-sm" variant="ghost"
                  aria-label={`View ${employee.preferred_name}`} onClick={() => setSelected(employee.employee_mobile)}>
                  <Eye className="size-4" />
                </Button>
              </td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={7} className="muted">No employees yet.</td></tr> : null}
        </tbody>
      </table>
      <EmployeeDetailSidebar
        key={selected ?? 'none'}
        mobile={selected}
        onClose={() => setSelected(null)}
        onUpdated={() => window.location.reload()}
        canManage={canManage}
      />
    </>
  );
}
