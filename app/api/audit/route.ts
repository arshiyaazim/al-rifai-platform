import {actorFor, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {listAuditEvents} from '@/lib/standalone/audit-view';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin-only unified audit stream: audit_events + program_events. */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'audit.read');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const url = new URL(request.url);
    const filters = {
      from: url.searchParams.get('from') ?? undefined,
      to: url.searchParams.get('to') ?? undefined,
      domain: url.searchParams.get('domain') ?? undefined,
      action: url.searchParams.get('action') ?? undefined,
      actor: url.searchParams.get('actor') ?? undefined,
      targetId: url.searchParams.get('targetId') ?? undefined,
      page: Number(url.searchParams.get('page') ?? 1),
      limit: Number(url.searchParams.get('limit') ?? 50),
    };
    return ok(await listAuditEvents(filters));
  } catch (error) {
    return errorResponse(error);
  }
}
