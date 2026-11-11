import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const body = await bodyOf<{provider?: string; apiKey?: string; model?: string}>(request);
    if (String(body.provider) !== 'gemini') return ok({success: false, error: 'TEST_NOT_IMPLEMENTED'}, 400);
    const model = body.model || 'gemini-2.0-flash';
    const started = Date.now();
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(String(body.apiKey ?? ''))}`,
      {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({contents: [{parts: [{text: 'Say hello'}]}]}),
      },
    );
    const latency = Date.now() - started;
    if (!response.ok) return ok({success: false, latency_ms: latency, error: `HTTP_${response.status}`});
    const data = await response.json() as {candidates?: Array<{content?: {parts?: Array<{text?: string}>}}>};
    const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join('') ?? '';
    return ok({success: Boolean(text), latency_ms: latency, response: text.slice(0, 120)});
  } catch (error) { return errorResponse(error); }
}
