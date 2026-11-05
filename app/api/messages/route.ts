import {actorFor, errorResponse, ok} from '../_shared';
import {listChats, listMessages, messageStats} from '@/lib/standalone/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only inbox API. Same data the /messages page renders. */
export async function GET(request: Request) {
  try {
    await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const view = url.searchParams.get('view') ?? 'messages';
    if (view === 'stats') return ok({rows: await messageStats()});
    if (view === 'chats') {
      return ok({
        rows: await listChats(
          url.searchParams.get('account') ?? undefined,
          url.searchParams.get('kind') ?? undefined,
        ),
      });
    }
    return ok(await listMessages({
      account: url.searchParams.get('account') ?? undefined,
      chat: url.searchParams.get('chat') ?? undefined,
      direction: url.searchParams.get('direction') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}
