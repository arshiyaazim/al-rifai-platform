import {actorFor, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {countPrograms, listPrograms} from '@/lib/standalone/programs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Vessel register alias for the existing program list. Same read model. */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'vessel.read');
    const url = new URL(request.url);
    const filters = {
      q: url.searchParams.get('q') ?? '',
      state: url.searchParams.get('state') ?? undefined,
      escort: url.searchParams.get('escort') ?? undefined,
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 100),
      offset: Number(url.searchParams.get('offset') ?? 0),
    };
    const [rows, total] = await Promise.all([listPrograms(filters), countPrograms(filters)]);
    return ok({rows, total, limit: filters.limit, offset: filters.offset});
  } catch (error) {
    return errorResponse(error);
  }
}
