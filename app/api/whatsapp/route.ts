import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {configureAccount, health, integrationStatus, listAccounts, syncAccount, processPending, routePending} from '@/lib/standalone/whatsapp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'whatsapp.read');
    const url = new URL(request.url);
    const accountId = url.searchParams.get('account');
    if (accountId && url.searchParams.get('health') === '1') return ok(await health(accountId));
    return ok({...await integrationStatus(), accounts: await listAccounts()});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const body = await bodyOf<{action?: string; accountId?: string} & Record<string, unknown>>(request);
    assertCapability(actor as never, body.action === 'process' || body.action === 'route' ? 'whatsapp.route' : 'whatsapp.manage');
    if (body.action === 'configure') {
      const adminJids = typeof body.adminJids === 'string'
        ? body.adminJids.split(',').map((value) => value.trim()).filter(Boolean)
        : (body.adminJids as string[] | undefined);
      const chats = body.chatJid
        ? [{chatJid: String(body.chatJid), purpose: String(body.purpose ?? 'BOTH')}]
        : (body.chats as never);
      return ok(await configureAccount(actor, {
        id: String(body.id), label: String(body.label ?? body.id),
        socketPath: (body.socketPath as string) || null, tokenFile: (body.tokenFile as string) || null,
        accountJid: (body.accountJid as string) || null, adminJids, enabled: true, chats,
      }), 201);
    }
    if (body.action === 'health') return ok(await health(String(body.accountId)));
    if (body.action === 'sync') return ok(await syncAccount(actor, String(body.accountId)));
    if (body.action === 'process') return ok(await processPending(actor, Number(body.limit) || 100));
    if (body.action === 'route') return ok(await routePending(actor, Number(body.limit) || 100));
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
