import {actorFor, bodyOf, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {getApiKeyForTest, recordKeyTest} from '@/lib/standalone/api-keys';
import {testApiKey} from '@/lib/ai-provider-test';
import {baseUrlFromNotes, type AiProvider} from '@/lib/ai-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const body = await bodyOf<{id?: string}>(request);
    const key = await getApiKeyForTest(String(body.id ?? ''));
    if (!key) return ok({error: 'API_KEY_NOT_FOUND'}, 404);

    const result = await testApiKey({
      provider: key.provider as AiProvider,
      apiKey: key.api_key,
      model: key.model || '',
      baseUrl: baseUrlFromNotes(key.notes),
    });
    await recordKeyTest(key.id, {ok: result.ok, error: result.error});
    return ok(result);
  } catch (error) { return errorResponse(error); }
}
