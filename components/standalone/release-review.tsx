'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useMemo, useState} from 'react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {displayMobile} from '@/lib/display-mobile';
import {dateDdMmYyyy} from '@/lib/export-format';
import type {ReleaseSlipRow, ReleaseStatus} from '@/lib/standalone/release-slips';

const money = (minor: string | number | null | undefined) => {
  const value = Number(minor ?? 0);
  return `৳${(Number.isFinite(value) ? value / 100 : 0).toLocaleString('en-US', {minimumFractionDigits: 2})}`;
};

const plain = (value: unknown) => {
  const number = Number(value);
  return Number.isFinite(number) ? String(Number(number.toFixed(2))) : '0';
};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function MetricCard({label, value}: {label: string; value: string}) {
  return (
    <div className="ui-card">
      <div className="ui-card__label">{label}</div>
      <div className="ui-card__value">{value}</div>
    </div>
  );
}

const STATUS_LABEL: Record<ReleaseStatus, string> = {
  PENDING: 'Pending',
  APPROVED: 'Approved',
  DECLINED: 'Declined',
};

export function ReleaseReview({initial, canRelease}: {initial: ReleaseSlipRow[]; canRelease: boolean}) {
  const router = useRouter();
  const [rows, setRows] = useState<ReleaseSlipRow[]>(initial);
  const [busy, setBusy] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('');
  const [mother, setMother] = useState('');
  const [page, setPage] = useState(1);
  const limit = 20;

  const mothers = useMemo(
    () => [...new Set(rows.map((row) => row.motherVessel).filter(Boolean) as string[])].sort(),
    [rows],
  );

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (needle) {
        const haystack = [row.escortName, row.escortMobile, displayMobile(row.escortMobile)]
          .join(' ').toLowerCase();
        if (!haystack.includes(needle)) return false;
      }
      if (from && row.slipDate < from) return false;
      if (to && row.slipDate > to) return false;
      if (status && row.status !== status) return false;
      if (mother && row.motherVessel !== mother) return false;
      return true;
    });
  }, [rows, query, from, to, status, mother]);

  const thisMonth = new Date().toISOString().slice(0, 7);
  const inMonth = (row: ReleaseSlipRow) => row.slipDate.slice(0, 7) === thisMonth;
  const pending = rows.filter((row) => row.status === 'PENDING').length;
  const approvedMonth = rows.filter((row) => row.status === 'APPROVED' && inMonth(row)).length;
  const declinedMonth = rows.filter((row) => row.status === 'DECLINED' && inMonth(row)).length;
  const foodMonth = rows.filter(inMonth).reduce((sum, row) => sum + Number(row.foodBillMinor ?? 0), 0);
  const verified = rows.filter((row) => row.cashVerified).length;
  const missing = rows.filter((row) => row.escortMobile && row.endDate && !row.cashVerified).length;
  const dutyRows = rows.filter((row) => Number(row.dutyDays) > 0);
  const averageDuty = dutyRows.length
    ? dutyRows.reduce((sum, row) => sum + Number(row.dutyDays), 0) / dutyRows.length
    : 0;

  const pages = Math.max(1, Math.ceil(filtered.length / limit));
  const safePage = Math.min(page, pages);
  const pageRows = filtered.slice((safePage - 1) * limit, safePage * limit);

  async function decide(row: ReleaseSlipRow, action: 'approve' | 'decline') {
    let reason: string | undefined;
    if (action === 'decline') {
      reason = window.prompt('Reason for declining (optional):') ?? undefined;
    }
    setBusy(row.messageId);
    try {
      const token = await csrfToken();
      const response = await fetch('/api/release', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({messageId: row.messageId, action, reason}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setRows((current) => current.map((item) => item.messageId === row.messageId
        ? {...item, status: action === 'approve' ? 'APPROVED' : 'DECLINED'}
        : item));
      toast.success(action === 'approve' ? 'Release applied.' : 'Slip declined.');
      router.refresh();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Action failed.', {duration: Infinity});
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <AppToaster />
      <div className="ui-cards">
        <MetricCard label="Total Release Slips" value={plain(rows.length)} />
        <MetricCard label="Pending Review" value={plain(pending)} />
        <MetricCard label="Approved (This Month)" value={plain(approvedMonth)} />
        <MetricCard label="Declined (This Month)" value={plain(declinedMonth)} />
        <MetricCard label="Food Bill Total (This Month)" value={money(foodMonth)} />
        <MetricCard label="Payments Verified" value={plain(verified)} />
        <MetricCard label="Payments Missing" value={plain(missing)} />
        <MetricCard label="Average Duty Days" value={plain(averageDuty)} />
      </div>

      <div className="ui-filter-row">
        <label style={{flex: '1 1 220px'}}>Escort search
          <Input value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} placeholder="Name or mobile" aria-label="Escort search" />
        </label>
        <label>Date from
          <Input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} aria-label="Date from" />
        </label>
        <label>Date to
          <Input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} aria-label="Date to" />
        </label>
        <label>Status
          <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} className="vessel-select" aria-label="Status filter">
            <option value="">All</option>
            <option value="PENDING">Pending</option>
            <option value="APPROVED">Approved</option>
            <option value="DECLINED">Declined</option>
          </select>
        </label>
        <label>Mother vessel
          <select value={mother} onChange={(event) => { setMother(event.target.value); setPage(1); }} className="vessel-select" aria-label="Mother vessel filter">
            <option value="">All</option>
            {mothers.map((name) => <option key={name} value={name}>{name}</option>)}
          </select>
        </label>
      </div>

      <section className="card">
        <div className="table-wrap" style={{overflowX: 'auto'}}>
          <table className="cash-payment-table" style={{minWidth: 1280}}>
            <thead>
              <tr>
                <th style={{width: 48}}>SL</th>
                <th>Date</th>
                <th>Escort Mobile</th>
                <th>Escort Name</th>
                <th>Lighter Name</th>
                <th>Lighter Master</th>
                <th>Mother Vessel</th>
                <th>Start</th>
                <th>End</th>
                <th>Image Link</th>
                <th>View Messages</th>
                <th>Approved/Decline</th>
              </tr>
            </thead>
            <tbody>
              {pageRows.map((row, index) => (
                <tr key={row.messageId}>
                  <td style={{width: 48}}>{(safePage - 1) * limit + index + 1}</td>
                  <td style={{whiteSpace: 'nowrap'}}>
                    {dateDdMmYyyy(row.slipDate)}
                    {row.structured ? null : <div className="muted" style={{fontSize: 10}}>unstructured</div>}
                  </td>
                  <td style={{whiteSpace: 'nowrap'}}>
                    {row.escortMobile
                      ? <Link href={`/employees/${encodeURIComponent(`+88${row.escortMobile}`)}`}>{displayMobile(row.escortMobile)}</Link>
                      : <span className="muted">—</span>}
                  </td>
                  <td>
                    {row.escortMobile
                      ? <Link href={`/employees/${encodeURIComponent(`+88${row.escortMobile}`)}`}>{row.escortName ?? '—'}</Link>
                      : row.escortName ?? '—'}
                  </td>
                  <td>{row.lighterVessel ?? '—'}</td>
                  <td>{row.lighterMaster ? displayMobile(row.lighterMaster) : '—'}</td>
                  <td>{row.motherVessel ?? '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{row.startDate ? dateDdMmYyyy(row.startDate) : '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{row.endDate ? `${dateDdMmYyyy(row.endDate)}${row.endShift ? ` (${row.endShift})` : ''}` : '—'}</td>
                  <td>
                    {row.imageLink
                      ? <a href={row.imageLink} target="_blank" rel="noreferrer">Image</a>
                      : <span className="muted">—</span>}
                  </td>
                  <td><Link href={`/messages?q=${encodeURIComponent(row.messageId)}`}>Messages</Link></td>
                  <td>
                    <div className="row-actions" style={{alignItems: 'center'}}>
                      {row.status === 'PENDING' && canRelease ? (
                        <>
                          <Button type="button" size="sm" disabled={busy === row.messageId}
                            onClick={() => void decide(row, 'approve')}>Approve</Button>
                          <Button type="button" size="sm" variant="outline" disabled={busy === row.messageId}
                            onClick={() => void decide(row, 'decline')}>Decline</Button>
                        </>
                      ) : (
                        <span className={`pill ${row.status === 'APPROVED' ? 'ok' : row.status === 'DECLINED' ? 'bad' : 'warn'}`}>
                          {STATUS_LABEL[row.status]}
                        </span>
                      )}
                      <span className={`pill ${row.cashVerified ? 'ok' : 'warn'}`} title={row.cashVerified ? 'Cash payment found on the release day or the day after' : 'No cash payment found'}>
                        {row.cashVerified ? `Payment verified ${money(row.cashAmountMinor)}` : 'No payment found'}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
              {!pageRows.length ? <tr><td colSpan={12} className="muted">No release slips match these filters.</td></tr> : null}
            </tbody>
          </table>
        </div>

        <div className="row-actions cash-pagination" style={{marginTop: 12, justifyContent: 'space-between'}}>
          <div className="row-actions" style={{gap: 8}}>
            <Button type="button" size="sm" variant="outline" disabled={safePage <= 1} onClick={() => setPage(safePage - 1)}>← Previous</Button>
            <span className="muted">Page {safePage} / {pages}</span>
            <Button type="button" size="sm" variant="outline" disabled={safePage >= pages} onClick={() => setPage(safePage + 1)}>Next →</Button>
          </div>
          <span className="muted">{filtered.length.toLocaleString()} slips</span>
        </div>
      </section>
    </>
  );
}
