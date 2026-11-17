import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {Suspense} from 'react';
import {AttendanceView} from '@/components/standalone/attendance-view';

export const dynamic = 'force-dynamic';

export default async function AttendancePage() {
  const user = await pageUser();
  const canManage = can(user as never, 'attendance.manage');
  return (
    <div className="vessel-workspace">
      <Suspense fallback={<p className="muted">Loading attendance…</p>}>
        <AttendanceView canManage={canManage} />
      </Suspense>
    </div>
  );
}
