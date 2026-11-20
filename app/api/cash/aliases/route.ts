import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {listCashAliasEntries} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only alias directory for the Cash page (same-name and same-ID aliases). */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const url = new URL(request.url);
    return ok(await listCashAliasEntries({
      page: Number(url.searchParams.get('page') ?? 1),
      limit: Number(url.searchParams.get('limit') ?? 20),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
