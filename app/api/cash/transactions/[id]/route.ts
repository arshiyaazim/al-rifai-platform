import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability, can} from '@/lib/standalone/authz';
import {cashTransactionView, deleteCashTransaction, getCashTransaction, submitCashAction, updateCashTransaction} from '@/lib/standalone/finance';

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
    const {id} = await context.params;
    const instructionId = decodeURIComponent(id);
    const body = await bodyOf<{designation?: string | null; amount?: number | string | null; notes?: string | null}>(request);
    if (!can(actor as never, 'cash.review')) {
      assertCapability(actor as never, 'cash.submit');
      const review = await submitCashAction(actor as never, {
        instructionId,
        action: 'UPDATE',
        designation: body.designation,
        amountMinor: body.amount === undefined || body.amount === null ? null : Number(body.amount),
        notes: body.notes,
      });
      return ok({pending: true, review}, 202);
    }
    assertCapability(actor as never, 'cash.review');
    const transaction = await updateCashTransaction(actor as never, instructionId, {
      designation: body.designation,
      amount: body.amount,
      notes: body.notes,
    });
    return ok({transaction: transaction ? cashTransactionView(transaction) : null});
  } catch (error) {
    return errorResponse(error);
  }
}

/** USER delete request; ADMIN approval performs the actual deletion. */
export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    const {id} = await context.params;
    assertCapability(actor as never, 'cash.submit');
    if (can(actor as never, 'cash.review')) {
      return ok(await deleteCashTransaction(actor as never, decodeURIComponent(id)));
    }
    const review = await submitCashAction(actor as never, {
      instructionId: decodeURIComponent(id),
      action: 'DELETE',
      reason: 'Delete requested from Cash transaction',
    });
    return ok({pending: true, review}, 202);
  } catch (error) {
    return errorResponse(error);
  }
}
