import type {NextRequest} from 'next/server';
import {createPool} from '@/db/postgres.mjs';
import {authErrorBody, assertCsrf, currentSession, currentIdentity, unifiedMode} from '@/lib/unified-auth';
import type {UnifiedIdentity} from '@/lib/unified-auth-db';

/**
 * Shared plumbing for the RBAC-2B write routes.
 *
 * Identity always comes from the session cookie. No route reads a user id, role or
 * capability out of the request body — that is the whole point of the workflow
 * functions being SECURITY DEFINER with the role resolved inside the database.
 *
 * Writes additionally require the session's CSRF token, exactly as the Cash Portal
 * does, because these routes create live business rows.
 */

export const noStore = {'Cache-Control': 'private, no-store', 'Vary': 'Cookie', 'X-Content-Type-Options': 'nosniff'};

export function json(value: unknown, status = 200) {
  return Response.json(value, {status, headers: noStore});
}

export type Actor = {id: string; role: 'ADMIN' | 'USER'; admin: boolean; displayName: string};

function actorFrom(identity: UnifiedIdentity): Actor {
  return {
    id: identity.id,
    role: identity.role,
    admin: identity.role === 'ADMIN' || identity.superAdmin === true,
    displayName: identity.displayName,
  };
}

/** Session + CSRF. Throws the same error shapes the Cash API maps. */
export async function requireWriteActor(request: NextRequest): Promise<Actor> {
  const {identity, token} = await currentSession(request);
  await assertCsrf(request, token);
  return actorFrom(identity);
}

/** Session only. Used by read routes; falls back to null when unauthenticated. */
export async function readActor(): Promise<Actor | null> {
  if (unifiedMode() === 'off') return null;
  const identity = await currentIdentity();
  return identity ? actorFrom(identity) : null;
}

/** Maps policy/portal errors onto a JSON reply without leaking SQL detail. */
export function failure(error: unknown) {
  const mapped = authErrorBody(error);
  if (mapped.status !== 500) return json({error: mapped.error}, mapped.status);
  const message = error instanceof Error ? error.message : '';
  const code = (error as {code?: string})?.code;
  // Domain validation errors raised by the workflow functions are caller mistakes.
  if (/^(SUBMITTER_UNKNOWN|SUBMITTER_INACTIVE|DOMAIN_INVALID|ACTION_INVALID|PAYLOAD_INVALID|TARGET_REQUIRED|CAPABILITY_REQUIRED|PENDING_REVIEW_EXISTS|ITEM_NOT_FOUND|ITEM_NOT_PENDING|NOT_SUBMITTER|ADMIN_REQUIRED|ACTOR_UNKNOWN|ACTOR_INACTIVE|REVIEWER_IS_SUBMITTER|VERSION_CONFLICT|DECISION_INVALID|REASON_REQUIRED|NOTE_TOO_LONG|DOMAIN_NOT_IMPLEMENTED|EMPLOYEE_NOT_FOUND|EMPLOYEE_MOBILE_INVALID|ATTENDANCE_DATE_INVALID|HOURS_INVALID|START_DATE_REQUIRED|VESSEL_PAIR_REQUIRED|VESSEL_ACTOR_REQUIRED|PROGRAM_ID_REQUIRED)/.test(message)) {
    const status = message === 'ITEM_NOT_FOUND' ? 404
      : message === 'VERSION_CONFLICT' || message === 'PENDING_REVIEW_EXISTS' || message === 'ITEM_NOT_PENDING' ? 409
        : message.startsWith('ADMIN_REQUIRED') || message === 'REVIEWER_IS_SUBMITTER' || message === 'NOT_SUBMITTER' ? 403
          : 400;
    return json({error: message.split(':')[0]}, status);
  }
  if (code === '23505') return json({error: 'DUPLICATE'}, 409);
  if (code === '42501') return json({error: 'FORBIDDEN'}, 403);
  return json({error: 'REQUEST_FAILED'}, 500);
}

/** Writer pool for the workflow functions (the role granted EXECUTE on them). */
let writer: ReturnType<typeof createPool> | null = null;
export function workflowPool() {
  if (!writer) writer = createPool({readOnly: false, role: 'review'});
  return writer;
}

export function normaliseDomain(value: unknown): string {
  return String(value ?? '').trim().toUpperCase();
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}
