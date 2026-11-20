'use client';

import {useEffect, useState} from 'react';
import {FileText, RefreshCw, UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';
import {displayMobile} from '@/lib/display-mobile';
import {employeeFileUrl, type EmployeeDoc} from '@/components/standalone/employee-file-fields';

export type EmployeeDetailPayload = {
  employee: {
    employee_mobile: string; preferred_name: string; name_aliases: string[];
    duty_type: string | null; designation: string | null; state: string;
    joined_on: string | null; date_of_join: string | null;
    alt_mobile: string | null; home_phone: string | null;
    present_address: string | null; permanent_address: string | null;
    reference_name: string | null; reference_mobile: string | null;
    nid_number: string | null; birth_cert_number: string | null; passport_number: string | null;
    notes: string | null; salary_amount?: string | number | null; photo_url?: string | null;
  };
  documents?: EmployeeDoc[];
};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);

/** DB dates are ISO `YYYY-MM-DD`; show DD MMM YYYY without timezone drift. */
export function formatJoinDate(value: string | null | undefined): string {
  if (!value) return '—';
  const iso = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return String(value);
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.toLocaleDateString('en-GB', {day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC'});
}

export function formatSalary(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '৳400/day (default)';
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '৳400/day (default)';
  return `৳${amount.toLocaleString('en-US')}`;
}

const Row = ({label, children}: {label: string; children: React.ReactNode}) => (
  <>
    <dt className="text-muted-foreground">{label}</dt>
    <dd>{children}</dd>
  </>
);

/** Read-only employee profile shown under the /employees search box. */
export function EmployeeDetailCard({mobile, onClose}: {mobile: string; onClose?: () => void}) {
  const [detail, setDetail] = useState<EmployeeDetailPayload | null>(null);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/employees?mobile=${encodeURIComponent(mobile)}`,
      {headers: {accept: 'application/json'}, signal: controller.signal, cache: 'no-store'})
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: EmployeeDetailPayload) => {
        if (controller.signal.aborted) return;
        setError('');
        setDetail(payload);
      })
      .catch((cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : 'Load failed.'); });
    return () => controller.abort();
  }, [mobile, reloadKey]);

  if (error) {
    return (
      <section className="card" style={{padding: 14}}>
        <p role="alert" style={{color: '#b91c1c'}}>Employee could not be loaded ({error}).</p>
        <Button type="button" size="sm" variant="outline" onClick={() => setReloadKey((key) => key + 1)}>Retry</Button>
      </section>
    );
  }
  if (!detail) return <section className="card" style={{padding: 14}}><p className="muted">Loading employee…</p></section>;

  const employee = detail.employee;
  const photo = employeeFileUrl(employee.photo_url);
  const documents = detail.documents ?? [];

  return (
    <section className="card" style={{padding: 14}}>
      <div className="flex items-start justify-between gap-3" style={{marginBottom: 10, flexWrap: 'wrap'}}>
        <div style={{display: 'flex', gap: 12, alignItems: 'center'}}>
          {photo ? (
            // eslint-disable-next-line @next/next/no-img-element -- private uploads use an auth route.
            <img src={photo} alt={`${employee.preferred_name} photo`} width={80} height={80}
              style={{width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)'}} />
          ) : (
            <div aria-hidden="true" style={{width: 80, height: 80, borderRadius: 8, border: '1px dashed var(--line)',
              display: 'grid', placeItems: 'center', color: 'var(--muted)'}}><UserRound className="size-7" /></div>
          )}
          <div>
            <h3 style={{margin: 0}}>{employee.preferred_name}</h3>
            <p className="muted" style={{margin: 0, fontSize: 12}}>
              {displayMobile(employee.employee_mobile)} · {employee.designation ?? 'no designation'}
            </p>
          </div>
        </div>
        <div style={{display: 'flex', gap: 6}}>
          <Button type="button" size="sm" variant="outline" aria-label="Refresh employee"
            onClick={() => setReloadKey((key) => key + 1)}><RefreshCw className="size-4" /></Button>
          {onClose ? <Button type="button" size="sm" variant="outline" onClick={onClose}>Close</Button> : null}
        </div>
      </div>

      <dl style={{display: 'grid', gridTemplateColumns: '160px 1fr', columnGap: 12, rowGap: 6, fontSize: 14, margin: 0}}>
        <Row label="Employee Name">{employee.preferred_name}</Row>
        <Row label="Employee ID">{displayMobile(employee.employee_mobile)}</Row>
        <Row label="Secondary Mobile">{dash(employee.alt_mobile ? displayMobile(employee.alt_mobile) : null)}</Row>
        <Row label="Family Member Mobile">
          {employee.reference_mobile || employee.reference_name
            ? `${dash(employee.reference_mobile ? displayMobile(employee.reference_mobile) : null)}${employee.reference_name ? ` · ${employee.reference_name}` : ''}`
            : '—'}
        </Row>
        <Row label="Date of Joining">{formatJoinDate(employee.date_of_join ?? employee.joined_on)}</Row>
        <Row label="National ID">{dash(employee.nid_number)}</Row>
        <Row label="Current Address">{dash(employee.present_address)}</Row>
        <Row label="Permanent Address">{dash(employee.permanent_address)}</Row>
        <Row label="Designation">{dash(employee.designation)}</Row>
        <Row label="Salary">{formatSalary(employee.salary_amount)}</Row>
        <Row label="Documents">
          {documents.length ? (
            <span style={{display: 'grid', gap: 2}}>
              {documents.map((document) => (
                <a key={document.id} href={employeeFileUrl(document.file_path)} target="_blank" rel="noreferrer"
                  style={{display: 'inline-flex', gap: 6, alignItems: 'center'}}>
                  <FileText className="size-4" />{document.file_name}
                </a>
              ))}
            </span>
          ) : 'None uploaded'}
        </Row>
      </dl>

      <details style={{marginTop: 12}}>
        <summary style={{cursor: 'pointer', fontSize: 13, fontWeight: 600}}>More details</summary>
        <dl style={{display: 'grid', gridTemplateColumns: '160px 1fr', columnGap: 12, rowGap: 6, fontSize: 14, marginTop: 8}}>
          <Row label="Birth Certificate">{dash(employee.birth_cert_number)}</Row>
          <Row label="Passport">{dash(employee.passport_number)}</Row>
          <Row label="Duty Type">{dash(employee.duty_type)}</Row>
          <Row label="State">{dash(employee.state)}</Row>
          <Row label="Home Phone">{dash(employee.home_phone ? displayMobile(employee.home_phone) : null)}</Row>
          <Row label="Name Aliases">{employee.name_aliases.length ? employee.name_aliases.join(', ') : '—'}</Row>
          <Row label="Notes">{dash(employee.notes)}</Row>
        </dl>
      </details>
    </section>
  );
}
