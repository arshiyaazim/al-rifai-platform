import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {getApiKeyForTest} from '@/lib/standalone/api-keys';
import {listModels} from '@/lib/ai-provider-test';
import {baseUrlFromNotes, detectProvider, type AiProvider} from '@/lib/ai-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Verify an API key and list the models it can use.
 *
 * Accepts either a stored key (`id`) or a key pasted in the form
 * (`apiKey`). Never persists anything and never returns the key.
 */
export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);

    const body = await bodyOf<{id?: string; apiKey?: string; baseUrl?: string}>(request);
    const id = String(body.id ?? '').trim();

    let apiKey = String(body.apiKey ?? '').trim();
    let baseUrl = String(body.baseUrl ?? '').trim();

    if (!apiKey && id) {
      const stored = await getApiKeyForTest(id);
      if (!stored) return ok({ok: false, error: 'API_KEY_NOT_FOUND'}, 404);
      apiKey = stored.api_key;
      baseUrl = baseUrl || baseUrlFromNotes(stored.notes);
    }
    if (!apiKey) return ok({ok: false, error: 'API_KEY_REQUIRED'}, 400);

    const provider: AiProvider = detectProvider(apiKey);
    const result = await listModels({provider, apiKey, baseUrl});
    return ok(result);
  } catch (error) { return errorResponse(error); }
}
