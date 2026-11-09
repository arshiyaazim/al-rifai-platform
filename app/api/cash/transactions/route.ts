import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {cashTransactionView, countCashTransactions, listCashTransactions} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Cash transaction list derived from parsed WhatsApp instructions (the
 * Accountant ↔ Admin direct conversation). Read-only.
 *
 * Amounts are canonical integer minor units (paisa) as stored; the UI formats
 * them. The response keys match the table headers 1:1.
 */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || 20, 1), 10000);
    const search = (url.searchParams.get('search') ?? url.searchParams.get('q') ?? '').trim();
    const state = (url.searchParams.get('state') ?? '').trim() || undefined;
    const from = (url.searchParams.get('from') ?? '').trim() || undefined;
    const to = (url.searchParams.get('to') ?? '').trim() || undefined;
    const filters = {q: search, state, from, to};
    const [rows, total] = await Promise.all([
      listCashTransactions({...filters, limit, offset: (page - 1) * limit}),
      countCashTransactions(filters),
    ]);
    return ok({
      transactions: rows.map(cashTransactionView),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
