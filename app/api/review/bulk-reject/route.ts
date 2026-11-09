import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {decideReview} from '@/lib/standalone/review';
import {decideCashSubmission} from '@/lib/standalone/finance';
import {row} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_ITEMS = 50;

/**
 * Bulk rejection for the Review Queue. Each item is processed in its own
 * existing service transaction, so partial success is reported honestly and
 * every successful rejection keeps its own audit_events row. Approved items are
 * never rejected here (they require the domain-specific reversal flow).
 */
export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'review.decide');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);

    const body = await bodyOf<{ids?: unknown; reason?: unknown}>(request);
    const ids = Array.isArray(body.ids)
      ? Array.from(new Set(body.ids.map((value) => String(value)).filter(Boolean)))
      : [];
    if (!ids.length) return ok({error: 'IDS_REQUIRED'}, 400);
    if (ids.length > MAX_ITEMS) return ok({error: 'BULK_LIMIT_EXCEEDED', detail: `Maximum ${MAX_ITEMS} items per operation.`}, 400);
    const reason = String(body.reason ?? '').trim().slice(0, 500);

    const succeeded: string[] = [];
    const failed: Array<{id: string; error: string}> = [];
    const skipped: Array<{id: string; error: string}> = [];

    for (const id of ids) {
      try {
        const kind = await row<{kind: 'review_item' | 'cash_submission'; state: string}>(
          `SELECT 'review_item'::text AS kind, state FROM review_items WHERE id = $1
           UNION ALL
           SELECT 'cash_submission'::text AS kind, state FROM cash_submissions WHERE id = $1
           LIMIT 1`,
          [id],
        ) ?? null;
        if (!kind) {
          failed.push({id, error: 'ITEM_NOT_FOUND'});
          continue;
        }
        if (kind.kind === 'review_item' && kind.state !== 'PENDING') {
          skipped.push({id, error: kind.state === 'APPROVED' ? 'APPROVED_REQUIRES_REVERSAL' : `NOT_PENDING:${kind.state}`});
          continue;
        }
        if (kind.kind === 'cash_submission' && kind.state !== 'PENDING_REVIEW') {
          skipped.push({id, error: kind.state === 'APPROVED' ? 'APPROVED_REQUIRES_REVERSAL' : `NOT_PENDING:${kind.state}`});
          continue;
        }
        if (kind.kind === 'cash_submission') {
          await decideCashSubmission(actor as never, id, 'REJECTED', reason);
        } else {
          await decideReview(actor as never, id, 'REJECTED', reason);
        }
        succeeded.push(id);
      } catch (error) {
        const message = error instanceof Error ? error.message.split(':')[0] : 'REJECT_FAILED';
        failed.push({id, error: message});
      }
    }

    return ok({succeeded, failed, skipped, attempted: ids.length});
  } catch (error) {
    return errorResponse(error);
  }
}
