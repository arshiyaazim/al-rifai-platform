import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {listCalls, listChats, listMessages, messageStats, setMessageIntelligence} from '@/lib/standalone/messages';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Read-only inbox/message-intelligence API. Same data the /messages page renders. */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'whatsapp.read');
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
    if (view === 'calls') {
      return ok({
        rows: await listCalls(
          url.searchParams.get('account') ?? undefined,
          url.searchParams.get('chat') ?? undefined,
          Number(url.searchParams.get('limit') ?? 100),
        ),
      });
    }
    return ok(await listMessages({
      account: url.searchParams.get('account') ?? undefined,
      chat: url.searchParams.get('chat') ?? undefined,
      direction: url.searchParams.get('direction') ?? undefined,
      kind: url.searchParams.get('kind') ?? undefined,
      q: url.searchParams.get('q') ?? undefined,
      role: url.searchParams.get('role') ?? undefined,
      domain: url.searchParams.get('domain') ?? undefined,
      identity: url.searchParams.get('identity') ?? undefined,
      mediaStatus: url.searchParams.get('mediaStatus') ?? undefined,
      messageType: url.searchParams.get('messageType') ?? undefined,
      reviewStatus: url.searchParams.get('reviewStatus') ?? undefined,
      sourceRole: url.searchParams.get('sourceRole') ?? undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      limit: Number(url.searchParams.get('limit') ?? 50),
      offset: Number(url.searchParams.get('offset') ?? 0),
    }));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * Authorized identity/domain review for one message. This is metadata only:
 * it never changes chat authorization, WhatsApp permissions, Cash or Vessel.
 */
export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'whatsapp.manage');
    const body = await bodyOf<{
      action?: string;
      account?: string;
      chat?: string;
      messageId?: string;
      identityRole?: string | null;
      businessDomain?: string | null;
      reviewStatus?: string | null;
      notes?: string | null;
    }>(request);
    if ((body.action ?? 'classify') !== 'classify') return ok({error: 'UNKNOWN_ACTION'}, 400);
    const saved = await setMessageIntelligence(actor as never, {
      account: String(body.account ?? ''),
      chat: String(body.chat ?? ''),
      messageId: String(body.messageId ?? ''),
      identityRole: body.identityRole ?? null,
      businessDomain: body.businessDomain ?? null,
      reviewStatus: body.reviewStatus ?? null,
      notes: body.notes ?? null,
    });
    return ok({saved});
  } catch (error) {
    return errorResponse(error);
  }
}
