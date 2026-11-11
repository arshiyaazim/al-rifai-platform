'use client';

import Link from 'next/link';
import {useEffect, useRef, useState} from 'react';
import {cleanEmployeeName} from '@/lib/display-name';
import {vesselStateTone} from '@/lib/status-tone';

type Props = {
  programId: string;
  motherVessel: string;
  lighterVessel: string;
  masterName?: string | null;
  masterMobile?: string | null;
  escortName?: string | null;
  escortMobile?: string | null;
  startDate: string;
  startShift: string;
  endDate?: string | null;
  endShift?: string | null;
  state: string;
};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);

/**
 * Sticky program summary. The full card is normal page content; once it
 * scrolls past the top it condenses into a single line so the table below
 * keeps its vertical space. IntersectionObserver drives the transition.
 */
export function ProgramStickySummary(props: Props) {
  const [stuck, setStuck] = useState(false);
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = sentinel.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(
      ([entry]) => setStuck(!entry.isIntersecting),
      {threshold: 0, rootMargin: '-1px 0px 0px 0px'},
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const statePill = <span className={`pill ${vesselStateTone(props.state)}`}>{props.state}</span>;

  return (
    <>
      <div ref={sentinel} className="program-summary-sentinel" aria-hidden="true" />
      <section className={`card program-summary ${stuck ? 'is-stuck' : ''}`} aria-label="Program summary">
        <div className="program-summary__full">
          <div className="program-summary__heading">
            <div>
              <div className="program-summary__eyebrow">Program summary</div>
              <strong>{props.motherVessel} → {props.lighterVessel}</strong>
            </div>
            {statePill}
          </div>
          <dl className="program-summary__grid">
            <div><dt>Lighter</dt><dd>{props.lighterVessel}</dd></div>
            <div><dt>Master</dt><dd>{dash(props.masterName ?? props.masterMobile)}</dd></div>
            <div><dt>Escort</dt><dd>{cleanEmployeeName(props.escortName)}{props.escortMobile ? ` · ${props.escortMobile}` : ''}</dd></div>
            <div><dt>Start</dt><dd>{props.startDate} · {props.startShift}</dd></div>
            <div><dt>End</dt><dd>{props.endDate ? `${props.endDate} · ${props.endShift ?? '—'}` : '—'}</dd></div>
          </dl>
          <div className="program-summary__actions">
            <a className="button-link" href="#program-edit">Edit</a>
            <Link className="button-link" href="/vessel">All Programs</Link>
            <Link className="button-link" href={`/vessel/drafts?program=${encodeURIComponent(props.programId)}`}>Order drafts</Link>
          </div>
        </div>
        <div className="program-summary__condensed">
          <span className="program-summary__condensed-title">{props.motherVessel} → {props.lighterVessel}</span>
          {statePill}
          <span className="muted">{props.startDate} · {props.startShift}{props.endDate ? ` → ${props.endDate} · ${props.endShift ?? '—'}` : ''}</span>
          <a className="button-link" href="#program-edit">Edit</a>
          <Link className="button-link" href="/vessel">All Programs</Link>
        </div>
      </section>
    </>
  );
}
