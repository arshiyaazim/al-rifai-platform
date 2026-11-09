import Link from 'next/link';
import {notFound} from 'next/navigation';
import {countPrograms, getProgram, listPrograms, potentialDuplicates} from '@/lib/standalone/programs';
import {listEmployees} from '@/lib/standalone/employees';
import {VesselRegisterClient} from '@/components/standalone/vessel-register-client';
import {listProgramSourcesForPrograms} from '@/lib/standalone/review';
import {DomainError} from '@/lib/standalone/db';
import {can} from '@/lib/standalone/authz';
import {money, pageUser, when} from '@/lib/standalone/session';
import {ActionForm} from '@/components/standalone/action-form';
import {OwnerDraftPanel} from '@/components/standalone/owner-draft-panel';
import {getMessageEvidence} from '@/lib/standalone/messages';
import {ownerDraftFromProgram} from '@/lib/order-draft-from-record';
import {ProgramStickySummary} from '@/components/standalone/program-sticky-summary';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

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
  const accountId = sources[0]?.account_id ?? 'wa-01';
  const orderSource = sources.find((source) => source.source_role === 'primary') ?? sources[0] ?? null;
  const confirmationEvidence = program.confirmation_message_id && program.confirmation_chat_jid
    ? await getMessageEvidence(accountId, program.confirmation_chat_jid, program.confirmation_message_id)
    : null;
  const releaseEvidence = program.release_message_id && program.release_chat_jid
    ? await getMessageEvidence(accountId, program.release_chat_jid, program.release_message_id)
    : null;
  const [historyPrograms, historyTotal, escorts] = await Promise.all([
    listPrograms({mother: program.mother_vessel, limit: 20, offset: 0}),
    countPrograms({mother: program.mother_vessel}),
    listEmployees({state: 'ACTIVE', limit: 500}),
  ]);
  const duplicates = await potentialDuplicates({
    motherVessel: program.mother_vessel,
    lighterVessel: program.lighter_vessel,
    startDate: program.start_date,
    excludeId: program.id,
  });
  const stateTone = program.state === 'RELEASED' || program.state === 'COMPLETED' ? 'ok'
    : program.state === 'CONFIRMED' || program.state === 'ASSIGNED' || program.state === 'IN_DUTY' ? 'info'
      : program.state === 'VOIDED' ? 'bad' : '';
  const timeline = [
    {state: 'DRAFT', at: program.created_at, actor: program.created_by, note: 'Order drafted'},
    ...(program.confirmation_timestamp ? [{state: 'CONFIRMED', at: program.confirmation_timestamp, actor: program.confirmation_sender_jid ?? '—', note: 'Admin WA-01 confirmation'}] : []),
    ...(program.release_timestamp ? [{state: 'RELEASED', at: program.release_timestamp, actor: program.release_sender_jid ?? '—', note: 'Release information'}] : []),
  ];
  const closed = program.state === 'VOIDED' || program.state === 'COMPLETED';
  const editable = canCommand && !closed;
  const payable = pay as {state?: string; total_minor?: string | null} | null;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{program.mother_vessel} → {program.lighter_vessel}</h1>
          <p className="muted">
            <span className={`pill ${stateTone}`}>{program.state}</span> · start {program.start_date} · {program.start_shift}
            {program.end_date ? ` · release ${program.end_date} · ${program.end_shift}` : ''}
          </p>
        </div>
        <div className="row-actions"><Link href="/vessel">← Vessel Register</Link><Link href="/vessel/drafts">Order drafts →</Link><RealtimeRefresher domain="VESSEL" /></div>
      </div>

      <ProgramStickySummary
        programId={program.id}
        motherVessel={program.mother_vessel}
        lighterVessel={program.lighter_vessel}
        masterName={program.master_name}
        masterMobile={program.master_mobile}
        escortName={program.escort_name}
        escortMobile={program.escort_mobile}
        startDate={program.start_date}
        startShift={program.start_shift}
        endDate={program.end_date}
        endShift={program.end_shift}
        state={program.state}
      />

      <VesselRegisterClient
        initial={{
          rows: historyPrograms,
          total: historyTotal,
          page: 1,
          limit: 20,
          totalPages: Math.max(1, Math.ceil(historyTotal / 20)),
        }}
        escorts={escorts.map((employee) => ({mobile: employee.employee_mobile, name: employee.preferred_name}))}
        mothers={[program.mother_vessel]}
        lighters={[]}
        escortNames={[]}
        escortMobiles={[]}
        fixedMother={program.mother_vessel}
        canCommand={canCommand}
        canRelease={canRelease}
        showNew={false}
      />

      {['DRAFT', 'CONFIRMED'].includes(program.state) ? (
        <OwnerDraftPanel
          result={ownerDraftFromProgram(program)}
          title="Owner order draft"
          description="Draft prepared from this program. Copy it, add the escort reply, and send from WhatsApp; this page does not transmit."
        />
      ) : null}

      <div className="split">
        <section className="card">
          <h3>Program details</h3>
          <table>
            <tbody>
              <tr><th>Program ID</th><td style={{fontFamily: 'ui-monospace, monospace'}}>{program.id}</td></tr>
              <tr><th>Mother vessel</th><td>{program.mother_vessel}</td></tr>
              <tr><th>Lighter vessel</th><td>{program.lighter_vessel}</td></tr>
              <tr><th>Master name</th><td><span className="muted">NOT_STORED — the schema stores the Master Mobile only</span></td></tr>
              <tr><th>Master mobile</th><td>{program.master_mobile ?? '—'}</td></tr>
              <tr><th>Destination</th><td>{program.destination ?? '—'}</td></tr>
              <tr><th>Escort</th><td>{program.escort_name ?? '—'} {program.escort_mobile ? `· ${program.escort_mobile}` : ''}</td></tr>
              <tr><th>Pay</th><td>{money(payable?.total_minor ?? null)} {payable?.state === 'UNRESOLVED' ? '(unresolved)' : ''}</td></tr>
              <tr><th>Source</th><td>{program.source_channel}{program.source_message_id ? ` · ${program.source_message_id}` : ''}</td></tr>
              <tr><th>Confirmation</th><td>{program.confirmation_message_id ?? '—'}</td></tr>
              <tr><th>Confirmation chat</th><td>{program.confirmation_chat_jid ?? '—'}</td></tr>
              <tr><th>Confirmation sender</th><td>{program.confirmation_sender_jid ?? '—'}</td></tr>
              <tr><th>Confirmation time</th><td>{program.confirmation_timestamp ? when(program.confirmation_timestamp) : '—'}</td></tr>
              <tr><th>Release message</th><td>{program.release_message_id ?? '—'}</td></tr>
              <tr><th>Release chat</th><td>{program.release_chat_jid ?? '—'}</td></tr>
              <tr><th>Release sender</th><td>{program.release_sender_jid ?? '—'}</td></tr>
              <tr><th>Release time</th><td>{program.release_timestamp ? when(program.release_timestamp) : '—'}</td></tr>
              <tr><th>Last updated</th><td>{program.updated_at ? when(program.updated_at) : '—'}</td></tr>
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

      {duplicates.length ? (
        <section className="card" style={{marginBottom: 18}}>
          <h3>Duplicate warning</h3>
          <p className="muted">Near-date (±1 day) programs with the same normalized Mother + Lighter. Separate rows are never merged automatically.</p>
          <ul>
            {duplicates.map((candidate) => (
              <li key={candidate.id}>
                <Link href={`/vessel/${encodeURIComponent(candidate.id)}`}>{candidate.id}</Link> · start {candidate.start_date}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <div className="split" style={{marginBottom: 18}}>
        <section className="card">
          <h3>Order provenance</h3>
          <table>
            <tbody>
              {orderSource ? (
                <>
                  <tr><th>Order timestamp</th><td>{orderSource.source_timestamp ? when(orderSource.source_timestamp) : '—'}</td></tr>
                  <tr><th>Sender</th><td>{orderSource.sender_jid ?? '—'}</td></tr>
                  <tr><th>Chat</th><td>{orderSource.chat_jid}</td></tr>
                  <tr><th>Message ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{orderSource.message_id}</td></tr>
                  <tr><th>Original text</th><td style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{orderSource.text_content ?? <span className="muted">not stored</span>}</td></tr>
                </>
              ) : <tr><td className="muted">No WhatsApp order source is linked to this program.</td></tr>}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Confirmation provenance</h3>
          <table>
            <tbody>
              <tr><th>Confirmed</th><td>{program.confirmation_timestamp ? when(program.confirmation_timestamp) : '—'}</td></tr>
              <tr><th>Sender</th><td>{program.confirmation_sender_jid ?? '—'}</td></tr>
              <tr><th>Chat</th><td>{program.confirmation_chat_jid ?? '—'}</td></tr>
              <tr><th>Account</th><td>{program.confirmation_account_id ?? '—'}</td></tr>
              <tr><th>Message ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{program.confirmation_message_id ?? '—'}</td></tr>
              <tr><th>Message text</th><td style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{confirmationEvidence?.text_content ?? <span className="muted">not stored</span>}</td></tr>
            </tbody>
          </table>
        </section>
      </div>

      {program.state === 'RELEASED' || program.release_message_id ? (
        <section className="card" style={{marginBottom: 18}}>
          <h3>Release provenance</h3>
          <table>
            <tbody>
              <tr><th>Released</th><td>{program.release_timestamp ? when(program.release_timestamp) : '—'}</td></tr>
              <tr><th>Sender</th><td>{program.release_sender_jid ?? '—'}</td></tr>
              <tr><th>Chat</th><td>{program.release_chat_jid ?? '—'}</td></tr>
              <tr><th>Account</th><td>{program.release_account_id ?? '—'}</td></tr>
              <tr><th>Message ID</th><td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{program.release_message_id ?? '—'}</td></tr>
              <tr><th>End date / shift</th><td>{program.end_date ? `${program.end_date} · ${program.end_shift}` : '—'}</td></tr>
              <tr><th>Message text</th><td style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{releaseEvidence?.text_content ?? <span className="muted">not stored</span>}</td></tr>
            </tbody>
          </table>
        </section>
      ) : null}

      <section className="card" style={{marginBottom: 18}}>
        <h3>Lifecycle timeline</h3>
        <table>
          <thead><tr><th>State</th><th>When</th><th>Actor</th><th>Note</th></tr></thead>
          <tbody>
            {timeline.map((entry) => (
              <tr key={entry.state}>
                <td><span className={`pill ${entry.state === 'RELEASED' ? 'ok' : entry.state === 'CONFIRMED' ? 'info' : ''}`}>{entry.state}</span></td>
                <td>{entry.at ? when(entry.at) : '—'}</td>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{entry.actor ?? '—'}</td>
                <td>{entry.note}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      {editable ? (
        <div className="split" id="program-edit">
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
              { [...events].reverse().map((event, index) => (
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
