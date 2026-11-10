import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {
  correctCashSubmission,
  correctReviewItem,
  decideReview,
  getReviewDetail,
  listCashReviewCandidates,
  listReviewQueue,
  reviewQueueCounts,
  withdrawReview,
} from '@/lib/standalone/review';
import {decideCashSubmission} from '@/lib/standalone/finance';
import {approveMessageReviewQueue, listMessageReviewQueue, resolveMessageReviewQueue} from '@/lib/standalone/message-review-queue';
import {decideVesselReview, saveVesselReviewDraft} from '@/lib/standalone/vessel-review';
import {reviewActionsFor, type ReviewActor} from '@/lib/review-ui';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CORRECTION_FIELDS: Record<string, string[]> = {
  PROGRAM: ['motherVessel', 'lighterVessel', 'masterMobile', 'destination', 'escortName', 'escortMobile', 'startDate', 'startShift', 'endDate', 'endShift', 'notes'],
  CASH: ['employeeName', 'employeeMobile', 'payoutMobile', 'method', 'amountMinor', 'purpose', 'accountId'],
  EMPLOYEE: ['preferredName', 'employeeMobile', 'dutyType'],
  ATTENDANCE: ['employeeMobile', 'dutyDate', 'state', 'hours'],
};

function pickCorrections(body: Record<string, unknown>, domain: string): Record<string, unknown> {
  const allowed = CORRECTION_FIELDS[domain] ?? [];
  const corrections: Record<string, unknown> = {};
  for (const field of allowed) {
    if (body[field] !== undefined) corrections[field] = body[field];
  }
  return corrections;
}

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const id = url.searchParams.get('id');
    if (id) {
      const detail = await getReviewDetail(id);
      if (!detail) return ok({error: 'ITEM_NOT_FOUND'}, 404);
      const actions = reviewActionsFor(actor as ReviewActor, detail.item as never);
      return ok({detail, actions, user: {id: actor.id, role: actor.role}});
    }

    const state = url.searchParams.get('state') ?? 'PENDING';
    const domain = url.searchParams.get('domain') ?? 'ALL';
    const category = url.searchParams.get('category') ?? 'ALL';
    const q = url.searchParams.get('q') ?? '';
    const mine = url.searchParams.get('mine') === '1';
    const showCash = domain === 'ALL' || domain === 'CASH';

    const [rows, cashCandidates, counts, vesselQueue] = await Promise.all([
      listReviewQueue({state, domain, category, q, mine, actor: actor as never}),
      showCash ? listCashReviewCandidates({state, q, mine, actor: actor as never}) : Promise.resolve([]),
      reviewQueueCounts(),
      listMessageReviewQueue({state: state === 'PENDING' ? 'PENDING' : state, limit: 100}),
    ]);

    return ok({
      rows: rows.map((item) => ({...item, actions: reviewActionsFor(actor as ReviewActor, item as never)})),
      vesselQueue,
      cashCandidates: cashCandidates.map((item) => ({
        ...item,
        actions: reviewActionsFor(actor as ReviewActor, {
          id: item.id,
          domain: 'CASH',
          state: item.state,
          submitted_by: item.submitted_by,
        }),
      })),
      counts,
      user: {id: actor.id, role: actor.role},
    });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    const action = body.action ?? '';
    const id = String(body.id ?? '');

    if (action === 'decide') {
      assertCapability(actor as never, 'review.decide');
      const decision = body.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED';
      const reason = String(body.reason ?? '');
      if (body.kind === 'cash_submission') {
        return ok(await decideCashSubmission(actor as never, id, decision, reason));
      }
      return ok(await decideReview(actor as never, id, decision, reason));
    }

    if (action === 'correct') {
      assertCapability(actor as never, 'review.decide');
      const domain = String(body.domain ?? '').toUpperCase();
      const corrections = pickCorrections(body, domain);
      if (body.kind === 'cash_submission') {
        return ok(await correctCashSubmission(actor as never, id, corrections));
      }
      return ok(await correctReviewItem(actor as never, id, corrections));
    }

    if (action === 'withdraw') {
      return ok(await withdrawReview(actor as never, id));
    }

    if (action === 'vessel_review_decide') {
      assertCapability(actor as never, 'review.decide');
      const kind = body.kind === 'item' ? 'item' : 'message';
      const decision = String(body.decision ?? '').toUpperCase();
      if (!['APPROVED', 'REJECTED', 'IGNORED', 'SENT_BACK'].includes(decision)) {
        return ok({error: 'INVALID_DECISION'}, 400);
      }
      const payload = body.payload && typeof body.payload === 'object'
        ? body.payload as Record<string, unknown> : undefined;
      return ok(await decideVesselReview(actor as never, kind, id, decision, {
        comment: typeof body.comment === 'string' ? body.comment : undefined,
        workflow: typeof body.workflow === 'string' ? body.workflow : 'Vessel',
        payload,
      }));
    }

    if (action === 'vessel_review_draft') {
      assertCapability(actor as never, 'review.decide');
      const kind = body.kind === 'item' ? 'item' : 'message';
      const payload = body.payload && typeof body.payload === 'object'
        ? body.payload as Record<string, unknown> : {};
      return ok(await saveVesselReviewDraft(actor as never, kind, id, payload,
        typeof body.comment === 'string' ? body.comment : undefined));
    }

    if (action === 'vessel_queue_resolve') {
      assertCapability(actor as never, 'review.decide');
      const decision = String(body.decision ?? '').toUpperCase();
      if (!['APPROVED', 'REJECTED', 'IGNORED', 'SENT_BACK'].includes(decision)) {
        return ok({error: 'INVALID_DECISION'}, 400);
      }
      const input = {
        comment: typeof body.comment === 'string' ? body.comment : undefined,
        workflow: typeof body.workflow === 'string' ? body.workflow : undefined,
        payload: body.payload && typeof body.payload === 'object' ? body.payload as Record<string, unknown> : undefined,
      };
      if (decision === 'APPROVED') {
        return ok(await approveMessageReviewQueue(actor as never, id, input));
      }
      return ok(await resolveMessageReviewQueue(
        actor as never,
        id,
        decision as 'REJECTED' | 'IGNORED' | 'SENT_BACK',
        input,
      ));
    }

    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
