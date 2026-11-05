import {NextResponse} from 'next/server';
import {
  authErrorBody, changeOwnPassword, currentCsrf, currentSession, loginWithCashCredential,
  logoutCurrent, requireUnifiedOrigin, unifiedMode,
} from '@/lib/unified-auth';
import {cookieHeader, clearCookie} from '@/lib/cash-portal';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  NextResponse.json(body, {status, headers: {'Cache-Control': 'no-store', ...headers}});

export async function POST(request: Request, context: {params: Promise<{path: string[]}>}) {
  const {path} = await context.params;
  const action = path.join('/');
  try {
    if (action === 'login') {
      const body = await request.json().catch(() => ({}));
      const result = await loginWithCashCredential(request, body);
      return json(
        {user: result.user, csrf: result.csrf},
        200,
        {'Set-Cookie': cookieHeader(result.token)},
      );
    }
    if (action === 'logout') {
      const {identity, token} = await currentSession(request);
      void identity;
      await logoutCurrent(token);
      return json({ok: true}, 200, {'Set-Cookie': clearCookie()});
    }
    if (action === 'password') {
      const {identity, token} = await currentSession(request);
      requireUnifiedOrigin(request);
      const body = await request.json().catch(() => ({}));
      const result = await changeOwnPassword(identity, body, token);
      return json({ok: true, ...(result ?? {})});
    }
    return json({error: 'NOT_FOUND'}, 404);
  } catch (error) {
    const mapped = authErrorBody(error);
    return json({error: mapped.error}, mapped.status, mapped.headers as Record<string, string>);
  }
}

export async function GET(request: Request, context: {params: Promise<{path: string[]}>}) {
  const {path} = await context.params;
  if (path.join('/') !== 'session') return json({error: 'NOT_FOUND'}, 404);
  try {
    const {identity, csrf} = await currentCsrf(request);
    return json({user: identity, csrf, mode: unifiedMode()});
  } catch (error) {
    const mapped = authErrorBody(error);
    return json({error: mapped.error, mode: unifiedMode()}, mapped.status);
  }
}
