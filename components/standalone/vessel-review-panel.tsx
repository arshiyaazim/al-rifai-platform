'use client';

import {useState} from 'react';
import {useRouter} from 'next/navigation';
import {Eye} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {displayMobile} from '@/lib/display-mobile';
import {cleanEmployeeName} from '@/lib/display-name';
import type {UnifiedVesselReview} from '@/lib/standalone/vessel-review';
import {VesselReviewSidebar} from '@/components/standalone/vessel-review-sidebar';

const withMv = (value: string) => {
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

const shift = (date: string, value: string) => {
  const rendered = dateDmy(date);
  return rendered === '—' ? '—' : `${rendered}(${value || '—'})`;
};

export function VesselReviewPanel({
  rows, mothers, lighters, escortNames, escortMobiles, canDecide,
}: {
  rows: UnifiedVesselReview[];
  mothers: string[];
  lighters: string[];
  escortNames: string[];
  escortMobiles: string[];
  canDecide: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<UnifiedVesselReview | null>(null);

  return (
    <section className="card" style={{marginBottom: 18, padding: 14}}>
      <div className="page-head" style={{marginBottom: 8}}>
        <div>
          <h3 style={{margin: 0}}>Vessel Review ({rows.length})</h3>
          <p className="muted" style={{margin: '4px 0 0'}}>
            Pending parser failures and USER submissions. Approve writes the program and removes the row.
          </p>
        </div>
      </div>

      {!rows.length ? <p className="muted" style={{margin: 0}}>No pending vessel review items.</p> : (
        <div className="vessel-table-wrap">
          <table className="cash-payment-table vessel-register-table" style={{tableLayout: 'fixed', minWidth: 920}}>
            <colgroup>
              <col style={{width: 32}} />
              <col style={{width: 64}} /><col style={{width: 120}} /><col style={{width: 120}} />
              <col style={{width: 130}} /><col style={{width: 90}} /><col style={{width: 90}} />
              <col style={{width: 45}} /><col style={{width: 60}} /><col style={{width: 55}} />
              <col style={{width: 60}} /><col style={{width: 35}} />
            </colgroup>
            <thead>
              <tr>
                <th style={{width: 32}}>SL</th>
                <th>Date</th><th>Mother Vessel</th><th>Lighter Vessel</th><th>Escort Name</th>
                <th>Start</th><th>End</th><th className="num">Days</th><th className="num">Salary</th>
                <th className="num">Conv.</th><th className="num">Total</th><th><span className="sr-only">View</span></th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr key={`${row.kind}-${row.id}`} title={row.problem}>
                  <td style={{width: 32}}>{index + 1}</td>
                  <td>{dateDmy(row.timestamp)}</td>
                  <td className="vessel-ellipsis" title={row.fields.motherVessel}>{withMv(row.fields.motherVessel)}</td>
                  <td className="vessel-ellipsis" title={row.fields.lighterVessel ?? undefined}>
                    <div>{withMv(row.fields.lighterVessel)}</div>
                    {row.fields.masterMobile ? <small className="muted">{displayMobile(row.fields.masterMobile)}</small> : null}
                  </td>
                  <td className="vessel-escort-cell">
                    <strong className="vessel-ellipsis" style={{fontSize: 14, fontWeight: 600}}>{cleanEmployeeName(row.fields.escortName) || '—'}</strong>
                    <small>{row.fields.escortMobile ? displayMobile(row.fields.escortMobile) : '—'}</small>
                  </td>
                  <td>{shift(row.fields.startDate, row.fields.shift)}</td>
                  <td>{shift(row.fields.endDate, row.fields.endShift)}</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                  <td className="num">—</td>
                  <td>
                    <Button type="button" size="icon-sm" variant="ghost" aria-label="View vessel review item" onClick={() => setSelected(row)}>
                      <Eye className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <VesselReviewSidebar
        key={selected?.id ?? 'none'}
        row={selected}
        onClose={() => setSelected(null)}
        onDone={() => { setSelected(null); router.refresh(); }}
        canDecide={canDecide}
        mothers={mothers}
        lighters={lighters}
        escortNames={escortNames}
        escortMobiles={escortMobiles}
      />
    </section>
  );
}
