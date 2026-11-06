import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {listRates, monthlySalary, payrollSummary, programPayList, upsertRate} from '@/lib/standalone/payroll';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'payroll.read');
    const url = new URL(request.url);
    const month = url.searchParams.get('month') ?? new Date().toISOString().slice(0, 7);
    return ok({
      month: await monthlySalary(month),
      summary: await payrollSummary(),
      rates: await listRates(),
      programs: await programPayList({}),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'payroll.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    return ok(await upsertRate(actor, await bodyOf(request)), 201);
  } catch (error) {
    return errorResponse(error);
  }
}
