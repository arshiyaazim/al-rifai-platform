import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {assistantEnabled, setAssistantEnabled} from '@/lib/standalone/assistant-settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'settings.manage');
    return ok({enabled: await assistantEnabled()});
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    const body = await bodyOf<{enabled?: boolean}>(request);
    return ok(await setAssistantEnabled(actor as never, body.enabled !== false));
  } catch (error) { return errorResponse(error); }
}
