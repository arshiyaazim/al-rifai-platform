import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {listCashPayments} from '@/lib/standalone/cash-dashboard';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 100);
    const result = await listCashPayments({
      q: (url.searchParams.get('q') ?? '').trim(),
      date: (url.searchParams.get('date') ?? '').trim(),
      from: (url.searchParams.get('from') ?? '').trim(),
      to: (url.searchParams.get('to') ?? '').trim(),
      employeeMobile: (url.searchParams.get('employee_mobile')
        ?? url.searchParams.get('employeeMobile') ?? '').trim(),
      source: (url.searchParams.get('source') ?? '').trim(),
      limit,
      offset: (page - 1) * limit,
    });
    return ok({
      rows: result.rows,
      total: result.count,
      totalMinor: result.totalMinor,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(result.count / limit)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
