import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {createApiKey, deleteApiKey, listApiKeys, updateApiKey} from '@/lib/standalone/api-keys';

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
    return ok(await createApiKey(actor as never, {
      provider: String(body.provider ?? ''),
      keyName: String(body.keyName ?? ''),
      apiKey: String(body.apiKey ?? ''),
      model: body.model ? String(body.model) : undefined,
      purpose: body.purpose ? String(body.purpose) : undefined,
      dailyLimit: body.dailyLimit === null || body.dailyLimit === undefined || body.dailyLimit === ''
        ? null : Number(body.dailyLimit),
      notes: body.notes ? String(body.notes) : null,
    }), 201);
  } catch (error) { return errorResponse(error); }
}

export async function PATCH(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    admin(actor);
    const body = await bodyOf<Record<string, unknown>>(request);
    return ok(await updateApiKey(actor as never, {
      id: String(body.id ?? ''),
      keyName: body.keyName === undefined ? undefined : String(body.keyName),
      model: body.model === undefined ? undefined : String(body.model),
      purpose: body.purpose === undefined ? undefined : String(body.purpose),
      dailyLimit: body.dailyLimit === undefined ? undefined
        : body.dailyLimit === null || body.dailyLimit === '' ? null : Number(body.dailyLimit),
      isActive: body.isActive === undefined ? undefined : Boolean(body.isActive),
      notes: body.notes === undefined ? undefined : body.notes === null ? null : String(body.notes),
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
