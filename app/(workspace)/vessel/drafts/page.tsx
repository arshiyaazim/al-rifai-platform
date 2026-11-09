import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {listPrograms, potentialDuplicates} from '@/lib/standalone/programs';
import {listEmployees} from '@/lib/standalone/employees';
import {listReviewQueue} from '@/lib/standalone/review';
import {
  ownerDraftFromProgram,
  ownerDraftFromReviewPayload,
} from '@/lib/order-draft-from-record';import {OwnerDraftPanel} from '@/components/standalone/owner-draft-panel';
import {ActionForm} from '@/components/standalone/action-form';
import {
  deliveryStatusForPrograms,
  runtimeDeliveryGate,
} from '@/lib/standalone/vessel-draft-delivery-store';
import {CONFIRMATION_RULE} from '@/lib/vessel-draft-delivery';
import {vesselDraftWorkerStatus} from '@/lib/vessel-draft-delivery-worker';
import {DraftInlineAssign} from '@/components/standalone/draft-inline-assign';

export const dynamic = 'force-dynamic';

/**
 * Admin order-draft workspace.
 *
 * This page is the missing bridge between an authorized WA-01 order and the
 * Admin's confirmation reply. It renders the exact Owner draft for every DRAFT
 * program and every unresolved PROGRAM review item. It is deliberately
 * read-only: no WhatsApp message is sent and no assignment is applied here.
 */
export default async function VesselDraftsPage() {
  const user = await pageUser();
  const canRead = can(user as never, 'vessel.read');
  const canCommand = can(user as never, 'vessel.command');

  const [draftPrograms, confirmedPrograms, programReviews, gate, escorts] = await Promise.all([
    listPrograms({state: 'DRAFT', limit: 100}),
    listPrograms({state: 'CONFIRMED', limit: 100}),
    listReviewQueue({domain: 'PROGRAM', state: 'PENDING', limit: 200}),
    runtimeDeliveryGate(),
    listEmployees({state: 'ACTIVE', limit: 500}),
  ]);
  const duplicateMap = new Map<string, Array<{id: string; start_date: string}>>();
  for (const program of draftPrograms) {
    duplicateMap.set(program.id, await potentialDuplicates({
      motherVessel: program.mother_vessel,
      lighterVessel: program.lighter_vessel,
      startDate: program.start_date,
      excludeId: program.id,
    }));
  }
  const clientAssignmentReviews = programReviews.filter((item) =>
    JSON.stringify(item.payload).includes('CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN'));

  const programDrafts = [...draftPrograms, ...confirmedPrograms]
    .map((program) => ({program, draft: ownerDraftFromProgram(program)}));
  const deliveryStatus = await deliveryStatusForPrograms(
    programDrafts.map(({program}) => program.id),
  );
  const workerStatus = vesselDraftWorkerStatus();
  const deliveryCounts = deliveryStatus.reduce<Record<string, number>>((counts, item) => {
    counts[item.state] = (counts[item.state] ?? 0) + 1;
    return counts;
  }, {});
  const pendingDeliveries = (deliveryCounts.QUEUED ?? 0) + (deliveryCounts.SENDING ?? 0);
  const reviewDrafts = programReviews
    .map((item) => ({item, draft: ownerDraftFromReviewPayload(item.payload)}))
    .filter(({draft}) => !(draft.gaps.includes('MISSING_MOTHER_VESSEL')
      && draft.gaps.includes('MISSING_LIGHTER_VESSEL')));
  const unparsedReviews = programReviews.length - reviewDrafts.length;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Vessel Order Drafts</h1>
          <p className="muted">
            Authorized WA-01 order → extracted fields → Owner draft → Admin assignment → confirmation → Vessel Program.
          </p>
        </div>
        <div className="row-actions">
          <Link href="/vessel">Vessel Register →</Link>
          <Link href="/review?domain=PROGRAM">Program review queue →</Link>
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat">
          <div className="label">Draft programs</div>
          <div className="value">{draftPrograms.length}</div>
          <div className="muted">state DRAFT</div>
        </div>
        <div className="stat">
          <div className="label">Awaiting confirmation</div>
          <div className="value">{confirmedPrograms.length}</div>
          <div className="muted">state CONFIRMED</div>
        </div>
        <div className="stat">
          <div className="label">Program reviews</div>
          <div className="value">{programReviews.length}</div>
          <div className="muted">{unparsedReviews} without vessel fields</div>
        </div>
        <div className="stat">
          <div className="label">Delivery</div>
          <div className="value" style={{fontSize: 15}}>{gate.gate.mode}</div>
          <div className="muted">{gate.gate.enabled ? 'WA-01 outbound enabled' : 'gate disabled'}</div>
        </div>
        <div className="stat">
          <div className="label">Pending deliveries</div>
          <div className="value">{pendingDeliveries}</div>
          <div className="muted">{deliveryCounts.SENT ?? 0} sent · {deliveryCounts.FAILED ?? 0} failed · {deliveryCounts.DELIVERY_UNKNOWN ?? 0} unknown</div>
        </div>
      </div>

      {!canRead ? (
        <section className="card">
          <h3>Read permission required</h3>
          <p className="muted">This account cannot read vessel records. No draft data is shown.</p>
        </section>
      ) : (
        <>
          <section className="card">
            <h3>Why the draft may not reach WhatsApp</h3>
            <table>
              <tbody>
                <tr><th style={{width: 260}}>Router</th><td>Live WA-01 messages above the cutover rowid are processed; older messages stay historical by design.</td></tr>
                <tr><th>Draft creation</th><td>An authorized order creates a vessel Program in state <code>DRAFT</code>.</td></tr>
                <tr><th>Template</th><td>This page renders the exact Owner layout from the program or review record.</td></tr>
                <tr><th>Transport</th><td>{gate.gate.enabled
                  ? <>WA-01 outbound is enabled for the original order conversation only. The worker verifies the bridge identity and re-resolves the source conversation before every send.</>
                  : <>No outbound WhatsApp sender is enabled. <strong>{gate.gate.mode}</strong>.</>}</td></tr>
                <tr><th>Confirmation</th><td>The Admin&apos;s outgoing reply (escort name/mobile/date/shift) is still applied by <code>applyConfirmation()</code>.</td></tr>
              </tbody>
            </table>
          </section>

          <section className="card" style={{marginTop: 18}}>
            <h3>Draft delivery status</h3>
            <table>
              <tbody>
                <tr><th style={{width: 260}}>Delivery mode</th><td><span className="pill">{gate.gate.mode}</span></td></tr>
                <tr><th>Outbound gate</th><td>{gate.gate.enabled
                  ? <span className="pill ok">enabled</span>
                  : <span className="pill warn">disabled — {gate.gate.reasons.join(', ')}</span>}</td></tr>
                <tr><th>Sender account</th><td>{gate.config.ownerApprovedSender ?? '—'}</td></tr>
                <tr><th>Transport configured</th><td>{gate.config.transportConfigured ? 'yes' : 'no'}</td></tr>
                <tr><th>Approved conversations</th><td>{gate.config.authorizedRecipientJids?.length ?? 0} (original order chat must be one of them)</td></tr>
                <tr><th>Worker enabled</th><td>{workerStatus.enabled ? 'yes' : 'no'}</td></tr>
                <tr><th>Worker</th><td>{workerStatus.started
                  ? <span className="pill ok">started · {workerStatus.intervalMs}ms</span>
                  : <span className="pill warn">not started · {workerStatus.enabled ? 'gate/status check' : 'disabled'}</span>}</td></tr>
                <tr><th>Last worker run</th><td>{workerStatus.lastResult
                  ? `${workerStatus.lastResult.at} · claimed ${workerStatus.lastResult.claimed} · sent ${workerStatus.lastResult.sent} · failed ${workerStatus.lastResult.failed} · unknown ${workerStatus.lastResult.unknown}`
                  : '—'}</td></tr>
                <tr><th>Last idle reason</th><td>{workerStatus.lastReason ?? '—'}</td></tr>
                <tr><th>Durable records</th><td>{deliveryStatus.length} for the programs above · {pendingDeliveries} pending</td></tr>
                <tr><th>Confirmation authority</th><td>{CONFIRMATION_RULE}</td></tr>
              </tbody>
            </table>
            {deliveryStatus.length ? (
              <table style={{marginTop: 12}}>
                <thead><tr><th>Program</th><th>State</th><th>Attempts</th><th>Next retry</th><th>Recipient conversation</th><th>Source message</th><th>WhatsApp message ID</th><th>Updated</th><th>Error</th></tr></thead>
                <tbody>
                  {deliveryStatus.map((item) => (
                    <tr key={item.id}>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.program_id.slice(0, 20)}</td>
                      <td><span className={`pill ${item.state === 'SENT' ? 'ok' : item.state === 'DELIVERY_UNKNOWN' || item.state === 'DEAD' ? 'bad' : ''}`}>{item.state}</span></td>
                      <td>{item.attempts}</td>
                      <td>{item.next_attempt_at ?? '—'}</td>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.recipient_jid}</td>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.source_message_id ?? '—'}</td>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.delivery_ref ?? '—'}</td>
                      <td>{item.updated_at}</td>
                      <td>{item.error ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted" style={{marginTop: 10}}>
                No delivery records exist yet.
                {gate.gate.enabled
                  ? ' New eligible DRAFT programs will enter the queue; the worker sends only to the original authorised order conversation.'
                  : ' The outbound gate is disabled, so the platform stays '}
                {gate.gate.enabled ? null : <strong>{gate.gate.mode}</strong>}
                {gate.gate.enabled ? null : ' and sends nothing.'}
              </p>
            )}
          </section>

          <section className="card" style={{marginTop: 18}}>
            <h3>Assign an escort to a Draft ({draftPrograms.length} DRAFT)</h3>
            <p className="muted">
              Assignment records the escort and start date/shift. Final <strong>CONFIRMED</strong> state requires the
              Admin&apos;s WA-01 outgoing confirmation in the same original client chat.
            </p>
            {canRead && draftPrograms.length && escorts.length ? (
              <ActionForm
                title="Admin assignment"
                endpoint="/api/programs"
                action="assign"
                submitLabel="Assign escort"
                fields={[
                  {name: 'programId', label: 'Draft program', type: 'select', required: true, options: draftPrograms.map((program) => ({
                    value: program.id,
                    label: `${program.mother_vessel} → ${program.lighter_vessel} · ${program.start_date} ${program.start_shift}`,
                  }))},
                  {name: 'employeeMobile', label: 'Escort (searchable list)', type: 'select', required: true, options: escorts.map((employee) => ({
                    value: employee.employee_mobile,
                    label: `${employee.preferred_name} · ${employee.employee_mobile}`,
                  }))},
                  {name: 'employeeName', label: 'Escort name override'},
                  {name: 'startDate', label: 'Start date', type: 'date'},
                  {name: 'startShift', label: 'Shift', type: 'select', options: [{value: 'D', label: 'Day (D)'}, {value: 'N', label: 'Night (N)'}]},
                ]}
              />
            ) : <p className="muted">No DRAFT programs or no active escorts are available.</p>}
          </section>

          <section className="card" style={{marginTop: 18}}>
            <h3>DRAFT programs ({draftPrograms.length})</h3>
            <p className="muted">Assign an escort inline, or use the three-dot action for the full detail sidebar.</p>
            <DraftInlineAssign
              drafts={draftPrograms.map((program) => ({
                id: program.id,
                mother_vessel: program.mother_vessel,
                lighter_vessel: program.lighter_vessel,
                master_mobile: program.master_mobile,
                start_date: program.start_date,
                start_shift: program.start_shift,
                created_at: program.created_at,
                source_chat_jid: program.source_chat_jid,
                escort_name: program.escort_name,
                escort_mobile: program.escort_mobile,
                state: program.state,
              }))}
              escorts={escorts.map((employee) => ({mobile: employee.employee_mobile, name: employee.preferred_name}))}
              duplicates={Object.fromEntries(duplicateMap)}
              canCommand={canCommand}
            />
          </section>

          {clientAssignmentReviews.length ? (
            <section className="card" style={{marginTop: 18}}>
              <h3>Client assignment fields require Admin ({clientAssignmentReviews.length})</h3>
              <p className="muted">A client message carried Escort Name/Mobile. It is preserved for review and never became a Draft.</p>
              <table>
                <thead><tr><th>Review item</th><th>Source message</th><th>Created</th><th>Inspect</th></tr></thead>
                <tbody>
                  {clientAssignmentReviews.map((item) => (
                    <tr key={item.id}>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.id}</td>
                      <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{item.target_ref ?? '—'}</td>
                      <td style={{whiteSpace: 'nowrap'}}>{when(item.created_at)}</td>
                      <td><Link href={`/review/${item.id}`}>Review →</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : null}

          <h2 style={{marginTop: 24}}>Draft programs ({programDrafts.length})</h2>
          {programDrafts.length ? programDrafts.map(({program, draft}) => (
            <div key={program.id}>
              <div className="row-actions" style={{marginBottom: 6}}>
                <span className="pill">{program.state}</span>
                <span className="muted">
                  {program.mother_vessel} → {program.lighter_vessel} · start {program.start_date} · {program.start_shift}
                </span>
                <Link href={`/vessel/${encodeURIComponent(program.id)}`}>Open program →</Link>
                {program.source_message_id ? <Link href={`/messages?q=${encodeURIComponent(program.source_message_id)}`}>Source message →</Link> : null}
              </div>
              <OwnerDraftPanel result={draft} title="Owner order draft" />
            </div>
          )) : <p className="muted">No DRAFT or CONFIRMED vessel programs are waiting for an Admin draft.</p>}

          <h2 style={{marginTop: 24}}>Unresolved order reviews ({reviewDrafts.length})</h2>
          {reviewDrafts.length ? reviewDrafts.map(({item, draft}) => (
            <div key={item.id}>
              <div className="row-actions" style={{marginBottom: 6}}>
                <span className="pill warn">{item.category ?? 'PROGRAM'}</span>
                <span className="muted">{item.id.slice(0, 18)} · {when(item.created_at)}</span>
                <Link href={`/review/${encodeURIComponent(item.id)}`}>Open review item →</Link>
              </div>
              <OwnerDraftPanel result={draft} title="Owner order draft (from review item)" />
            </div>
          )) : <p className="muted">No unresolved PROGRAM review item contains vessel fields.</p>}

          {unparsedReviews > 0 ? (
            <p className="muted">
              {unparsedReviews} PROGRAM review item(s) contain no Mother/Lighter vessel fields (release, food-bill or
              free-text messages). They stay in the Review Queue and are not turned into invented drafts.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
