import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {getProgram} from '@/lib/standalone/programs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Program detail alias; same read model as /api/programs?id=... */
export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const {id} = await context.params;
    return ok(await getProgram(decodeURIComponent(id)));
  } catch (error) {
    return errorResponse(error);
  }
}
