import {actorFor, bodyOf, errorResponse, ok} from '../../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {cashTransactionView, correctCashTransaction} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin correction of a POSTED transaction; original posting is untouched. */
export async function POST(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'cash.review');
    const {id} = await context.params;
    const body = await bodyOf<{correctedAmount?: number | string; reason?: string}>(request);
    const transaction = await correctCashTransaction(actor as never, decodeURIComponent(id), {
      correctedAmount: body.correctedAmount ?? 0,
      reason: String(body.reason ?? ''),
    });
    return ok({transaction: transaction ? cashTransactionView(transaction) : null}, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
