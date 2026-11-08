import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {cashTransactionView, getCashTransaction, updateCashTransaction} from '@/lib/standalone/finance';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const {id} = await context.params;
    const transaction = await getCashTransaction(decodeURIComponent(id));
    if (!transaction) return ok({error: 'CASH_TRANSACTION_NOT_FOUND'}, 404);
    return ok({transaction: cashTransactionView(transaction)});
  } catch (error) {
    return errorResponse(error);
  }
}

/** Edit designation, amount (before posting) and notes. Audited. */
export async function PATCH(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'cash.review');
    const {id} = await context.params;
    const body = await bodyOf<{designation?: string | null; amount?: number | string | null; notes?: string | null}>(request);
    const transaction = await updateCashTransaction(actor as never, decodeURIComponent(id), {
      designation: body.designation,
      amount: body.amount,
      notes: body.notes,
    });
    return ok({transaction: transaction ? cashTransactionView(transaction) : null});
  } catch (error) {
    return errorResponse(error);
  }
}
