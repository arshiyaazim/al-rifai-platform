import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {listEmployees, createEmployee, updateEmployee} from '@/lib/standalone/employees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    return ok({rows: await listEmployees({
      q: url.searchParams.get('q') ?? '',
      state: url.searchParams.get('state') ?? undefined,
    })});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    return ok(await createEmployee(actor, await bodyOf(request)), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{employeeMobile?: string} & Record<string, unknown>>(request);
    if (!body.employeeMobile) return ok({error: 'EMPLOYEE_REQUIRED'}, 400);
    return ok(await updateEmployee(actor, String(body.employeeMobile), body as never));
  } catch (error) {
    return errorResponse(error);
  }
}
