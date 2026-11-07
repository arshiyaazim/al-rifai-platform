import Link from 'next/link';
import {listPrograms} from '@/lib/standalone/programs';
import {money} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';

export async function VesselRegisterView({
  title = 'Vessel Register',
  description = 'Orders, escorts, duty dates, release and duplicate prevention.',
  params,
}: {
  title?: string;
  description?: string;
  params: {q?: string; state?: string};
}) {
  const q = (params.q ?? '').trim();
  const state = params.state ?? '';
  const programs = await listPrograms({q, state: state || undefined, limit: 500});
  const active = programs.filter((program) => !['VOIDED', 'COMPLETED'].includes(program.state));
  const assigned = programs.filter((program) => program.state === 'ASSIGNED').length;
  const released = programs.filter((program) => program.state === 'RELEASED').length;

  return (
    <>
      <div className="page-head">
        <div><h1>{title}</h1><p className="muted">{description}</p></div>
        <div className="row-actions">
          <Link href="/review?domain=PROGRAM">Vessel review queue →</Link>
          <Link href="/vessel">Open vessel control →</Link>
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Programs</div><div className="value">{programs.length}</div><div className="muted">All states</div></div>
        <div className="stat"><div className="label">Active</div><div className="value">{active.length}</div><div className="muted">Not released/void</div></div>
        <div className="stat"><div className="label">Assigned</div><div className="value">{assigned}</div><div className="muted">Open duty</div></div>
        <div className="stat"><div className="label">Released</div><div className="value">{released}</div><div className="muted">Closed duty</div></div>
      </div>

      <form method="get" className="card form compact" style={{marginBottom: 18}}>
        <div className="grid">
          <label><span>Search</span><input name="q" defaultValue={q} placeholder="Mother, lighter or escort" /></label>
          <label><span>State</span>
            <select name="state" defaultValue={state}>
              <option value="">All states</option>
              {['DRAFT','ASSIGNED','IN_DUTY','RELEASED','COMPLETED','VOIDED'].map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
        </div>
        <button type="submit">Filter programs</button>
      </form>

      <ActionForm
        title="New program (one row per lighter)"
        endpoint="/api/programs"
        action="create"
        submitLabel="Create program"
        fields={[
          {name: 'motherVessel', label: 'Mother vessel', required: true},
          {name: 'lighterVessel', label: 'Lighter vessel', required: true},
          {name: 'masterMobile', label: 'Master mobile', placeholder: '01712345678'},
          {name: 'destination', label: 'Destination'},
          {name: 'escortName', label: 'Escort name'},
          {name: 'escortMobile', label: 'Escort mobile', placeholder: '01812345678'},
          {name: 'startDate', label: 'Start date', type: 'date', required: true},
          {name: 'startShift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]},
          {name: 'notes', label: 'Notes', type: 'textarea'},
        ]}
      />

      <section className="card">
        <h3>Programs ({programs.length})</h3>
        <table>
          <thead><tr><th>Mother → Lighter</th><th>Escort</th><th>Start</th><th>End</th><th>State</th><th>Pay</th><th>Source</th></tr></thead>
          <tbody>
            {programs.map((program) => (
              <tr key={program.id}>
                <td><Link href={`/vessel/${encodeURIComponent(program.id)}`}>{program.mother_vessel} → {program.lighter_vessel}</Link><div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{program.id}</div></td>
                <td>{program.escort_name ?? '—'}<div className="muted">{program.escort_mobile ?? ''}</div></td>
                <td>{program.start_date} · {program.start_shift}</td>
                <td>{program.end_date ? `${program.end_date} · ${program.end_shift ?? ''}` : '—'}</td>
                <td><span className={`pill ${['RELEASED','COMPLETED'].includes(program.state) ? 'ok' : program.state === 'VOIDED' ? 'bad' : ''}`}>{program.state}</span></td>
                <td>{money(program.total_minor)}{program.pay_state === 'UNRESOLVED' ? <div className="muted">unresolved</div> : null}</td>
                <td>{program.source_channel}{program.source_message_id ? <div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{program.source_message_id}</div> : null}</td>
              </tr>
            ))}
            {!programs.length ? <tr><td colSpan={7} className="muted">No matching programs.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
