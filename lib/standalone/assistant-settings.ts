import {row, type Actor} from './db.ts';
import {assertCapability} from './authz.ts';
import {recordAudit} from './audit.ts';

/**
 * Admin kill-switch for the floating assistant.
 *
 * Stored in the shared `app_settings` table as `{"enabled": boolean}`. A missing
 * row means "on": the widget ships enabled and an admin has to opt out.
 */
const KEY = 'assistant.enabled';

export async function assistantEnabled(): Promise<boolean> {
  try {
    const data = await row<{value: {enabled?: boolean} | null}>(
      'SELECT value FROM app_settings WHERE key = $1', [KEY],
    );
    if (!data) return true;
    return data.value?.enabled !== false;
  } catch {
    // A settings read failure must not disable a read-only helper.
    return true;
  }
}

export async function setAssistantEnabled(actor: Actor, enabled: boolean): Promise<{enabled: boolean}> {
  assertCapability(actor as never, 'settings.manage');
  await row(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2::jsonb)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value RETURNING key`,
    [KEY, JSON.stringify({enabled})],
  );
  await recordAudit({
    actor, action: 'ASSISTANT_TOGGLED', entity: 'app_setting', entityId: KEY, detail: {enabled},
  });
  return {enabled};
}
