import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {decideReview, listReview, submitForReview, withdrawReview} from '@/lib/standalone/review';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    return ok({rows: await listReview({
      state: url.searchParams.get('state') ?? 'PENDING',
      mine: url.searchParams.get('mine') === '1',
      actor,
    })});
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<{action?: string} & Record<string, unknown>>(request);
    if (body.action === 'submit') {
      const raw = body.payload;
      const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return ok(await submitForReview(actor, {
        domain: String(body.domain ?? ''),
        action: String(body.reviewAction ?? body.recordAction ?? 'CREATE'),
        targetRef: (body.targetRef as string | undefined) ?? null,
        payload: payload as Record<string, unknown>,
      }), 201);
    }
    if (body.action === 'decide') {
      return ok(await decideReview(actor, String(body.id), body.decision === 'REJECTED' ? 'REJECTED' : 'APPROVED', String(body.reason ?? '')));
    }
    if (body.action === 'withdraw') return ok(await withdrawReview(actor, String(body.id)));
    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) {
    return errorResponse(error);
  }
}
