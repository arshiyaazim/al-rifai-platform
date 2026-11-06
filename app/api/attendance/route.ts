import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {attendanceSummary, deleteAttendance, listAttendance, recordAttendance} from '@/lib/standalone/attendance';
import {assertCapability, can} from '@/lib/standalone/authz';
import {submitForReview} from '@/lib/standalone/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'attendance.read');
    const url = new URL(request.url);
    if (url.searchParams.get('view') === 'summary') {
      return ok({rows: await attendanceSummary(url.searchParams.get('month') ?? undefined)});
    }
    return ok({rows: await listAttendance({
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      employee: url.searchParams.get('employee') ?? undefined,
    })});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'attendance.submit');
    const body = await bodyOf(request);
    if (!can(actor as never, 'attendance.manage')) {
      const review = await submitForReview(actor as never, {
        domain: 'ATTENDANCE',
        action: 'CREATE',
        payload: body,
      });
      return ok({pending: true, review}, 202);
    }
    return ok(await recordAttendance(actor as never, body as never), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'attendance.manage');
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return ok({error: 'ID_REQUIRED'}, 400);
    return ok(await deleteAttendance(actor as never, id));
  } catch (error) {
    return errorResponse(error);
  }
}
