import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {attendanceRecordById, updateAttendanceRecord, voidAttendanceRecord} from '@/lib/standalone/attendance-records';
import {assertCapability, can} from '@/lib/standalone/authz';
import {submitForReview} from '@/lib/standalone/review';

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
    const {id} = await context.params;
    const recordId = decodeURIComponent(id);
    const body = await bodyOf(request);
    if (!can(actor as never, 'attendance.manage')) {
      assertCapability(actor as never, 'attendance.submit');
      const review = await submitForReview(actor as never, {
        domain: 'ATTENDANCE',
        action: 'UPDATE',
        targetRef: recordId,
        payload: {...body, id: recordId},
      });
      return ok({pending: true, review}, 202);
    }
    assertCapability(actor as never, 'attendance.manage');
    return ok(await updateAttendanceRecord(actor as never, recordId, body as never));
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    const {id} = await context.params;
    const recordId = decodeURIComponent(id);
    if (!can(actor as never, 'attendance.manage')) {
      assertCapability(actor as never, 'attendance.submit');
      const review = await submitForReview(actor as never, {
        domain: 'ATTENDANCE',
        action: 'DELETE',
        targetRef: recordId,
        payload: {id: recordId},
      });
      return ok({pending: true, review}, 202);
    }
    assertCapability(actor as never, 'attendance.manage');
    return ok(await voidAttendanceRecord(actor as never, recordId));
  } catch (error) {
    return errorResponse(error);
  }
}
