import Link from 'next/link';
import {notFound} from 'next/navigation';
import {getBusinessPaidEventDetail, paidEventsEnabled} from '@/lib/standalone/finance';
import {DomainError} from '@/lib/standalone/db';
import {pageUser, money} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {dhakaTimestamp, formatPayoutNumber} from '@/lib/standalone/cash-dashboard';
import {ActionForm} from '@/components/standalone/action-form';

export const dynamic = 'force-dynamic';

type EventRow = {
  id: string; event_type: string; status: string;
  employee_mobile: string; payout_mobile: string; employee_name: string;
  employee_link_status: string; amount_minor: string; method: string;
  source_category: string; source_message_id: string | null; source_block_key: string | null;
  paid_at: string; reason: string | null; corrects_event_id: string | null;
  reverses_event_id: string | null; created_by: string; created_at: string;
  instruction_id: string | null; source_submission_id: string | null;
};

type EmployeeRow = {
  employee_mobile: string; preferred_name: string; name_aliases: string[];
  designation: string | null; state: string; joined_on: string | null;
};

type InstructionRow = {
  id: string; state: string; account_code: string | null; account_name: string | null;
  posting_id: string | null; financial_posted_at: string | null; posted_by: string | null;
};

type SubmissionRow = {
  id: string; state: string; submitted_by: string; created_at: string;
  decided_at: string | null; decided_by: string | null; decision_reason: string | null;
  source_message_id: string | null; category: string | null;
};

type PostingLinkRow = {
  payment_event_id: string; instruction_id: string; posting_id: string;
  posted_at: string; posted_by: string; posted_amount_minor: string;
};

type AuditRow = {
  id: string; at: string; actor: string; actor_role: string | null;
  action: string; detail: Record<string, unknown>; source: string; source_ref: string | null;
};

function eventTone(type: string): string {
  if (type === 'REVERSAL') return 'bad';
  if (type === 'CORRECTION') return 'warn';
  return 'ok';
}

export default async function BusinessPaidDetailPage({params}: {params: Promise<{id: string}>}) {
  const user = await pageUser();
  if (!can(user as never, 'cash.read')) {
    return <section className="card"><h3>Access denied</h3><p className="muted">Cash read permission is required.</p></section>;
  }
  const {id} = await params;
  let detail;
  try {
    detail = await getBusinessPaidEventDetail(decodeURIComponent(id));
  } catch (error) {
    if (error instanceof DomainError && error.status === 404) notFound();
    throw error;
  }

  const event = detail.event as unknown as EventRow;
  const employee = detail.employee as unknown as EmployeeRow | null;
  const instruction = detail.instruction as unknown as InstructionRow | null;
  const submission = detail.submission as unknown as SubmissionRow | null;
  const postingLink = detail.postingLink as unknown as PostingLinkRow | null;
  const corrections = detail.corrections as unknown as EventRow[];
  const reversal = detail.reversal as unknown as EventRow | null;
  const audit = detail.audit as unknown as AuditRow[];

  const canCorrect = can(user as never, 'cash.review');
  const flagOn = paidEventsEnabled();
  const latestAmount = corrections[0]?.amount_minor ?? event.amount_minor;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Business Paid Event</h1>
          <p className="muted" style={{fontFamily: 'ui-monospace, monospace'}}>{event.id}</p>
        </div>
        <div className="row-actions">
          <Link href="/cash/paid">← Business Paid</Link>
          <Link href="/cash">Cash control</Link>
          {event.source_message_id ? (
            <Link href={`/messages?q=${encodeURIComponent(event.source_message_id)}`}>Source message →</Link>
          ) : null}
          {instruction ? <Link href={`/cash/${encodeURIComponent(instruction.id)}`}>Instruction →</Link> : null}
        </div>
      </div>

      <div className="grid-cards">
        <div className="stat"><div className="label">Business Paid</div><div className="value">{money(latestAmount)}</div><div className="muted">{event.status}</div></div>
        <div className="stat"><div className="label">Method</div><div className="value">{event.method}</div><div className="muted">{formatPayoutNumber(event.payout_mobile, event.method)}</div></div>
        <div className="stat"><div className="label">Source</div><div className="value">{event.source_category}</div><div className="muted">Business layer</div></div>
        <div className="stat"><div className="label">Financial</div><div className="value">{postingLink ? 'POSTED' : 'NOT POSTED'}</div><div className="muted">Separate ledger status</div></div>
      </div>

      <div className="split">
        <section className="card">
          <h3>Business Paid Event</h3>
          <table>
            <tbody>
              <tr><th>Event ID</th><td>{event.id}</td></tr>
              <tr><th>Type / status</th><td><span className={`pill ${eventTone(event.event_type)}`}>{event.event_type} · {event.status}</span></td></tr>
              <tr><th>Employee name</th><td>{event.employee_name}</td></tr>
              <tr><th>Employee ID / mobile</th><td>{event.employee_mobile}</td></tr>
              <tr><th>Payout number</th><td>{event.payout_mobile}</td></tr>
              <tr><th>Amount</th><td>{money(event.amount_minor)}</td></tr>
              <tr><th>Method</th><td>{event.method}</td></tr>
              <tr><th>Business paid at</th><td>{dhakaTimestamp(event.paid_at)}</td></tr>
              <tr><th>Source category</th><td>{event.source_category}</td></tr>
              <tr><th>Created by / at</th><td>{event.created_by.slice(0, 12)} · {dhakaTimestamp(event.created_at)}</td></tr>
              {event.reason ? <tr><th>Reason</th><td>{event.reason}</td></tr> : null}
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Employee &amp; Payout</h3>
          <table>
            <tbody>
              <tr><th>Canonical employee mobile</th><td>{event.employee_mobile}</td></tr>
              <tr><th>Payout number</th><td>{event.payout_mobile}</td></tr>
              <tr><th>Employee link</th><td>{event.employee_link_status}</td></tr>
              <tr><th>Registered name</th><td>{employee?.preferred_name ?? '—'}</td></tr>
              <tr><th>Designation</th><td>{employee?.designation ?? '—'}</td></tr>
              <tr><th>Joined on</th><td>{employee?.joined_on ?? '—'}</td></tr>
              <tr><th>Record state</th><td>{employee?.state ?? 'NOT REGISTERED'}</td></tr>
            </tbody>
          </table>
          {employee ? (
            <p className="muted"><Link href={`/employees/${encodeURIComponent(event.employee_mobile)}`}>Open employee record →</Link></p>
          ) : (
            <p className="muted">No canonical employee record exists. The payment is recorded against the mobile number only; it is never attached to another employee.</p>
          )}
        </section>
      </div>

      <div className="split">
        <section className="card">
          <h3>WhatsApp / Office Evidence</h3>
          <table>
            <tbody>
              <tr><th>Source</th><td>{event.source_category}</td></tr>
              <tr><th>WhatsApp message ID</th><td>{event.source_message_id ? <Link href={`/messages?q=${encodeURIComponent(event.source_message_id)}`}>{event.source_message_id}</Link> : '—'}</td></tr>
              <tr><th>WhatsApp block key</th><td>{event.source_block_key ?? '—'}</td></tr>
              <tr><th>Office submission</th><td>{submission ? <Link href={`/cash/submissions?q=${encodeURIComponent(submission.id)}`}>{submission.id}</Link> : '—'}</td></tr>
              <tr><th>Submission state</th><td>{submission?.state ?? '—'}</td></tr>
              <tr><th>Submission decision</th><td>{submission?.decision_reason ?? '—'}</td></tr>
            </tbody>
          </table>
        </section>

        <section className="card">
          <h3>Financial Posting Status</h3>
          <table>
            <tbody>
              <tr><th>Instruction</th><td>{instruction ? <Link href={`/cash/${encodeURIComponent(instruction.id)}`}>{instruction.id}</Link> : '—'}</td></tr>
              <tr><th>Instruction state</th><td>{instruction?.state ?? '—'}</td></tr>
              <tr><th>Financial posting</th><td>{postingLink?.posting_id ?? instruction?.posting_id ?? '—'}</td></tr>
              <tr><th>Posted at</th><td>{dhakaTimestamp(postingLink?.posted_at ?? instruction?.financial_posted_at)}</td></tr>
              <tr><th>Posted by</th><td>{postingLink?.posted_by ?? instruction?.posted_by ?? '—'}</td></tr>
            </tbody>
          </table>
          <p className="muted">
            Business Paid does not mean the ledger is POSTED. Posting remains a separate
            <code> cash.post </code> action and is never created by this page.
          </p>
        </section>
      </div>

      <section className="card">
        <h3>Correction / Reversal Timeline</h3>
        <table>
          <thead><tr><th>When</th><th>Type</th><th>Amount</th><th>Reason</th><th>By</th><th>Links</th></tr></thead>
          <tbody>
            <tr>
              <td>{dhakaTimestamp(event.paid_at)}</td>
              <td><span className="pill ok">PAYMENT</span></td>
              <td>{money(event.amount_minor)}</td>
              <td>{event.reason ?? 'Original verified payment'}</td>
              <td className="muted">{event.created_by.slice(0, 12)}</td>
              <td>—</td>
            </tr>
            {corrections.map((entry) => (
              <tr key={entry.id}>
                <td>{dhakaTimestamp(entry.created_at)}</td>
                <td><span className="pill warn">CORRECTION</span></td>
                <td>{money(entry.amount_minor)}</td>
                <td>{entry.reason ?? '—'}</td>
                <td className="muted">{entry.created_by.slice(0, 12)}</td>
                <td><code>{entry.id}</code></td>
              </tr>
            ))}
            {reversal ? (
              <tr>
                <td>{dhakaTimestamp(reversal.created_at)}</td>
                <td><span className="pill bad">REVERSAL</span></td>
                <td>{money(reversal.amount_minor)}</td>
                <td>{reversal.reason ?? '—'}</td>
                <td className="muted">{reversal.created_by.slice(0, 12)}</td>
                <td><code>{reversal.id}</code></td>
              </tr>
            ) : null}
            {!corrections.length && !reversal ? (
              <tr><td colSpan={6} className="muted">No corrections or reversals.</td></tr>
            ) : null}
          </tbody>
        </table>
      </section>

      {canCorrect ? (
        <div className="split">
          {flagOn && !reversal ? (
            <ActionForm
              title="Correct Business Paid Event"
              endpoint="/api/finance"
              action="business-paid.correct"
              submitLabel="Append correction"
              hidden={{eventId: event.id}}
              fields={[
                {name: 'amountMinor', label: 'Corrected amount (paisa)', type: 'number', required: true, defaultValue: String(Number(latestAmount))},
                {name: 'employeeName', label: 'Employee name (optional)', defaultValue: event.employee_name},
                {name: 'method', label: 'Method', type: 'select', defaultValue: event.method, options: [
                  {value: 'bkash', label: 'bKash'}, {value: 'nagad', label: 'Nagad'}, {value: 'rocket', label: 'Rocket'},
                  {value: 'bank', label: 'Bank'}, {value: 'cash', label: 'Cash'}]},
                {name: 'reason', label: 'Reason (required)', type: 'textarea', required: true},
              ]}
            />
          ) : null}
          {flagOn && !reversal ? (
            <ActionForm
              title="Reverse Business Paid Event"
              endpoint="/api/finance"
              action="business-paid.reverse"
              submitLabel="Append reversal"
              hidden={{eventId: event.id}}
              fields={[{name: 'reason', label: 'Reason (required)', type: 'textarea', required: true}]}
            />
          ) : null}
          {!flagOn ? (
            <section className="card"><h3>Correction / reversal disabled</h3><p className="muted">PHASE3_PAID_EVENTS_ENABLED is off. Existing events remain immutable.</p></section>
          ) : null}
          {reversal ? (
            <section className="card"><h3>Already reversed</h3><p className="muted">No further correction or reversal is allowed for this event.</p></section>
          ) : null}
        </div>
      ) : null}

      <section className="card">
        <h3>Audit Trail ({audit.length})</h3>
        <table>
          <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Detail</th></tr></thead>
          <tbody>
            {audit.map((entry) => (
              <tr key={entry.id}>
                <td style={{whiteSpace: 'nowrap'}}>{dhakaTimestamp(entry.at)}</td>
                <td>{entry.action}</td>
                <td className="muted">{entry.actor.slice(0, 12)} · {entry.actor_role ?? '—'}</td>
                <td style={{maxWidth: 420, wordBreak: 'break-word'}}><code style={{fontSize: 11}}>{JSON.stringify(entry.detail)}</code></td>
              </tr>
            ))}
            {!audit.length ? <tr><td colSpan={4} className="muted">No audit history.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}