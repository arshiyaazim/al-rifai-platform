import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {createUser, listUsers, resetUserPassword, updateUser} from '@/lib/standalone/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'user.manage');
    if (!actor.superAdmin) return ok({error: 'SUPER_ADMIN_REQUIRED'}, 403);
    return ok({rows: await listUsers()});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    if (body.action === 'update') {
      return ok(await updateUser(actor as never, {
        user: String(body.user ?? ''),
        displayName: body.displayName === undefined ? undefined : String(body.displayName),
        role: body.role === undefined || String(body.role).trim() === '' ? undefined : String(body.role),
        active: body.active === undefined || String(body.active).trim() === ''
          ? undefined
          : body.active === true || body.active === 'true' || body.active === '1',
      }));
    }
    if (body.action === 'reset-password') {
      return ok(await resetUserPassword(actor as never, {
        user: String(body.user ?? ''),
        password: String(body.password ?? ''),
      }));
    }
    return ok(await createUser(actor as never, {
      username: String(body.username ?? ''),
      password: String(body.password ?? ''),
      displayName: body.displayName ? String(body.displayName) : undefined,
      role: body.role ? String(body.role) : undefined,
    }), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
