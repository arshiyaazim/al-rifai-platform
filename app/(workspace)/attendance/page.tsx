import {pageUser} from '@/lib/standalone/session';
import {can} from '@/lib/standalone/authz';
import {AttendanceView} from '@/components/standalone/attendance-view';

export const dynamic = 'force-dynamic';

export default async function AttendancePage() {
  const user = await pageUser();
  const canManage = can(user as never, 'attendance.manage');
  return (
    <div className="vessel-workspace">
      <AttendanceView canManage={canManage} />
    </div>
  );
}
