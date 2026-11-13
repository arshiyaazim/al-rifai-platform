'use client';

import Link from 'next/link';
import {useEffect, useMemo, useState} from 'react';
import {Eye, Plus} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {EmployeeDetailSidebar} from '@/components/standalone/employee-detail-sidebar';
import {displayMobile} from '@/lib/display-mobile';

type SummaryRow = {
  employee_mobile: string;
  preferred_name: string;
  date_of_join: string | null;
  designation: string | null;
  vessel_attendance?: string;
  non_vessel_attendance?: string;
  security_attendance?: string;
  total_attendance: string;
  salary_minor: string;
  cash_paid_minor: string;
  due_minor: string;
};

type SortKey = keyof Pick<SummaryRow, 'employee_mobile' | 'preferred_name' | 'date_of_join' | 'designation' | 'total_attendance' | 'salary_minor' | 'cash_paid_minor' | 'due_minor'>;

const money = (minor: unknown) => {
  const value = Number(minor ?? 0);
  return `৳${(Number.isFinite(value) ? value / 100 : 0).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
};

/** Attendance is a plain number: 3.5 → "3.5", 3 → "3", none → "0". */
const attendance = (value: unknown) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return '0';
  return String(Number(number.toFixed(2)));
};

const sum = (rows: SummaryRow[], key: keyof SummaryRow) =>
  rows.reduce((total, row) => total + (Number(row[key] ?? 0) || 0), 0);

const monthKey = (date: Date) => `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const todayIso = () => new Date().toISOString().slice(0, 10);

function MetricCard({label, value, href, missing}: {label: string; value: string; href?: string; missing?: boolean}) {
  const body = (
    <>
      <div className="ui-card__label">{label}</div>
      <div className={missing ? 'ui-card__value ui-card__value--missing' : 'ui-card__value'}>{value}</div>
    </>
  );
  return href
    ? <Link href={href} className="ui-card">{body}</Link>
    : <div className="ui-card">{body}</div>;
}

export function EmployeesSummaryTable({canManage}: {canManage: boolean}) {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{key: SortKey; dir: 'asc' | 'desc'}>({key: 'preferred_name', dir: 'asc'});
  const [query, setQuery] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const limit = 20;

  async function load() {
    setLoading(true);
    setError('');
    try {
      const response = await fetch('/api/employees/summary', {cache: 'no-store'});
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setRows(body.rows as SummaryRow[]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not load employees.');
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- the initial read is an async fetch; setState runs after await.
  useEffect(() => { void load(); }, []);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- any filter change must return the table to page 1.
  useEffect(() => { setPage(1); }, [query, fromDate, toDate]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle) {
        const haystack = [row.preferred_name, row.employee_mobile, displayMobile(row.employee_mobile)]
          .join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      const joined = row.date_of_join ? String(row.date_of_join).slice(0, 10) : '';
      if (fromDate && (!joined || joined < fromDate)) return false;
      if (toDate && (!joined || joined > toDate)) return false;
      return true;
    });
  }, [rows, query, fromDate, toDate]);

  const sorted = useMemo(() => {
    const copy = [...filtered];
    copy.sort((left, right) => {
      const a = left[sort.key] ?? '';
      const b = right[sort.key] ?? '';
      const numeric = ['total_attendance', 'salary_minor', 'cash_paid_minor', 'due_minor'].includes(sort.key);
      const result = numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b));
      return sort.dir === 'asc' ? result : -result;
    });
    return copy;
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = sorted.slice((safePage - 1) * limit, safePage * limit);

  const changeSort = (key: SortKey) => {
    setSort((current) => current.key === key
      ? {key, dir: current.dir === 'asc' ? 'desc' : 'asc'}
      : {key, dir: 'asc'});
    setPage(1);
  };
  const header = (key: SortKey, label: string, align?: 'right') => (
    <th style={align ? {textAlign: 'right', cursor: 'pointer'} : {cursor: 'pointer'}} onClick={() => changeSort(key)}>
      {label}{sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''}
    </th>
  );

  // Card figures come from the same /api/employees/summary payload that fills
  // the table: employees (ACTIVE) + employees.date_of_join (joined_on fallback),
  // program_assignments/program_pay (vessel days), cash_postings (paid).
  const now = new Date();
  const thisMonth = monthKey(now);
  const lastMonthDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const lastMonth = monthKey(lastMonthDate);
  const today = todayIso();
  const joinedIn = (month: string) => rows.filter((row) => String(row.date_of_join ?? '').slice(0, 7) === month).length;
  const joinedToday = rows.filter((row) => String(row.date_of_join ?? '').slice(0, 10) === today).length;
  const vesselDays = sum(rows, 'vessel_attendance');
  const securityDays = sum(rows, 'security_attendance');
  const salaryTotal = sum(rows, 'salary_minor');
  const paidTotal = sum(rows, 'cash_paid_minor');

  return (
    <>
      <div className="ui-cards">
        <MetricCard label="Total Employee" value={rows.length.toLocaleString()} href="/employees" />
        <MetricCard label="New Join: Last Month" value={joinedIn(lastMonth).toLocaleString()} />
        <MetricCard label="New Join: This Month" value={joinedIn(thisMonth).toLocaleString()} />
        <MetricCard label="Today Joined" value={joinedToday.toLocaleString()} />
        <MetricCard label="Total Attendance: Vessel" value={attendance(vesselDays)} />
        <MetricCard label="Total Attendance: Security" value={attendance(securityDays)} />
        <MetricCard label="Total Salary" value={money(salaryTotal)} />
        <MetricCard label="Total Paid" value={money(paidTotal)} href="/cash" />
      </div>

      <div className="ui-filter-row">
        <label style={{flex: '1 1 240px'}}>Employee search
          <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Name or mobile" aria-label="Employee search" />
        </label>
        <label>Join date from
          <Input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} aria-label="Join date from" />
        </label>
        <label>Join date to
          <Input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} aria-label="Join date to" />
        </label>
        {canManage ? (
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />Add New Employee</Button>
        ) : null}
      </div>

      <div className="page-head" style={{marginBottom: 8}}>
        <div><h3 style={{margin: 0}}>Directory ({filtered.length})</h3></div>
      </div>

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

      <div className="table-wrap" style={{overflowX: 'auto'}}>
        <table className="cash-payment-table" style={{minWidth: 980}}>
          <thead>
            <tr>
              <th style={{width: 48}}>SL</th>
              {header('employee_mobile', 'Employee ID')}
              {header('preferred_name', 'Name')}
              {header('date_of_join', 'Join Date')}
              {header('designation', 'Designation')}
              {header('total_attendance', 'Attendance', 'right')}
              {header('salary_minor', 'Salary', 'right')}
              {header('cash_paid_minor', 'Paid', 'right')}
              {header('due_minor', 'Due', 'right')}
              <th><span className="sr-only">View</span></th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={10} className="muted">Loading employees…</td></tr> : null}
            {!loading && pageRows.map((row, index) => {
              const due = Number(row.due_minor);
              return (
                <tr key={row.employee_mobile}>
                  <td style={{width: 48}}>{(safePage - 1) * limit + index + 1}</td>
                  <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`}>{displayMobile(row.employee_mobile)}</Link></td>
                  <td><Link href={`/employees/${encodeURIComponent(row.employee_mobile)}`}>{row.preferred_name}</Link></td>
                  <td>{row.date_of_join ?? '—'}</td>
                  <td>{row.designation ?? '—'}</td>
                  <td style={{textAlign: 'right'}}>{attendance(row.total_attendance)}</td>
                  <td style={{textAlign: 'right'}}>{money(row.salary_minor)}</td>
                  <td style={{textAlign: 'right'}}>{money(row.cash_paid_minor)}</td>
                  <td style={{textAlign: 'right', color: due > 0 ? '#b91c1c' : '#15803d', fontWeight: 600}}>{money(row.due_minor)}</td>
                  <td>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label={`View ${row.preferred_name}`} onClick={() => setSelected(row.employee_mobile)}>
                      <Eye className="size-4" />
                    </Button>
                  </td>
                </tr>
              );
            })}
            {!loading && !pageRows.length ? <tr><td colSpan={10} className="muted">No employees yet.</td></tr> : null}
          </tbody>
        </table>
      </div>

      <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
        <div className="row-actions" style={{gap: 8}}>
          <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
          <span className="muted">Page {safePage} / {pages}</span>
          <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
        </div>
        <span className="muted">Daily rate ৳400.00 · Salary = attendance × 400</span>
      </div>

      <EmployeeDetailSidebar
        key={selected ?? 'view-none'}
        mobile={selected}
        mode="view"
        onClose={() => setSelected(null)}
        onUpdated={() => void load()}
        canManage={canManage}
      />
      {createOpen ? (
        <EmployeeDetailSidebar
          key="create"
          mobile={null}
          mode="create"
          onClose={() => setCreateOpen(false)}
          onUpdated={() => void load()}
          canManage={canManage}
        />
      ) : null}
    </>
  );
}
