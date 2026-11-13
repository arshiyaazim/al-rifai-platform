import {actorFor, bodyOf, errorResponse, ok} from '../_shared';
import {decideReleaseSlip} from '@/lib/standalone/release-slips';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type DecisionBody = {messageId?: string; action?: 'approve' | 'decline'; reason?: string};

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    const body = await bodyOf<DecisionBody>(request);
    const messageId = String(body.messageId ?? '').trim();
    const action = body.action;
    if (!messageId) return errorResponse(new Error('RELEASE_MESSAGE_ID_REQUIRED'));
    if (action !== 'approve' && action !== 'decline') return errorResponse(new Error('RELEASE_ACTION_INVALID'));
    const result = await decideReleaseSlip(actor as never, {
      messageId,
      action,
      reason: body.reason ? String(body.reason).slice(0, 500) : undefined,
    });
    return ok(result);
  } catch (error) {
    return errorResponse(error);
  }
}
