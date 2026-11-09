import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {listAuditEvents} from '@/lib/standalone/audit-view';
import {AuditTrailViewer} from '@/components/standalone/audit-trail-viewer';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

export const dynamic = 'force-dynamic';

export default async function AuditPage() {
  const user = await pageUser();
  if (user.role !== 'ADMIN' || !can(user as never, 'audit.read')) {
    return (
      <section className="card">
        <h3>Audit Trail</h3>
        <p className="muted">This page is restricted to administrators with the <code>audit.read</code> capability.</p>
      </section>
    );
  }
  const initial = await listAuditEvents({page: 1, limit: 50});
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Audit Trail</h1>
          <p className="muted">
            Unified, append-only view of <code>audit_events</code> and vessel <code>program_events</code>.
            Every mutation keeps its actor, target, payload and source message.
          </p>
        </div>
        <RealtimeRefresher domain="ANY" label="Live audit" />
      </div>
      <AuditTrailViewer initial={initial} />
    </>
  );
}
