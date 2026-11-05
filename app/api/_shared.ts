import {NextResponse} from 'next/server';
import {currentSession, assertCsrf, authErrorBody} from '@/lib/unified-auth';
import {DomainError} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export type RouteContext = {identity: {id: string; role: 'ADMIN' | 'USER'; username?: string}; token: string};

export function ok(body: unknown, status = 200) {
  return NextResponse.json(body, {status, headers: {'Cache-Control': 'no-store'}});
}

export function errorResponse(error: unknown) {
  if (error instanceof DomainError) {
    return NextResponse.json({error: error.message.split(':')[0], detail: error.message.split(':').slice(1).join(':')}, {status: error.status, headers: {'Cache-Control': 'no-store'}});
  }
  const mapped = authErrorBody(error);
  if (mapped.status !== 500) {
    return NextResponse.json({error: mapped.error}, {status: mapped.status, headers: mapped.headers});
  }
  console.error('standalone route failed:', error instanceof Error ? error.message : error);
  return NextResponse.json({error: 'REQUEST_FAILED'}, {status: 500, headers: {'Cache-Control': 'no-store'}});
}

/** Authenticate the caller and (for mutations) require the session CSRF token. */
export async function actorFor(request: Request, {csrf = true} = {}) {
  const {identity, token} = await currentSession(request);
  if (csrf) await assertCsrf(request, token);
  return {id: identity.id, role: identity.role, username: identity.username, displayName: identity.displayName};
}

export async function bodyOf<T = Record<string, unknown>>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new DomainError('INVALID_JSON', 400);
  }
}
