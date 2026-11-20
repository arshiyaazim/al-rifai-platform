import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assignEscort, completeProgram, countPrograms, createProgram, getProgram, listPrograms, releaseProgram, startProgramDuty, updateProgram, voidProgram} from '@/lib/standalone/programs';
import {assertCapability, can} from '@/lib/standalone/authz';
import {submitForReview} from '@/lib/standalone/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) return ok(await getProgram(id));
    const filters = {
      q: url.searchParams.get('q') ?? '',
      state: url.searchParams.get('state') ?? undefined,
      escort: url.searchParams.get('escort') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 200),
      offset: Number(url.searchParams.get('offset') ?? 0),
    };
    const [rows, total] = await Promise.all([listPrograms(filters), countPrograms(filters)]);
    return ok({rows, total, limit: filters.limit, offset: filters.offset});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    const action = body.action ?? 'create';
    if (action === 'create') {
      assertCapability(actor as never, 'vessel.submit');
      if (!can(actor as never, 'vessel.command')) {
        const review = await submitForReview(actor as never, {
          domain: 'PROGRAM',
          action: 'CREATE',
          payload: body,
        });
        return ok({pending: true, review}, 202);
      }
      const result = await createProgram(actor as never, body as never, {channel: 'WEB'});
      return ok(result, 201);
    }
    if (action === 'update') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      assertCapability(actor as never, 'vessel.submit');
      if (!can(actor as never, 'vessel.command')) {
        const review = await submitForReview(actor as never, {
          domain: 'PROGRAM',
          action: 'UPDATE',
          targetRef: String(body.programId),
          payload: body,
        });
        return ok({pending: true, review}, 202);
      }
      return ok(await updateProgram(actor as never, String(body.programId), body as never));
    }
    if (action === 'assign') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      if (!can(actor as never, 'vessel.command')) {
        assertCapability(actor as never, 'vessel.submit');
        const current = await getProgram(String(body.programId));
        const review = await submitForReview(actor as never, {
          domain: 'PROGRAM', action: 'UPDATE', targetRef: String(body.programId),
          payload: {
            motherVessel: current.program.mother_vessel,
            lighterVessel: current.program.lighter_vessel,
            masterMobile: current.program.master_mobile,
            destination: current.program.destination,
            startDate: current.program.start_date,
            startShift: current.program.start_shift,
            endDate: current.program.end_date,
            endShift: current.program.end_shift,
            notes: current.program.notes,
            escortMobile: body.escortMobile ?? body.employeeMobile ?? null,
            escortName: body.escortName ?? body.employeeName ?? null,
          },
        });
        return ok({pending: true, review}, 202);
      }
      assertCapability(actor as never, 'vessel.command');
      const replace = body.replace === true || body.replace === 'yes' || body.replace === '1';
      return ok(await assignEscort(actor as never, String(body.programId), {...body, replace} as never));
    }
    if (action === 'start') {
      assertCapability(actor as never, 'vessel.command');
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      return ok(await startProgramDuty(actor as never, String(body.programId)));
    }
    if (action === 'complete') {
      assertCapability(actor as never, 'vessel.release');
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      return ok(await completeProgram(actor as never, String(body.programId)));
    }
    if (action === 'release') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      if (!can(actor as never, 'vessel.release')) {
        assertCapability(actor as never, 'vessel.submit');
        const current = await getProgram(String(body.programId));
        const review = await submitForReview(actor as never, {
          domain: 'PROGRAM', action: 'UPDATE', targetRef: String(body.programId),
          payload: {
            motherVessel: current.program.mother_vessel,
            lighterVessel: current.program.lighter_vessel,
            masterMobile: current.program.master_mobile,
            destination: current.program.destination,
            escortName: current.program.escort_name,
            escortMobile: current.program.escort_mobile,
            startDate: current.program.start_date,
            startShift: current.program.start_shift,
            endDate: body.endDate ?? body.releaseDate ?? null,
            endShift: body.endShift ?? body.releaseShift ?? null,
            notes: body.notes ?? current.program.notes,
          },
        });
        return ok({pending: true, review}, 202);
      }
      assertCapability(actor as never, 'vessel.release');
      return ok(await releaseProgram(actor as never, String(body.programId), body as never));
    }
    if (action === 'void') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      if (!can(actor as never, 'vessel.command')) {
        assertCapability(actor as never, 'vessel.submit');
        const review = await submitForReview(actor as never, {
          domain: 'PROGRAM', action: 'DELETE', targetRef: String(body.programId),
          payload: {reason: String(body.reason ?? 'Void requested from vessel register')},
        });
        return ok({pending: true, review}, 202);
      }
      assertCapability(actor as never, 'vessel.command');
      if (!body.reason) return ok({error: 'REASON_REQUIRED'}, 400);
      return ok(await voidProgram(actor as never, String(body.programId), String(body.reason)));
    }
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
