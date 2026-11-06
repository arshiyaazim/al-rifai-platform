import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {
  approveInstruction, createAccount, createInstruction, createLedgerEntry, decideCashSubmission,
  incomeExpense, listAccounts, listInstructions, listLedger, postInstruction, rejectInstruction, submitCash,
  closeReconciliation, createReconciliation, getInstructionDetail, listReconciliations, reversePosting,
} from '@/lib/standalone/finance';
import {assertCapability} from '@/lib/standalone/authz';
import {rows, takaToMinor} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'cash.read');
    const url = new URL(request.url);
    const resource = url.searchParams.get('resource') ?? 'instructions';
    if (resource === 'accounts') return ok({rows: await listAccounts()});
    if (resource === 'instruction') {
      const id = url.searchParams.get('id');
      if (!id) return ok({error: 'ID_REQUIRED'}, 400);
      return ok(await getInstructionDetail(id));
    }
    if (resource === 'reconciliations') return ok({rows: await listReconciliations()});
    if (resource === 'ledger') {
      return ok({rows: await listLedger({
        accountId: url.searchParams.get('accountId') ?? undefined,
        from: url.searchParams.get('from') ?? undefined,
        to: url.searchParams.get('to') ?? undefined,
      })});
    }
    if (resource === 'submissions') {
      return ok({rows: await rows(
        `SELECT s.*, u.display_name AS submitter_name FROM cash_submissions s
           LEFT JOIN cash_portal_users u ON u.id = s.submitted_by ORDER BY s.created_at DESC LIMIT 200`,
      )});
    }
    if (resource === 'report') {
      const today = new Date().toISOString().slice(0, 10);
      const from = url.searchParams.get('from') ?? today.slice(0, 8) + '01';
      const to = url.searchParams.get('to') ?? today;
      return ok(await incomeExpense(from, to));
    }
    return ok({rows: await listInstructions({
      state: url.searchParams.get('state') ?? undefined,
      q: url.searchParams.get('q') ?? '',
    })});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    const action = body.action ?? '';
    if (body.amountMinor === undefined && body.amount !== undefined) {
      body.amountMinor = takaToMinor(body.amount);
    }
    if (body.countedBalanceMinor === undefined && body.countedBalance !== undefined) {
      body.countedBalanceMinor = takaToMinor(body.countedBalance);
    }
    if (action === 'instruction.create') return ok(await createInstruction(actor, body as never), 201);
    if (action === 'instruction.approve') return ok(await approveInstruction(actor, String(body.id)));
    if (action === 'instruction.reject') return ok(await rejectInstruction(actor, String(body.id), String(body.reason ?? '')));
    if (action === 'instruction.post') return ok(await postInstruction(actor, String(body.id)));
    if (action === 'instruction.reverse') return ok(await reversePosting(actor, String(body.id), String(body.reason ?? '')));
    if (action === 'ledger.create') return ok(await createLedgerEntry(actor, body as never), 201);
    if (action === 'account.create') return ok(await createAccount(actor, body as never), 201);
    if (action === 'submission.submit') return ok(await submitCash(actor, body as never), 201);
    if (action === 'submission.decide') {
      return ok(await decideCashSubmission(actor, String(body.id), body.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', String(body.reason ?? '')));
    }
    if (action === 'reconciliation.create') return ok(await createReconciliation(actor, body as never), 201);
    if (action === 'reconciliation.close') return ok(await closeReconciliation(actor, String(body.id), body.note ? String(body.note) : null));
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
