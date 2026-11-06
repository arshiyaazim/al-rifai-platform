import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {listEmployees, createEmployee, updateEmployee} from '@/lib/standalone/employees';
import {assertCapability, can} from '@/lib/standalone/authz';
import {submitForReview} from '@/lib/standalone/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'employee.read');
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
    assertCapability(actor as never, 'employee.submit');
    const body = await bodyOf(request);
    if (!can(actor as never, 'employee.manage')) {
      const review = await submitForReview(actor as never, {
        domain: 'EMPLOYEE',
        action: 'CREATE',
        payload: body,
      });
      return ok({pending: true, review}, 202);
    }
    return ok(await createEmployee(actor as never, body as never), 201);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'employee.submit');
    const body = await bodyOf<{employeeMobile?: string} & Record<string, unknown>>(request);
    if (!body.employeeMobile) return ok({error: 'EMPLOYEE_REQUIRED'}, 400);
    if (!can(actor as never, 'employee.manage')) {
      const review = await submitForReview(actor as never, {
        domain: 'EMPLOYEE',
        action: 'UPDATE',
        targetRef: String(body.employeeMobile),
        payload: body,
      });
      return ok({pending: true, review}, 202);
    }
    return ok(await updateEmployee(actor as never, String(body.employeeMobile), body as never));
  } catch (error) {
    return errorResponse(error);
  }
}
