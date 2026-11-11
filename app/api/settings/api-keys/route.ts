import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {createApiKey, deleteApiKey, listApiKeys, updateApiKey} from '@/lib/standalone/api-keys';
import {row} from '@/lib/standalone/db';
import {defaultModel, detectProvider, notesWithBaseUrl} from '@/lib/ai-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function admin(actor: {role: string}) {
  if (actor.role !== 'ADMIN') throw Object.assign(new Error('ADMIN_REQUIRED'), {status: 403});
}

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'settings.manage');
    admin(actor);
    const url = new URL(request.url);
    const active = url.searchParams.get('active');
    return ok({
      keys: await listApiKeys({
        provider: url.searchParams.get('provider') ?? undefined,
        purpose: url.searchParams.get('purpose') ?? undefined,
        active: active === null ? undefined : active === 'true',
      }),
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    admin(actor);
    const body = await bodyOf<Record<string, unknown>>(request);
    const apiKey = String(body.apiKey ?? '').trim();
    const provider = detectProvider(apiKey);
    const baseUrl = String(body.baseUrl ?? '').trim();
    if (provider === 'other' && !baseUrl) return ok({error: 'BASE_URL_REQUIRED'}, 400);
    const model = String(body.model ?? '').trim() || defaultModel(provider);
    if (!model) return ok({error: 'MODEL_REQUIRED'}, 400);
    const counted = await row<{count: string}>(
      'SELECT count(*)::text AS count FROM api_keys WHERE provider = $1', [provider],
    );
    const keyName = `${provider}-key-${Number(counted?.count ?? 0) + 1}`;
    return ok(await createApiKey(actor as never, {
      provider,
      keyName,
      apiKey,
      model,
      purpose: 'recruitment',
      dailyLimit: null,
      notes: provider === 'other' ? notesWithBaseUrl(baseUrl) : null,
    }), 201);
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    admin(actor);
    const body = await bodyOf<Record<string, unknown>>(request);
    const baseUrl = body.baseUrl === undefined ? undefined : String(body.baseUrl);
    return ok(await updateApiKey(actor as never, {
      id: String(body.id ?? ''),
      model: body.model === undefined ? undefined : String(body.model),
      isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
      notes: baseUrl === undefined ? undefined : notesWithBaseUrl(baseUrl),
    }));
  } catch (error) { return errorResponse(error); }
}

export async function DELETE(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    admin(actor);
    const body = await bodyOf<{id?: string}>(request);
    return ok(await deleteApiKey(actor as never, String(body.id ?? '')));
  } catch (error) { return errorResponse(error); }
}
