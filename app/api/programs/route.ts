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
      assertCapability(actor as never, 'vessel.command');
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
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
      assertCapability(actor as never, 'vessel.release');
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      return ok(await releaseProgram(actor as never, String(body.programId), body as never));
    }
    if (action === 'void') {
      assertCapability(actor as never, 'vessel.command');
      if (!body.programId || !body.reason) return ok({error: 'PROGRAM_AND_REASON_REQUIRED'}, 400);
      return ok(await voidProgram(actor as never, String(body.programId), String(body.reason)));
    }
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
