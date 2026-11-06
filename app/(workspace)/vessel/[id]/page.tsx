import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getProgram} from '@/lib/standalone/programs';
import {listProgramSourcesForPrograms} from '@/lib/standalone/review';
import {DomainError} from '@/lib/standalone/db';
import {can} from '@/lib/standalone/authz';
import {money, pageUser, when} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

export default async function VesselProgramPage({params}: {params: Promise<{id: string}>}) {
  const {id} = await params;
  const programId = decodeURIComponent(id);
  let data;
  try {
    data = await getProgram(programId);
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }
  const user = await pageUser();
  const canCommand = can(user as never, 'vessel.command');
  const canRelease = can(user as never, 'vessel.release');
  const sources = await listProgramSourcesForPrograms([programId]);
  const {program, pay, assignments, events} = data;
  const closed = program.state === 'VOIDED' || program.state === 'COMPLETED';
  const editable = canCommand && !closed;
  const payable = pay as {state?: string; total_minor?: string | null} | null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{program.mother_vessel} → {program.lighter_vessel}</h1>
          <p className="muted">
            {program.state} · start {program.start_date} · {program.start_shift}
            {program.end_date ? ` · release ${program.end_date} · ${program.end_shift}` : ''}
          </p>
        </div>
        <div className="row-actions"><Link href="/vessel">← Vessel Register</Link></div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Program details</h3>
          <table>
            <tbody>
              <tr><th>Program ID</th><td style={{fontFamily: 'ui-monospace, monospace'}}>{program.id}</td></tr>
              <tr><th>Mother vessel</th><td>{program.mother_vessel}</td></tr>
              <tr><th>Lighter vessel</th><td>{program.lighter_vessel}</td></tr>
              <tr><th>Master mobile</th><td>{program.master_mobile ?? '—'}</td></tr>
              <tr><th>Destination</th><td>{program.destination ?? '—'}</td></tr>
              <tr><th>Escort</th><td>{program.escort_name ?? '—'} {program.escort_mobile ? `· ${program.escort_mobile}` : ''}</td></tr>
              <tr><th>Pay</th><td>{money(payable?.total_minor ?? null)} {payable?.state === 'UNRESOLVED' ? '(unresolved)' : ''}</td></tr>
              <tr><th>Source</th><td>{program.source_channel}{program.source_message_id ? ` · ${program.source_message_id}` : ''}</td></tr>
              <tr><th>Confirmation</th><td>{program.confirmation_message_id ?? '—'}</td></tr>
              <tr><th>Notes</th><td>{program.notes ?? '—'}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Source evidence ({sources.length})</h3>
          {sources.length ? (
            <table>
              <thead><tr><th>Role</th><th>Message</th><th>Chat</th></tr></thead>
              <tbody>
                {sources.map((source) => (
                  <tr key={`${source.message_id}-${source.source_role}`}>
                    <td>{source.source_role}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{source.message_id}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{source.chat_jid}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No linked source messages.</p>}
        </section>
      </div>

      {editable ? (
        <div className="split">
          <ActionForm
            title="Edit program"
            endpoint="/api/programs"
            action="update"
            submitLabel="Save program"
            hidden={{programId: program.id}}
            fields={[
              {name: 'motherVessel', label: 'Mother vessel', required: true, defaultValue: program.mother_vessel},
              {name: 'lighterVessel', label: 'Lighter vessel', required: true, defaultValue: program.lighter_vessel},
              {name: 'masterMobile', label: 'Master mobile', defaultValue: program.master_mobile ?? ''},
              {name: 'destination', label: 'Destination', defaultValue: program.destination ?? ''},
              {name: 'startDate', label: 'Start date', type: 'date', required: true, defaultValue: program.start_date},
              {name: 'startShift', label: 'Shift', type: 'select', defaultValue: program.start_shift, options: [
                {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
              ]},
              {name: 'notes', label: 'Notes', type: 'textarea', defaultValue: program.notes ?? ''},
            ]}
          />

          <ActionForm
            title={program.escort_mobile ? 'Replace escort' : 'Assign escort'}
            endpoint="/api/programs"
            action="assign"
            submitLabel={program.escort_mobile ? 'Replace escort' : 'Assign escort'}
            hidden={{programId: program.id}}
            fields={[
              {name: 'employeeMobile', label: 'Escort mobile', required: true, defaultValue: program.escort_mobile ?? '', placeholder: '01812345678'},
              {name: 'employeeName', label: 'Escort name', defaultValue: program.escort_name ?? ''},
              {name: 'startDate', label: 'Start date', type: 'date', defaultValue: program.start_date},
              {name: 'startShift', label: 'Shift', type: 'select', defaultValue: program.start_shift, options: [
                {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
              ]},
              {name: 'replace', label: 'Close previous assignment', type: 'select', defaultValue: program.escort_mobile ? 'yes' : 'no', options: [
                {value: 'no', label: 'No'}, {value: 'yes', label: 'Yes'},
              ]},
            ]}
          />
        </div>
      ) : null}

      <div className="split">
        {canCommand && ['DRAFT', 'CONFIRMED', 'ASSIGNED'].includes(program.state) ? (
          <ActionForm title="Duty status" endpoint="/api/programs" action="start" submitLabel="Mark in duty" hidden={{programId: program.id}} fields={[]} />
        ) : null}

        {canRelease && !['VOIDED', 'COMPLETED'].includes(program.state) ? (
          <ActionForm
            title="Record release"
            endpoint="/api/programs"
            action="release"
            submitLabel="Release program"
            hidden={{programId: program.id}}
            fields={[
              {name: 'endDate', label: 'Release date', type: 'date', required: true, defaultValue: program.end_date ?? ''},
              {name: 'endShift', label: 'Release shift', type: 'select', options: [
                {value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'},
              ]},
              {name: 'note', label: 'Note', type: 'textarea'},
            ]}
          />
        ) : null}

        {canRelease && !closed ? (
          <ActionForm title="Complete program" endpoint="/api/programs" action="complete" submitLabel="Complete" hidden={{programId: program.id}} fields={[]} />
        ) : null}

        {canCommand && !closed ? (
          <ActionForm
            title="Void program"
            endpoint="/api/programs"
            action="void"
            submitLabel="Void with reason"
            hidden={{programId: program.id}}
            fields={[{name: 'reason', label: 'Reason', required: true}]}
          />
        ) : null}
      </div>

      <div className="split">
        <section className="card">
          <h3>Assignments ({assignments.length})</h3>
          <table>
            <thead><tr><th>Escort</th><th>Start</th><th>End</th></tr></thead>
            <tbody>
              {assignments.map((assignment) => (
                <tr key={String(assignment.id)}>
                  <td>{String(assignment.preferred_name ?? assignment.employee_mobile)}</td>
                  <td>{String(assignment.start_date)} · {String(assignment.start_shift)}</td>
                  <td>{assignment.end_date ? `${String(assignment.end_date)} · ${String(assignment.end_shift ?? '')}` : 'open'}</td>
                </tr>
              ))}
              {!assignments.length ? <tr><td colSpan={3} className="muted">No escort assigned.</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Events ({events.length})</h3>
          <table>
            <thead><tr><th>When</th><th>Action</th><th>Actor</th></tr></thead>
            <tbody>
              {events.map((event, index) => (
                <tr key={`${String(event.action)}-${index}`}>
                  <td>{when(String(event.created_at))}</td>
                  <td>{String(event.action)}</td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{String(event.actor).slice(0, 12)}</td>
                </tr>
              ))}
              {!events.length ? <tr><td colSpan={3} className="muted">No events.</td></tr> : null}
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
