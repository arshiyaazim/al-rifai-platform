import Link from 'next/link';
import {countPrograms, listPrograms} from '@/lib/standalone/programs';
import {listEmployees} from '@/lib/standalone/employees';
import {rows} from '@/lib/standalone/db';
import {listProgramSourcesForPrograms, listReviewQueue} from '@/lib/standalone/review';
import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {ActionForm} from '@/components/standalone/action-form';
import {VesselRegisterClient} from '@/components/standalone/vessel-register-client';
import {
  formatReviewTimestamp,
  reviewCategoryLabel,
  reviewCategoryTone,
  reviewEscortConflict,
  reviewStateLabel,
  reviewStateTone,
  reviewVesselNames,
} from '@/lib/review-ui';

export const dynamic = 'force-dynamic';

const VESSEL_CLIENTS = [
  {jid: '8801670535255@s.whatsapp.net', label: 'Hridoy PN'},
  {jid: '166082241384593@lid', label: 'Hridoy LID'},
  {jid: '8801836743754@s.whatsapp.net', label: 'Rezaul'},
  {jid: '8801757622300@s.whatsapp.net', label: 'TCIS'},
];

export default async function VesselPage({searchParams}: {searchParams: Promise<{q?: string; state?: string; page?: string; mother?: string}>}) {
  const filters = await searchParams;
  const user = await pageUser();
  const canCommand = can(user as never, 'vessel.command');
  const canRelease = can(user as never, 'vessel.release');
  const q = (filters.q ?? '').trim();
  const state = filters.state ?? '';
  const mother = filters.mother ?? '';
  const [initialPrograms, tableTotal, programs, vesselReviews, escorts, motherRows, lighterRows, escortNameRows, escortMobileRows] = await Promise.all([
    listPrograms({q, state: state || undefined, mother: mother || undefined, limit: 20, offset: 0}),
    countPrograms({q, state: state || undefined, mother: mother || undefined}),
    listPrograms({q, state: state || undefined, mother: mother || undefined, limit: 200, offset: 0}),
    listReviewQueue({domain: 'PROGRAM', state: 'PENDING', limit: 100}),
    listEmployees({state: 'ACTIVE', limit: 500}),
    rows<{mother_vessel: string}>('SELECT DISTINCT mother_vessel FROM programs WHERE state <> \'VOIDED\' ORDER BY mother_vessel'),
    rows<{lighter_vessel: string}>('SELECT DISTINCT lighter_vessel FROM programs WHERE state <> \'VOIDED\' ORDER BY lighter_vessel'),
    rows<{escort_name: string}>('SELECT DISTINCT escort_name FROM programs WHERE escort_name IS NOT NULL ORDER BY escort_name'),
    rows<{escort_mobile: string}>('SELECT DISTINCT escort_mobile FROM programs WHERE escort_mobile IS NOT NULL ORDER BY escort_mobile'),
  ]);
  const programSources = await listProgramSourcesForPrograms(programs.map((program) => program.id));
  const sourcesByProgram = new Map<string, typeof programSources>();
  for (const source of programSources) {
    const list = sourcesByProgram.get(source.program_id) ?? [];
    list.push(source);
    sourcesByProgram.set(source.program_id, list);
  }
  const incomplete = vesselReviews.filter((item) => item.category === 'INCOMPLETE_VESSEL_ORDER');
  const duplicates = vesselReviews.filter((item) => item.category === 'VESSEL_DUPLICATE_CANDIDATE');
  const ambiguous = vesselReviews.filter((item) => item.category === 'AMBIGUOUS_VESSEL_CONFIRMATION');
  const unmatched = vesselReviews.filter((item) => item.category === 'UNMATCHED_VESSEL_ASSIGNMENT');
  const confirmedPrograms = programs.filter((program) => program.confirmation_message_id);

  return (
    <>
      <div className="page-head">
        <div><h1>Vessel Register</h1><p className="muted">Orders, escorts, duty dates, release and duplicate prevention.</p></div>
        <div className="row-actions">
          <Link href="/review?domain=PROGRAM">Open Vessel review queue →</Link>
        </div>
      </div>

      <VesselRegisterClient
        initial={{
          rows: initialPrograms,
          total: tableTotal,
          page: 1,
          limit: 20,
          totalPages: Math.max(1, Math.ceil(tableTotal / 20)),
        }}
        escorts={escorts.map((employee) => ({mobile: employee.employee_mobile, name: employee.preferred_name}))}
        mothers={motherRows.map((row) => row.mother_vessel)}
        lighters={lighterRows.map((row) => row.lighter_vessel)}
        escortNames={escortNameRows.map((row) => row.escort_name)}
        escortMobiles={escortMobileRows.map((row) => row.escort_mobile)}
        clients={VESSEL_CLIENTS}
        initialQ={q}
        initialState={state}
        initialMother={mother}
        canCommand={canCommand}
        canRelease={canRelease}
      />

      <section className="card" style={{marginBottom: 18}}>
        <div className="page-head" style={{marginBottom: 8}}>
          <div><h3>Vessel review ({vesselReviews.length} pending)</h3></div>
          <span className="muted">Incomplete orders, duplicate warnings, ambiguous confirmations and escort conflicts.</span>
        </div>
        {vesselReviews.length ? (
          <table>
            <thead><tr><th>Item</th><th>Category</th><th>State</th><th>Target / source</th><th>Submitter</th><th>Created</th><th>Review</th></tr></thead>
            <tbody>
              {vesselReviews.map((item) => (
                <tr key={item.id}>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</td>
                  <td><span className={`pill ${reviewCategoryTone(item.category)}`}>{reviewCategoryLabel(item.category)}</span></td>
                  <td><span className={`pill ${reviewStateTone(item.state)}`}>{reviewStateLabel(item.state)}</span></td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.target_ref ?? '—'}</td>
                  <td>{item.submitter_name ?? item.submitted_by.slice(0, 12)}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(item.created_at)}</td>
                  <td><Link href={`/review/${item.id}`}>Inspect →</Link></td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No vessel reviews are pending.</p>}
      </section>

      <div className="grid-cards" style={{marginBottom: 18}}>
        <div className="stat">
          <div className="label">Incomplete orders</div>
          <div className="value">{incomplete.length}</div>
          <div className="muted">Missing mandatory vessel fields</div>
        </div>
        <div className="stat">
          <div className="label">Duplicate warnings</div>
          <div className="value">{duplicates.length}</div>
          <div className="muted">±1-day candidates; not discarded</div>
        </div>
        <div className="stat">
          <div className="label">Ambiguous confirmations</div>
          <div className="value">{ambiguous.length}</div>
          <div className="muted">Confirmation evidence attached</div>
        </div>
        <div className="stat">
          <div className="label">Escort conflicts</div>
          <div className="value">{unmatched.length}</div>
          <div className="muted">Unmatched assignment evidence</div>
        </div>
      </div>

      <div className="split" style={{marginBottom: 18}}>
        <section className="card">
          <h3>Incomplete orders</h3>
          {!incomplete.length ? <p className="muted">None pending.</p> : incomplete.map((item) => (
            <div key={item.id} style={{marginBottom: 10}}>
              <div style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</div>
              <div className="muted">{String((item.payload as Record<string, unknown>).rawText ?? item.target_ref ?? '').slice(0, 180)}</div>
              <Link href={`/review/${item.id}`}>Inspect source evidence →</Link>
            </div>
          ))}
        </section>
        <section className="card">
          <h3>Duplicate warnings</h3>
          {!duplicates.length ? <p className="muted">None pending.</p> : duplicates.map((item) => (
            <div key={item.id} style={{marginBottom: 10}}>
              <div style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</div>
              <div className="muted">Target {item.target_ref ?? '—'} · submitter {item.submitter_name ?? item.submitted_by.slice(0, 12)}</div>
              <Link href={`/review/${item.id}`}>Compare candidates →</Link>
            </div>
          ))}
        </section>
        <section className="card">
          <h3>Ambiguous confirmations</h3>
          {!ambiguous.length ? <p className="muted">None pending.</p> : ambiguous.map((item) => (
            <div key={item.id} style={{marginBottom: 10}}>
              <div style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</div>
              <div className="muted">Target {item.target_ref ?? '—'}</div>
              <Link href={`/review/${item.id}`}>Inspect confirmation evidence →</Link>
            </div>
          ))}
        </section>
        <section className="card">
          <h3>Escort assignment conflicts</h3>
          {!unmatched.length ? <p className="muted">None pending.</p> : unmatched.map((item) => (
            <div key={item.id} style={{marginBottom: 10}}>
              <div style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</div>
              <div className="muted">{reviewEscortConflict({payload: item.payload}) ?? 'Unmatched assignment evidence'}</div>
              <Link href={`/review/${item.id}`}>Inspect assignment →</Link>
            </div>
          ))}
        </section>
      </div>

      {/* HIDDEN: Multi-message source evidence — Owner request 2026-11-10
      <section className="card" style={{marginBottom: 18}}>
        <h3>Multi-message source evidence</h3>
        <p className="muted" style={{marginTop: -6}}>One program can be assembled from multiple WhatsApp messages. Primary and contributor messages are both shown.</p>
        {programSources.length ? (
          <table>
            <thead><tr><th>Program</th><th>Role</th><th>Message</th><th>When</th><th>Text</th></tr></thead>
            <tbody>
              {programSources.map((source) => {
                const program = programs.find((entry) => entry.id === source.program_id);
                return (
                  <tr key={source.id}>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      {source.program_id}
                      <div className="muted">{program ? `${program.mother_vessel} → ${program.lighter_vessel}` : ''}</div>
                    </td>
                    <td><span className={`pill ${source.source_role === 'primary' ? 'ok' : ''}`}>{source.source_role}</span></td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                      <Link href={`/messages?q=${encodeURIComponent(source.message_id)}`}>{source.message_id}</Link>
                    </td>
                    <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(source.source_timestamp)}</td>
                    <td style={{maxWidth: 420, whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{source.text_content ?? <span className="muted">no text</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : <p className="muted">No multi-message program evidence yet.</p>}
      </section>

      */}

      <div className="split" style={{marginBottom: 18}}>
        <section className="card">
          <h3>Confirmation evidence</h3>
          <p className="muted" style={{marginTop: -6}}>Confirmation is applied from the admin&apos;s outgoing WhatsApp reply via applyConfirmation(). No second confirmation is required.</p>
          {confirmedPrograms.length ? (
            <table>
              <thead><tr><th>Program</th><th>confirmation_message_id</th><th>Open</th></tr></thead>
              <tbody>
                {confirmedPrograms.map((program) => (
                  <tr key={program.id}>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{program.id}</td>
                    <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{program.confirmation_message_id}</td>
                    <td><Link href={`/messages?q=${encodeURIComponent(program.confirmation_message_id ?? '')}`}>Message →</Link></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : <p className="muted">No confirmations recorded yet.</p>}
        </section>
        <section className="card">
          <h3>Vessel name normalization</h3>
          <p className="muted" style={{marginTop: -6}}>Original names from the WhatsApp message and normalized names used for matching are both preserved.</p>
          {vesselReviews.length ? (
            <table>
              <thead><tr><th>Item</th><th>Original</th><th>Normalized</th></tr></thead>
              <tbody>
                {vesselReviews.map((item) => {
                  const names = reviewVesselNames({payload: item.payload});
                  return (
                    <tr key={item.id}>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id.slice(0, 18)}</td>
                      <td>{names.original.length ? names.original.join(' · ') : '—'}</td>
                      <td>{names.normalized.length ? names.normalized.join(' · ') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : <p className="muted">No vessel review items to normalize.</p>}
        </section>
      </div>

      <div className="split">
        {canCommand ? (
          <ActionForm title="Assign / replace escort" endpoint="/api/programs" action="assign" submitLabel="Assign"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'employeeMobile', label: 'Escort mobile', required: true},
              {name: 'employeeName', label: 'Escort name'},
              {name: 'startDate', label: 'Start date', type: 'date'},
              {name: 'startShift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
            ]} />
        ) : null}
        {canRelease ? (
          <ActionForm title="Release" endpoint="/api/programs" action="release" submitLabel="Release"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'endDate', label: 'End date', type: 'date', required: true},
              {name: 'endShift', label: 'End shift', type: 'select', options: [{value: 'D', label: 'Day'}, {value: 'N', label: 'Night'}]},
              {name: 'note', label: 'Note'},
            ]} />
        ) : null}
        {canCommand ? (
          <ActionForm title="Void" endpoint="/api/programs" action="void" submitLabel="Void program"
            fields={[
              {name: 'programId', label: 'Program id', required: true},
              {name: 'reason', label: 'Reason', required: true},
            ]} />
        ) : null}
      </div>
    </>
  );
}
