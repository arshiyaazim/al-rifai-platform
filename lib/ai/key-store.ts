// Read the active platform-level AI key from PostgreSQL.
//
// Keys entered through /settings/api-keys with purpose `general` are used by
// the platform AI layer (lib/ai/llm.ts). Values are encrypted at rest; this
// module decrypts them only in server memory.

import {row} from '../standalone/db.ts';
import {safeDecryptSecret} from './crypto.ts';
import {baseUrlFromNotes} from '../ai-provider.ts';

export type PlatformKey = {
  apiKey: string;
  model: string | null;
  baseUrl: string;
  provider: string;
};

/**
 * Active key for the platform AI. Prefers `general`, falls back to `other`
 * (keys created before the purpose existed) so an existing working key keeps
 * powering the assistant.
 */
export async function getPlatformKey(provider = 'gemini'): Promise<PlatformKey | null> {
  const data = await row<{api_key: string; model: string | null; notes: string | null; provider: string}>(
    `SELECT api_key, model, notes, provider
       FROM api_keys
      WHERE is_active = true
        AND provider = $1
        AND purpose = 'general'
      ORDER BY created_at DESC
      LIMIT 1`,
    [provider],
  );
  if (!data) return null;
  const apiKey = safeDecryptSecret(data.api_key);
  if (!apiKey) return null;
  return {
    apiKey,
    model: data.model ? String(data.model) : null,
    baseUrl: baseUrlFromNotes(data.notes),
    provider: String(data.provider),
  };
}
