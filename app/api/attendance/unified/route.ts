import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {unifiedAttendance} from '@/lib/standalone/attendance-records';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'attendance.read');
    const url = new URL(request.url);
    const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
    return ok(await unifiedAttendance({
      employeeMobile: url.searchParams.get('employee_mobile') ?? undefined,
      month,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
