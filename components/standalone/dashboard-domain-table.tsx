import Link from 'next/link';
import {Eye} from 'lucide-react';
import {displayMobile} from '@/lib/display-mobile';
import {cleanEmployeeName} from '@/lib/display-name';
import {dateDdMmYyyy, dhakaTime12} from '@/lib/export-format';
import {money} from '@/lib/standalone/session';
import type {DashboardEmployeeRow, DashboardDomain, DashboardPeriod} from '@/lib/standalone/dashboard';
import type {CashTransaction} from '@/components/standalone/cash-transactions-table';
import type {ProgramListRow} from '@/lib/standalone/programs';

const withMv = (value: string | null | undefined) => {
  const name = String(value ?? '').trim();
  if (!name) return '—';
  return /^m\.?\s*v\.?\s+/i.test(name) ? name : `MV ${name}`;
};

function dateDmy(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(date).reduce<Record<string, string>>((acc, part) => {
    acc[part.type] = part.value;
    return acc;
  }, {});
  return `${parts.day}.${parts.month}.${parts.year}`;
}

const shift = (date: string | null | undefined, value: string | null | undefined) => {
  const rendered = dateDmy(date);
  return rendered === '—' ? '—' : `${rendered}(${value || '—'})`;
};

const attendance = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Number(number.toFixed(2)));
};

const amount = (minor: string | number | null | undefined) => {
  if (minor === null || minor === undefined || minor === '') return '—';
  const value = Number(minor);
  return Number.isFinite(value) ? `৳${(value / 100).toLocaleString('en-US', {minimumFractionDigits: 2})}` : '—';
};

const payCells = (row: ProgramListRow) => {
  const shifts = row.shifts === null || row.shifts === undefined ? null : Number(row.shifts);
  return {
    days: shifts === null ? '—' : (shifts / 2).toFixed(2),
    salary: row.salary_minor === null ? '—' : amount(row.salary_minor),
    conveyance: row.conveyance_minor === null ? '—' : amount(row.conveyance_minor),
    total: row.total_minor === null ? '—' : amount(row.total_minor),
  };
};

export function DashboardEmployeesTable({rows}: {rows: DashboardEmployeeRow[]}) {
  return (
    <div className="table-wrap" style={{overflowX: 'auto'}}>
      <table className="cash-payment-table" style={{minWidth: 980}}>
        <thead>
          <tr>
            <th style={{width: 48}}>SL</th><th>Employee ID</th><th>Name</th><th>Join Date</th>
            <th>Designation</th><th style={{textAlign: 'right'}}>Attendance</th>
            <th style={{textAlign: 'right'}}>Salary</th><th style={{textAlign: 'right'}}>Paid</th>
            <th style={{textAlign: 'right'}}>Due</th><th><span className="sr-only">View</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const due = Number(row.due_minor);
            return (
              <tr key={row.employee_mobile}>
                <td style={{width: 48}}>{index + 1}</td>
                <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`}>{displayMobile(row.employee_mobile)}</Link></td>
                <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`}>{row.preferred_name}</Link></td>
                <td>{row.date_of_join ?? '—'}</td>
                <td>{row.designation ?? '—'}</td>
                <td style={{textAlign: 'right'}}>{attendance(row.total_attendance)}</td>
                <td style={{textAlign: 'right'}}>{money(row.salary_minor)}</td>
                <td style={{textAlign: 'right'}}>{money(row.cash_paid_minor)}</td>
                <td style={{textAlign: 'right', color: due > 0 ? '#b91c1c' : '#15803d', fontWeight: 600}}>{money(row.due_minor)}</td>
                <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`} aria-label={`View ${row.preferred_name}`}><Eye className="size-4" /></Link></td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={10} className="muted">No employees for this period.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export type DashboardAttendanceRow = {
  source_id: string; employee_mobile: string; preferred_name: string | null;
  attendance_date: string; shift: string; location: string | null; client_name: string | null;
  designation: string | null; remarks: string | null; source: 'VESSEL' | 'NON_VESSEL';
};

export function DashboardAttendanceTable({rows}: {rows: DashboardAttendanceRow[]}) {
  return (
    <div className="table-wrap" style={{overflowX: 'auto'}}>
      <table className="cash-payment-table" style={{minWidth: 1100}}>
        <thead>
          <tr>
            <th style={{width: 96}}>Date</th><th>Employee ID</th><th>Employee Name</th>
            <th style={{width: 56}}>Shift</th><th>Location</th><th>Client</th><th>Designation</th>
            <th>Remarks</th><th>Source</th><th><span className="sr-only">View</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.source}-${row.source_id}-${row.shift}`}>
              <td style={{whiteSpace: 'nowrap'}}>{dateDdMmYyyy(row.attendance_date)}</td>
              <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`}>{displayMobile(row.employee_mobile)}</Link></td>
              <td>{row.preferred_name ?? '—'}</td>
              <td>{row.shift}</td>
              <td>{row.location ?? '—'}</td>
              <td>{row.client_name ?? '—'}</td>
              <td>{row.designation ?? '—'}</td>
              <td style={{maxWidth: 220, whiteSpace: 'pre-wrap'}}>{row.remarks ?? '—'}</td>
              <td><span className="pill" style={row.source === 'VESSEL' ? {background: '#dbeafe', color: '#1e3a8a'} : {background: '#dcfce7', color: '#166534'}}>{row.source === 'VESSEL' ? '🚢 Vessel' : '📋 Non-Vessel'}</span></td>
              <td><Link href="/attendance" aria-label="Open attendance"><Eye className="size-4" /></Link></td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={10} className="muted">No attendance for this period.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardCashTable({rows}: {rows: CashTransaction[]}) {
  return (
    <div className="cash-table-scroll">
      <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 940}}>
        <colgroup>
          <col style={{width: 88}} /><col style={{width: 110}} /><col style={{width: 180}} />
          <col style={{width: 120}} /><col style={{width: 100}} /><col style={{width: 70}} />
          <col style={{width: 100}} /><col style={{width: 100}} /><col style={{width: 50}} />
        </colgroup>
        <thead>
          <tr>
            <th>Date</th><th>Employee ID</th><th>Name</th><th>Designation</th><th>Date of Join</th>
            <th style={{textAlign: 'center'}}>Payouts</th><th style={{textAlign: 'right'}}>Amount</th>
            <th style={{textAlign: 'right'}}>Total Paid</th><th><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="cash-date"><div>{dateDdMmYyyy(row.eventAt)}</div><small className="muted">{dhakaTime12(row.eventAt)}</small></td>
              <td>{row.employeeId ? <Link href={`/employees/${encodeURIComponent(row.employeeId)}`}>{displayMobile(row.employeeId)}</Link> : '—'}</td>
              <td>{cleanEmployeeName(row.nameOfEmployee) || '—'}</td>
              <td>{row.designation ?? '—'}</td>
              <td>{row.dateOfJoin ? dateDdMmYyyy(row.dateOfJoin) : '—'}</td>
              <td style={{textAlign: 'center'}}>{row.payoutNumber}</td>
              <td className="cash-amount" style={{textAlign: 'right'}}>{amount(row.amountMinor)}</td>
              <td className="cash-amount" style={{textAlign: 'right'}}>{amount(row.totalPaidMinor)}</td>
              <td style={{textAlign: 'center'}}><Link href={`/cash/${encodeURIComponent(row.id)}`} aria-label="Open cash transaction"><Eye className="size-4" /></Link></td>
            </tr>
          ))}
          {!rows.length ? <tr><td colSpan={9} className="muted">No payments for this period.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardVesselTable({rows}: {rows: ProgramListRow[]}) {
  return (
    <div className="vessel-table-wrap">
      <table className="cash-payment-table vessel-register-table" style={{tableLayout: 'fixed', minWidth: 920}}>
        <colgroup>
          <col style={{width: 32}} /><col style={{width: 64}} /><col style={{width: 120}} /><col style={{width: 120}} />
          <col style={{width: 130}} /><col style={{width: 90}} /><col style={{width: 90}} />
          <col style={{width: 45}} /><col style={{width: 60}} /><col style={{width: 55}} />
          <col style={{width: 60}} /><col style={{width: 35}} />
        </colgroup>
        <thead>
          <tr>
            <th style={{width: 32}}>SL</th><th>Date</th><th>Mother Vessel</th><th>Lighter Vessel</th>
            <th>Escort Name</th><th>Start</th><th>End</th><th className="num">Days</th>
            <th className="num">Salary</th><th className="num">Conv.</th><th className="num">Total</th><th><span className="sr-only">View</span></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const pay = payCells(row);
            return (
              <tr key={row.id}>
                <td style={{width: 32}}>{index + 1}</td>
                <td>{dateDmy(row.event_at)}</td>
                <td className="vessel-ellipsis" title={row.mother_vessel}>{withMv(row.mother_vessel)}</td>
                <td className="vessel-ellipsis" title={row.lighter_vessel ?? undefined}>
                  <div>{withMv(row.lighter_vessel)}</div>
                  {row.master_mobile ? <small className="muted">{displayMobile(row.master_mobile)}</small> : null}
                </td>
                <td className="vessel-escort-cell">
                  <strong className="vessel-ellipsis" style={{fontSize: 14, fontWeight: 600}}>{cleanEmployeeName(row.escort_name) || '—'}</strong>
                  <small>{row.escort_mobile ? displayMobile(row.escort_mobile) : '—'}</small>
                </td>
                <td>{shift(row.start_date, row.start_shift)}</td>
                <td>{shift(row.end_date, row.end_shift)}</td>
                <td className="num">{pay.days}</td><td className="num">{pay.salary}</td>
                <td className="num">{pay.conveyance}</td><td className="num">{pay.total}</td>
                <td><Link href={`/vessel/${encodeURIComponent(row.id)}`} aria-label={`View ${row.lighter_vessel}`}><Eye className="size-4" /></Link></td>
              </tr>
            );
          })}
          {!rows.length ? <tr><td colSpan={12} className="muted">No vessels for this period.</td></tr> : null}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPagination({
  domain, period, page, total, limit = 20,
}: {
  domain: DashboardDomain;
  period: DashboardPeriod;
  page: number;
  total: number;
  limit?: number;
}) {
  const pages = Math.max(1, Math.ceil(total / limit));
  if (pages <= 1) return null;
  const href = (next: number) => `/home?domain=${domain}&period=${period}&page=${next}`;
  return (
    <div className="dashboard-pagination">
      <Link href={href(Math.max(1, page - 1))} aria-disabled={page <= 1} className={page <= 1 ? 'is-disabled' : ''}>← Previous</Link>
      <span className="muted">Page {page} / {pages}</span>
      <Link href={href(Math.min(pages, page + 1))} aria-disabled={page >= pages} className={page >= pages ? 'is-disabled' : ''}>Next →</Link>
    </div>
  );
}
