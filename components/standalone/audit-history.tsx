import type {AuditHistoryRow} from '@/lib/standalone/review';
import {formatReviewTimestamp} from '@/lib/review-ui';

/** Append-only audit trail for one review item or cash submission. */
export function AuditHistory({events}: {events: AuditHistoryRow[]}) {
  return (
    <section className="card">
      <h3>Audit history ({events.length})</h3>
      {!events.length ? (
        <p className="muted">No audit events recorded for this item yet.</p>
      ) : (
        <table>
          <thead><tr><th>When</th><th>Action</th><th>Actor</th><th>Source</th><th>Detail</th></tr></thead>
          <tbody>
            {events.map((event) => (
              <tr key={event.id}>
                <td style={{whiteSpace: 'nowrap'}}>{formatReviewTimestamp(event.at)}</td>
                <td><span className="pill">{event.action}</span></td>
                <td>
                  {event.actor_name ?? event.actor.slice(0, 12)}
                  <div className="muted" style={{fontSize: 11}}>{event.entity}{event.entity_id ? ` · ${event.entity_id.slice(0, 18)}` : ''}</div>
                </td>
                <td>{event.source}{event.source_ref ? <div className="muted" style={{fontSize: 11}}>{event.source_ref}</div> : null}</td>
                <td style={{maxWidth: 360}}>
                  {event.detail && Object.keys(event.detail).length ? (
                    <pre style={{margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 11}}>{JSON.stringify(event.detail, null, 2)}</pre>
                  ) : <span className="muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
