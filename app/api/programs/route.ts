import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assignEscort, createProgram, getProgram, listPrograms, releaseProgram, voidProgram} from '@/lib/standalone/programs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) return ok(await getProgram(id));
    return ok({rows: await listPrograms({
      q: url.searchParams.get('q') ?? '',
      state: url.searchParams.get('state') ?? undefined,
      escort: url.searchParams.get('escort') ?? undefined,
    })});
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
      const result = await createProgram(actor, body as never, {channel: 'WEB'});
      return ok(result, 201);
    }
    if (action === 'assign') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      return ok(await assignEscort(actor, String(body.programId), body as never));
    }
    if (action === 'release') {
      if (!body.programId) return ok({error: 'PROGRAM_REQUIRED'}, 400);
      return ok(await releaseProgram(actor, String(body.programId), body as never));
    }
    if (action === 'void') {
      if (!body.programId || !body.reason) return ok({error: 'PROGRAM_AND_REASON_REQUIRED'}, 400);
      return ok(await voidProgram(actor, String(body.programId), String(body.reason)));
    }
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
