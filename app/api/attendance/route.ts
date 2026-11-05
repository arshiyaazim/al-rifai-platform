import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {attendanceSummary, deleteAttendance, listAttendance, recordAttendance} from '@/lib/standalone/attendance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await actorFor(request, {csrf: false});
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
    return ok(await recordAttendance(actor, await bodyOf(request)), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const actor = await actorFor(request);
    const id = new URL(request.url).searchParams.get('id');
    if (!id) return ok({error: 'ID_REQUIRED'}, 400);
    return ok(await deleteAttendance(actor, id));
  } catch (error) {
    return errorResponse(error);
  }
}
