'use client';

import {useEffect, useMemo, useState} from 'react';
import {Eye, Plus} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {EmployeeDetailSidebar} from '@/components/standalone/employee-detail-sidebar';

type SummaryRow = {
  employee_mobile: string;
  preferred_name: string;
  date_of_join: string | null;
  designation: string | null;
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

export function EmployeesSummaryTable({canManage}: {canManage: boolean}) {
  const [rows, setRows] = useState<SummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<{key: SortKey; dir: 'asc' | 'desc'}>({key: 'preferred_name', dir: 'asc'});
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

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((left, right) => {
      const a = left[sort.key] ?? '';
      const b = right[sort.key] ?? '';
      const numeric = ['total_attendance', 'salary_minor', 'cash_paid_minor', 'due_minor'].includes(sort.key);
      const result = numeric ? Number(a) - Number(b) : String(a).localeCompare(String(b));
      return sort.dir === 'asc' ? result : -result;
    });
    return copy;
  }, [rows, sort]);

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

  return (
    <>
      <div className="page-head" style={{marginBottom: 8}}>
        <div><h3 style={{margin: 0}}>Directory ({rows.length})</h3></div>
        {canManage ? (
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}><Plus className="size-4" />Add New Employee</Button>
        ) : null}
      </div>

      {error ? <p role="alert" style={{color: '#b91c1c'}}>{error}</p> : null}

      <div className="table-wrap" style={{overflowX: 'auto'}}>
        <table className="cash-payment-table" style={{minWidth: 980}}>
          <thead>
            <tr>
              <th>SL</th>
              {header('employee_mobile', 'Employee ID')}
              {header('preferred_name', 'Employee Name')}
              {header('date_of_join', 'Date of Join')}
              {header('designation', 'Designation')}
              {header('total_attendance', 'Total Attendance', 'right')}
              {header('salary_minor', 'Salary', 'right')}
              {header('cash_paid_minor', 'Cash Paid', 'right')}
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
                  <td>{(safePage - 1) * limit + index + 1}</td>
                  <td>{row.employee_mobile}</td>
                  <td>{row.preferred_name}</td>
                  <td>{row.date_of_join ?? '—'}</td>
                  <td>{row.designation ?? '—'}</td>
                  <td style={{textAlign: 'right'}}>{Number(row.total_attendance).toFixed(2)}</td>
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
