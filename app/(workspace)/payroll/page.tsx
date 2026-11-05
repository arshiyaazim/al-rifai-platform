import {listRates, monthlySalary, payrollSummary, programPayList} from '@/lib/standalone/payroll';
import {money} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function PayrollPage({searchParams}: {searchParams: Promise<{month?: string}>}) {
  const {month} = await searchParams;
  const target = month && /^\d{4}-\d{2}$/.test(month) ? month : new Date().toISOString().slice(0, 7);
  const [summary, monthly, rates, programs] = await Promise.all([
    payrollSummary(), monthlySalary(target), listRates(), programPayList({}),
  ]);

  return (
    <>
      <div className="page-head">
        <div><h1>Payroll</h1><p className="muted">Duty-based pay from approved shift rates. Derived, auditable, never invented.</p></div>
        <form method="get" className="row-actions">
          <input type="month" name="month" defaultValue={target} />
          <button type="submit" className="ghost">Show month</button>
        </form>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Payable (calculated)</div><div className="value">{money(summary?.payable)}</div></div>
        <div className="stat"><div className="label">Unresolved programs</div><div className="value">{summary?.unresolved ?? 0}</div></div>
        <div className="stat"><div className="label">{target} salary</div><div className="value">{money(monthly.salaryMinor)}</div></div>
        <div className="stat"><div className="label">{target} shifts</div><div className="value">{monthly.shifts}</div></div>
      </div>

      <ActionForm
        title="Configure a rate"
        endpoint="/api/payroll"
        submitLabel="Save rate"
        fields={[
          {name: 'destinationKey', label: 'Destination key', required: true, placeholder: 'default'},
          {name: 'destinationLabel', label: 'Label', required: true, placeholder: 'Default (uniform)'},
          {name: 'shiftRateMinor', label: 'Rate per shift (paisa)', type: 'number', required: true, placeholder: '20000'},
          {name: 'conveyanceMinor', label: 'Conveyance (paisa)', type: 'number', placeholder: '0'},
          {name: 'effectiveFrom', label: 'Effective from', type: 'date'},
        ]}
      />

      <div className="split">
        <section className="card">
          <h3>Rates</h3>
          <table>
            <thead><tr><th>Destination</th><th>Per shift</th><th>Conveyance</th><th>From</th></tr></thead>
            <tbody>
              {rates.map((rate) => (
                <tr key={rate.destination_key}>
                  <td>{rate.destination_label}<div className="muted">{rate.destination_key}</div></td>
                  <td>{money(rate.shift_rate_minor)}</td>
                  <td>{money(rate.conveyance_minor)}</td>
                  <td>{rate.effective_from}</td>
                </tr>
              ))}
              {!rates.length ? <tr><td colSpan={4} className="muted">No rate configured — pay stays unresolved until you add one.</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>{target} salary by employee</h3>
          <table>
            <thead><tr><th>Employee</th><th>Shifts</th><th>Salary</th></tr></thead>
            <tbody>
              {monthly.employees.map((line) => (
                <tr key={line.employee || line.name}>
                  <td>{line.name || line.employee}</td><td>{line.shifts}</td><td>{money(line.salary)}</td>
                </tr>
              ))}
              {!monthly.employees.length ? <tr><td colSpan={3} className="muted">No released duty in this month.</td></tr> : null}
            </tbody>
          </table>
          <p className="muted">{monthly.conveyanceNote}</p>
        </section>
      </div>

      <section className="card">
        <h3>Program pay</h3>
        <table>
          <thead><tr><th>Program</th><th>Escort</th><th>Shifts</th><th>Salary</th><th>Conveyance</th><th>Total</th><th>State</th></tr></thead>
          <tbody>
            {programs.slice(0, 60).map((program) => {
              const item = program as unknown as {
                id: string; escort_name: string | null; shifts: string | null; salary_minor: string | null;
                conveyance_minor: string | null; total_minor: string | null; state: string; reasons: unknown;
              };
              return (
                <tr key={item.id}>
                  <td>{item.id.slice(0, 16)}</td>
                  <td>{item.escort_name ?? '—'}</td>
                  <td>{item.shifts ?? '—'}</td>
                  <td>{money(item.salary_minor)}</td>
                  <td>{money(item.conveyance_minor)}</td>
                  <td>{money(item.total_minor)}</td>
                  <td><span className={`pill ${item.state === 'CALCULATED' ? 'ok' : 'warn'}`}>{item.state}</span>
                    {item.state === 'UNRESOLVED' ? <div className="muted">{JSON.stringify(item.reasons)}</div> : null}</td>
                </tr>
              );
            })}
            {!programs.length ? <tr><td colSpan={7} className="muted">No programs yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
