import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {testApiKey} from '@/lib/ai-provider-test';
import {detectProvider, defaultModel} from '@/lib/ai-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const body = await bodyOf<{apiKey?: string; model?: string; baseUrl?: string}>(request);
    const apiKey = String(body.apiKey ?? '').trim();
    if (!apiKey) return ok({ok: false, error: 'API_KEY_REQUIRED'}, 400);
    const provider = detectProvider(apiKey);
    const result = await testApiKey({
      provider,
      apiKey,
      model: String(body.model ?? '').trim() || defaultModel(provider),
      baseUrl: String(body.baseUrl ?? '').trim(),
    });
    return ok(result);
  } catch (error) { return errorResponse(error); }
}
