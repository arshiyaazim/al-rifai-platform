import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {attendanceRecordById, updateAttendanceRecord, voidAttendanceRecord} from '@/lib/standalone/attendance-records';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'attendance.read');
    const {id} = await context.params;
    const record = await attendanceRecordById(decodeURIComponent(id));
    if (!record) return ok({error: 'ATTENDANCE_NOT_FOUND'}, 404);
    return ok({record});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'attendance.manage');
    const {id} = await context.params;
    const body = await bodyOf(request);
    return ok(await updateAttendanceRecord(actor as never, decodeURIComponent(id), body as never));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'attendance.manage');
    const {id} = await context.params;
    return ok(await voidAttendanceRecord(actor as never, decodeURIComponent(id)));
  } catch (error) {
    return errorResponse(error);
  }
}
