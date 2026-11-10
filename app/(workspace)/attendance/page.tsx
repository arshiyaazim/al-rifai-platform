import {AttendanceView} from '@/components/standalone/attendance-view';

export const dynamic = 'force-dynamic';

export default function AttendancePage() {
  return (
    <div className="vessel-workspace">
      <AttendanceView />
    </div>
  );
}
