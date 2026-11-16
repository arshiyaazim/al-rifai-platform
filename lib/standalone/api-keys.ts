import {row, rows, tx, text, optionalText, DomainError, type Actor} from './db.ts';
import {recordAudit} from './audit.ts';
import {assertCapability} from './authz.ts';
import {decryptSecret, encryptSecret, safeDecryptSecret} from '../ai/crypto.ts';
import {baseUrlFromNotes, normalizeProvider, requiresBaseUrl, resolveBaseUrl} from '../ai-provider.ts';

// Provider ids are intentionally open: any OpenAI-compatible provider is
// accepted. Purpose stays a controlled vocabulary because the routing code and
// the separate recruitment worker branch on it.
export type ApiKeyPurpose = 'recruitment' | 'vessel-ai' | 'general' | 'other'
  | 'platform-llm' | 'platform-assistant' | 'ocr';

const PURPOSES = new Set<string>([
  'recruitment', 'vessel-ai', 'general', 'other',
  'platform-llm', 'platform-assistant', 'ocr',
]);

/** Recruitment is the only purpose the separate worker reads as plaintext. */
const isEncryptedPurpose = (purpose: string) => purpose !== 'recruitment';

export function maskKey(value: string): string {
  const key = String(value ?? '');
  if (key.length <= 12) return `${key.slice(0, 3)}****${key.slice(-2)}`;
  return `${key.slice(0, 7)}...****${key.slice(-4)}`;
}

/**
 * Structural validation only. Key validity is proved by the provider's
 * /models endpoint (Verify & Load Models), never by a prefix pattern.
 */
function validateKey(provider: string, apiKey: string) {
  if (!provider) throw new DomainError('INVALID_PROVIDER', 400);
  if (provider.length > 60) throw new DomainError('INVALID_PROVIDER', 400);
  if (apiKey.length > 500) throw new DomainError('INVALID_KEY_FORMAT', 400);
  if (!apiKey && !requiresBaseUrl(provider) && provider !== 'ollama') {
    throw new DomainError('INVALID_KEY_FORMAT', 400);
  }
}

function validatePriority(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const priority = Number(value);
  if (!Number.isInteger(priority) || priority < 0) throw new DomainError('INVALID_PRIORITY', 400);
  return priority;
}

/** The recruitment worker reads `base_url:` out of notes, so keep that copy. */
function notesForPurpose(purpose: string, notes: string | null, baseUrl: string | null): string | null {
  if (purpose !== 'recruitment' || !baseUrl) return notes;
  return [notes, `base_url:${baseUrl}`].filter(Boolean).join('\n') || null;
}

const publicRow = (rowData: Record<string, unknown>) => ({
  id: rowData.id,
  provider: rowData.provider,
  key_name: rowData.key_name,
  masked_key: maskKey(safeDecryptSecret(String(rowData.api_key ?? ''))),
  model: rowData.model,
  purpose: rowData.purpose,
  purpose_tags: rowData.purpose_tags ?? [],
  base_url: rowData.base_url ?? null,
  priority: Number(rowData.priority ?? 0),
  is_free: rowData.is_free === true,
  is_active: rowData.is_active,
  fail_count: Number(rowData.fail_count ?? 0),
  usage_count: Number(rowData.usage_count ?? 0),
  last_used_at: rowData.last_used_at,
  last_error: rowData.last_error,
  last_error_at: rowData.last_error_at,
  cooldown_until: rowData.cooldown_until,
  daily_limit: rowData.daily_limit,
  daily_usage: Number(rowData.daily_usage ?? 0),
  daily_reset_at: rowData.daily_reset_at,
  created_at: rowData.created_at,
  updated_at: rowData.updated_at,
  notes: rowData.notes,
});

export async function listApiKeys(filters: {provider?: string; purpose?: string; active?: boolean} = {}) {
  const data = await rows<Record<string, unknown>>(
    `SELECT * FROM api_keys
      WHERE ($1::text IS NULL OR provider = $1)
        AND ($2::text IS NULL OR purpose = $2 OR $2 = ANY (purpose_tags))
        AND ($3::boolean IS NULL OR is_active = $3)
      ORDER BY priority ASC, created_at DESC`,
    [filters.provider ?? null, filters.purpose ?? null, filters.active ?? null],
  );
  return data.map(publicRow);
}

export async function createApiKey(actor: Actor, input: {
  provider: string; keyName: string; apiKey: string; model?: string | null;
  purpose?: string; baseUrl?: string | null; priority?: number; isFree?: boolean;
  dailyLimit?: number | null; notes?: string | null;
}) {
  assertCapability(actor as never, 'settings.manage');
  const provider = normalizeProvider(input.provider);
  if (!provider) throw new DomainError('INVALID_PROVIDER', 400);
  const purpose = String(input.purpose ?? 'recruitment').trim().toLowerCase();
  if (!PURPOSES.has(purpose)) throw new DomainError('INVALID_PURPOSE', 400);

  // Ollama needs no credential; a placeholder keeps the NOT NULL column honest.
  const supplied = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  const apiKey = provider === 'ollama' && !supplied ? 'ollama' : supplied;
  validateKey(provider, apiKey);

  const baseUrl = resolveBaseUrl(provider, input.baseUrl);
  if (!baseUrl) throw new DomainError('BASE_URL_REQUIRED', 400);

  const model = optionalText(input.model, 'model', 120);
  if (!model) throw new DomainError('MODEL_REQUIRED', 400);

  const priority = validatePriority(input.priority);
  const isFree = input.isFree === true;
  const limit = input.dailyLimit === null || input.dailyLimit === undefined ? null : Number(input.dailyLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new DomainError('INVALID_DAILY_LIMIT', 400);
  const notes = notesForPurpose(purpose, optionalText(input.notes, 'notes', 2000), baseUrl);

  return tx(async (client) => {
    const existing = await client.query<{api_key: string}>(
      'SELECT api_key FROM api_keys WHERE provider = $1', [provider],
    );
    const duplicate = existing.rows.some((item) => safeDecryptSecret(item.api_key) === apiKey);
    if (duplicate) throw new DomainError('DUPLICATE_KEY', 409);
    const stored = isEncryptedPurpose(purpose) ? encryptSecret(apiKey) : apiKey;
    const created = await client.query<Record<string, unknown>>(
      `INSERT INTO api_keys
         (provider, key_name, api_key, model, purpose, base_url, priority, is_free, daily_limit, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [provider, text(input.keyName, 'keyName', {max: 120}), stored, model, purpose,
        baseUrl, priority, isFree, limit, notes, actor.id],
    );
    await recordAudit({actor, action: 'API_KEY_CREATED', entity: 'api_key',
      entityId: String(created.rows[0].id), detail: {
        provider, purpose, keyName: input.keyName, masked: maskKey(apiKey),
        encrypted: isEncryptedPurpose(purpose), priority, isFree, baseUrl,
      }}, client);
    return publicRow(created.rows[0]);
  });
}

export async function updateApiKey(actor: Actor, input: {
  id: string; keyName?: string; provider?: string; model?: string; purpose?: string;
  baseUrl?: string | null; priority?: number; isFree?: boolean;
  dailyLimit?: number | null; isActive?: boolean; notes?: string | null;
}) {
  assertCapability(actor as never, 'settings.manage');
  const id = text(input.id, 'id', {max: 120});
  return tx(async (client) => {
    const current = await client.query<Record<string, unknown>>('SELECT * FROM api_keys WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new DomainError('API_KEY_NOT_FOUND', 404);
    const existing = current.rows[0];

    const purpose = input.purpose === undefined ? String(existing.purpose) : String(input.purpose).toLowerCase();
    if (!PURPOSES.has(purpose)) throw new DomainError('INVALID_PURPOSE', 400);

    const provider = input.provider === undefined ? String(existing.provider) : normalizeProvider(input.provider);
    if (!provider || provider.length > 60) throw new DomainError('INVALID_PROVIDER', 400);

    const currentLimit = existing.daily_limit;
    const limit: number | null = input.dailyLimit === undefined
      ? (currentLimit === null || currentLimit === undefined ? null : Number(currentLimit))
      : input.dailyLimit === null ? null : Number(input.dailyLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new DomainError('INVALID_DAILY_LIMIT', 400);

    const baseUrl = input.baseUrl === undefined
      ? (existing.base_url ? String(existing.base_url) : resolveBaseUrl(provider, baseUrlFromNotes(existing.notes as string | null)))
      : resolveBaseUrl(provider, input.baseUrl);
    if (!baseUrl) throw new DomainError('BASE_URL_REQUIRED', 400);

    const priority = input.priority === undefined ? Number(existing.priority ?? 0) : validatePriority(input.priority);
    const isFree = input.isFree === undefined ? existing.is_free === true : input.isFree === true;
    const notesText = input.notes === undefined ? (existing.notes as string | null) : optionalText(input.notes, 'notes', 2000);

    const updated = await client.query<Record<string, unknown>>(
      `UPDATE api_keys
          SET provider = $2, key_name = $3, model = $4, purpose = $5, base_url = $6,
              priority = $7, is_free = $8, daily_limit = $9, is_active = $10, notes = $11
        WHERE id = $1 RETURNING *`,
      [id, provider,
        input.keyName === undefined ? existing.key_name : text(input.keyName, 'keyName', {max: 120}),
        input.model === undefined ? existing.model : optionalText(input.model, 'model', 120),
        purpose, baseUrl, priority, isFree, limit,
        input.isActive === undefined ? existing.is_active : Boolean(input.isActive),
        notesForPurpose(purpose, notesText, baseUrl)],
    );
    await recordAudit({actor, action: 'API_KEY_UPDATED', entity: 'api_key', entityId: id,
      detail: {updated: Object.keys(input)}}, client);
    return publicRow(updated.rows[0]);
  });
}

export async function deleteApiKey(actor: Actor, id: string) {
  assertCapability(actor as never, 'settings.manage');
  const key = text(id, 'id', {max: 120});
  return tx(async (client) => {
    const deleted = await client.query('DELETE FROM api_keys WHERE id = $1 RETURNING id', [key]);
    if (!deleted.rowCount) throw new DomainError('API_KEY_NOT_FOUND', 404);
    await recordAudit({actor, action: 'API_KEY_DELETED', entity: 'api_key', entityId: key}, client);
    return {id: key, deleted: true};
  });
}

export async function getApiKeyForTest(id: string) {
  const data = await row<{
    id: string; provider: string; api_key: string; model: string | null;
    notes: string | null; base_url: string | null;
  }>(
    'SELECT id, provider, api_key, model, notes, base_url FROM api_keys WHERE id = $1', [id],
  );
  if (!data) return data;
  return {...data, api_key: decryptSecret(data.api_key)};
}

export async function recordKeyTest(id: string, result: {ok: boolean; error?: string}) {
  await row(
    `UPDATE api_keys
        SET last_used_at = CASE WHEN $2 THEN now() ELSE last_used_at END,
            last_error = $3,
            last_error_at = CASE WHEN $2 THEN last_error_at ELSE now() END,
            cooldown_until = CASE WHEN $2 THEN NULL ELSE now() + interval '60 seconds' END,
            fail_count = CASE WHEN $2 THEN 0 ELSE fail_count + 1 END
      WHERE id = $1`,
    [id, result.ok, result.ok ? null : String(result.error ?? 'TEST_FAILED').slice(0, 500)],
  );
}
