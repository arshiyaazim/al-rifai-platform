import {listPrograms} from '@/lib/standalone/programs';
import {money} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function VesselPage() {
  const programs = await listPrograms({});
  const active = programs.filter((program) => !['VOIDED', 'COMPLETED'].includes(program.state));

  return (
    <>
      <div className="page-head">
        <div><h1>Vessel Register</h1><p className="muted">Orders, escorts, duty dates, release and duplicate prevention.</p></div>
      </div>

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
          {name: 'startShift', label: 'Shift', type: 'select', options: [
            {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
          ]},
          {name: 'endDate', label: 'End date (release)', type: 'date'},
          {name: 'endShift', label: 'End shift', type: 'select', options: [
            {value: '', label: '—'}, {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
          ]},
          {name: 'notes', label: 'Notes', type: 'textarea'},
        ]}
      />

      <section className="card">
        <h3>Programs ({programs.length} · {active.length} active)</h3>
        <table>
          <thead><tr><th>Mother → Lighter</th><th>Escort</th><th>Start</th><th>End</th><th>State</th><th>Pay</th></tr></thead>
          <tbody>
            {programs.map((program) => (
              <tr key={program.id}>
                <td>{program.mother_vessel} → {program.lighter_vessel}<div className="muted" style={{fontFamily: 'ui-monospace, monospace'}}>{program.id}</div></td>
                <td>{program.escort_name ?? '—'}<div className="muted">{program.escort_mobile ?? ''}</div></td>
                <td>{program.start_date} · {program.start_shift}</td>
                <td>{program.end_date ? `${program.end_date} · ${program.end_shift}` : '—'}</td>
                <td><span className={`pill ${program.state === 'RELEASED' ? 'ok' : program.state === 'VOIDED' ? 'bad' : ''}`}>{program.state}</span></td>
                <td>{money(program.total_minor)}{program.pay_state === 'UNRESOLVED' ? <div className="muted">unresolved</div> : null}</td>
              </tr>
            ))}
            {!programs.length ? <tr><td colSpan={6} className="muted">No programs yet.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <div className="split">
        <ActionForm title="Assign / replace escort" endpoint="/api/programs" action="assign" submitLabel="Assign"
          fields={[
            {name: 'programId', label: 'Program id', required: true},
            {name: 'employeeMobile', label: 'Escort mobile', required: true},
            {name: 'employeeName', label: 'Escort name'},
            {name: 'startDate', label: 'Start date', type: 'date'},
            {name: 'startShift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
          ]} />
        <ActionForm title="Release" endpoint="/api/programs" action="release" submitLabel="Release"
          fields={[
            {name: 'programId', label: 'Program id', required: true},
            {name: 'endDate', label: 'End date', type: 'date', required: true},
            {name: 'endShift', label: 'End shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
            {name: 'note', label: 'Note'},
          ]} />
        <ActionForm title="Void" endpoint="/api/programs" action="void" submitLabel="Void program"
          fields={[
            {name: 'programId', label: 'Program id', required: true},
            {name: 'reason', label: 'Reason', required: true},
          ]} />
      </div>
    </>
  );
}
