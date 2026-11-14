import type {AuditHistoryRow} from '@/lib/standalone/review';
import {formatDhakaDateTime} from '@/lib/review-ui';

/** Append-only audit trail for one review item or cash submission. */
export function AuditHistory({events}: {events: AuditHistoryRow[]}) {
  return (
    <section className="card">
      <h3>Audit history ({events.length})</h3>
      {!events.length ? (
        <p className="muted">No audit events recorded for this item yet.</p>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Source</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td style={{whiteSpace: 'nowrap'}}>{formatDhakaDateTime(event.at)}</td>
                <td><span className="pill">{event.action}</span></td>
                <td>{event.actor_name ?? (event.actor.startsWith('system:') ? 'System' : 'Unknown')}</td>
                <td>{event.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
