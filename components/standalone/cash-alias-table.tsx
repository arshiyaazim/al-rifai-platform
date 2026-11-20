'use client';

import {useState} from 'react';
import Link from 'next/link';
import {Button} from '@/components/ui/button';
import {displayMobile} from '@/lib/display-mobile';
import type {CashAliasRow} from '@/lib/standalone/finance';

type Payload = {
  rows: CashAliasRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

const amount = (minor: string | number | null | undefined) =>
  minor === null || minor === undefined ? '—'
    : `৳${(Number(minor) / 100).toLocaleString('en-IN', {minimumFractionDigits: 2})}`;

export function CashAliasTable({initial}: {initial: Payload}) {
  const [data, setData] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function load(page: number) {
    setLoading(true);
    setError('');
    try {
      const response = await fetch(`/api/cash/aliases?page=${page}&limit=${data.limit}`, {
        headers: {accept: 'application/json'}, cache: 'no-store',
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setData(body as Payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Alias table could not be loaded.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section className="card" style={{marginTop: 18}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Name Aliases ({data.total})</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>
            Same Employee ID with a different name, and the same/similar name under different Employee IDs.
            The main Cash table still keeps one row per Employee ID.
          </p>
        </div>
      </div>

      {error ? <div className="error" role="alert">{error}</div> : null}

      <div className="cash-table-scroll">
        <table className="cash-payment-table" style={{tableLayout: 'fixed', minWidth: 980}}>
          <colgroup>
            <col style={{width: 48}} /><col style={{width: 125}} /><col style={{width: 170}} />
            <col style={{width: 170}} /><col style={{width: 175}} /><col style={{width: 70}} />
            <col style={{width: 105}} />
          </colgroup>
          <thead>
            <tr>
              <th>SL</th><th>Employee ID</th><th>Main Name</th><th>Alias / Matched Name</th>
              <th>Matched Employee ID</th><th style={{textAlign: 'center'}}>Payouts</th>
              <th style={{textAlign: 'right'}}>Total Paid</th>
            </tr>
          </thead>
          <tbody>
            {loading ? <tr><td colSpan={7} className="muted">Loading aliases…</td></tr> : null}
            {!loading && data.rows.map((row, index) => (
              <tr key={`${row.kind}-${row.employeeId}-${row.aliasName}-${row.otherEmployeeId ?? ''}`}>
                <td>{(data.page - 1) * data.limit + index + 1}</td>
                <td>{displayMobile(row.employeeId)}</td>
                <td>
                  <Link href={`/cash/employee/${encodeURIComponent(row.employeeId)}`}>{row.preferredName}</Link>
                </td>
                <td>{row.aliasName}</td>
                <td>
                  {row.otherEmployeeId
                    ? <Link href={`/cash/employee/${encodeURIComponent(row.otherEmployeeId)}`}>{displayMobile(row.otherEmployeeId)}</Link>
                    : <span className="muted">same ID</span>}
                </td>
                <td style={{textAlign: 'center'}}>{row.payouts + row.otherPayouts}</td>
                <td style={{textAlign: 'right'}}>{amount(Number(row.totalPaidMinor) + Number(row.otherTotalPaidMinor))}</td>
              </tr>
            ))}
            {!loading && !data.rows.length ? (
              <tr><td colSpan={7} className="muted">No name aliases recorded yet.</td></tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="row-actions" style={{marginTop: 12, justifyContent: 'space-between'}}>
        <Button type="button" size="sm" variant="outline" disabled={loading || data.page <= 1} onClick={() => void load(data.page - 1)}>← Previous</Button>
        <span className="muted">Page {data.page} / {data.totalPages}</span>
        <Button type="button" size="sm" variant="outline" disabled={loading || data.page >= data.totalPages} onClick={() => void load(data.page + 1)}>Next →</Button>
      </div>
    </section>
  );
}
