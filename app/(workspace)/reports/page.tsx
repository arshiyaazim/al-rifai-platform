import {listAudit} from '@/lib/standalone/audit';
import {when} from '@/lib/standalone/session';

export const dynamic = 'force-dynamic';

const REPORTS = [
  {type: 'employees', label: 'Employees'},
  {type: 'programs', label: 'Vessel programs'},
  {type: 'attendance', label: 'Attendance'},
  {type: 'cash', label: 'Payment instructions'},
  {type: 'ledger', label: 'Ledger'},
  {type: 'payroll', label: 'Payroll'},
  {type: 'audit', label: 'Audit trail'},
];

export default async function ReportsPage() {
  const audit = await listAudit({limit: 100});
  return (
    <>
      <div className="page-head">
        <div><h1>Reports &amp; Archive</h1><p className="muted">CSV exports and the immutable audit trail.</p></div>
      </div>

      <section className="card">
        <h3>CSV exports</h3>
        <div className="row-actions">
          {REPORTS.map((report) => (
            <a key={report.type} className="pill" href={`/api/reports?type=${report.type}`}>{report.label}</a>
          ))}
        </div>
        <p className="muted" style={{marginTop: 10}}>Exports respect the signed-in session and contain only this installation&apos;s data.</p>
      </section>

      <section className="card">
        <h3>Audit trail (latest 100)</h3>
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Source</th></tr></thead>
          <tbody>
            {audit.map((entry) => (
              <tr key={entry.id}>
                <td>{when(entry.at)}</td>
                <td>{entry.actor.slice(0, 12)}</td>
                <td>{entry.action}</td>
                <td>{entry.entity}{entry.entity_id ? ` · ${entry.entity_id.slice(0, 20)}` : ''}</td>
                <td>{entry.source}</td>
              </tr>
            ))}
            {!audit.length ? <tr><td colSpan={5} className="muted">No audit records yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </>
  );
}
