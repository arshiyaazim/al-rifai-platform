import {actorFor, bodyOf, errorResponse, ok} from '../../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {cashTransactionView, reverseCashTransaction} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin reversal: original becomes REVERSED and a new POSTED row is created. */
export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'cash.reverse');
    const {id} = await context.params;
    const body = await bodyOf<{amount?: number | string; method?: string; notes?: string | null; reason?: string}>(request);
    const result = await reverseCashTransaction(actor as never, decodeURIComponent(id), {
      amount: body.amount ?? 0,
      method: body.method,
      notes: body.notes,
      reason: String(body.reason ?? ''),
    });
    return ok({
      original: result.original ? cashTransactionView(result.original) : null,
      replacement: result.replacement ? cashTransactionView(result.replacement) : null,
    }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
