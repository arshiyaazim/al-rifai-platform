'use client';

import {useEffect, useRef, useState} from 'react';
import {useRouter} from 'next/navigation';
import {EmployeeLookup, type EmployeeSuggestion, type RankedResult} from '@/components/standalone/employee-lookup';
import {compactTaka} from '@/lib/format-money';

type SummaryRow = {employee_mobile: string; cash_paid_minor: string};

/**
 * Homepage employee search — one field, no search-type selector.
 *
 * Suggestions come from the existing employee lookup endpoint (name, alias or
 * partial mobile/Employee ID). The right-hand Cash total reuses the existing
 * employee summary endpoint, so no new search or totals API is created and no
 * new Cash calculation is introduced.
 *
 * The summary is fetched once, lazily on the first real query, and cached for
 * the life of the page. Selecting a suggestion opens the existing profile.
 */
export function HomeEmployeeSearch() {
  const router = useRouter();
  const [value, setValue] = useState('');
  const [totals, setTotals] = useState<Record<string, string> | null>(null);
  const requested = useRef(false);
  const alive = useRef(true);

  useEffect(() => () => { alive.current = false; }, []);

  function ensureTotals() {
    if (requested.current || totals) return;
    requested.current = true;
    void (async () => {
      try {
        const response = await fetch('/api/employees/summary', {
          headers: {accept: 'application/json'},
          cache: 'no-store',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.json() as {rows?: SummaryRow[]};
        const map: Record<string, string> = {};
        for (const row of body.rows ?? []) map[row.employee_mobile] = row.cash_paid_minor;
        if (alive.current) setTotals(map);
      } catch {
        if (alive.current) setTotals({});
      }
    })();
  }

  return (
    <div className="home-emp-search">
      <EmployeeLookup
        id="home-employee-search"
        label="Search employee by name or mobile"
        hideLabel
        showIcon
        showClear
        minLength={2}
        rankedOnEnter={false}
        inputClassName="lookup-input lookup-input--icon"
        placeholder="Search employee name or mobile…"
        value={value}
        onChange={(next: string) => {
          setValue(next);
          if (next.trim().length >= 2) ensureTotals();
        }}
        onSelect={(employee: EmployeeSuggestion) => {
          router.push(`/employees/${encodeURIComponent(employee.employee_mobile)}`);
        }}
        asideFor={(employee: EmployeeSuggestion | RankedResult) => {
          const total = totals?.[employee.employee_mobile];
          return total === undefined ? '—' : compactTaka(total);
        }}
      />
    </div>
  );
}
