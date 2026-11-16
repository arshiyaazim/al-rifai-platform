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

/** Recruitment purpose is served by the separate worker. */
const RECRUITMENT_PROVIDERS = ['gemini', 'openai', 'anthropic', 'other'];

function assertRecruitmentProvider(provider: string, purpose: string): void {
  if (purpose !== 'recruitment') return;
  if (RECRUITMENT_PROVIDERS.includes(provider)) return;
  throw new DomainError(
    'RECRUITMENT_PROVIDER_NOT_SUPPORTED', 400,
    'recruitment keys work with gemini, openai (use openai for OpenRouter keys), anthropic or other',
  );
}

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
  has_key: Boolean(rowData.api_key),
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
  assertRecruitmentProvider(provider, purpose);

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
  baseUrl?: string | null; priority?: number; isFree?: boolean; apiKey?: string;
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
    assertRecruitmentProvider(provider, purpose);

    // A pasted replacement is written in the same form the purpose expects;
    // otherwise a purpose change rewrites the existing secret, because the
    // recruitment worker reads plaintext while platform purposes are sealed.
    let storedKey = String(existing.api_key ?? '');
    let reencrypted = false;
    let replaced = false;
    const replacement = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
    if (replacement) {
      validateKey(provider, replacement);
      const duplicate = await client.query<{id: string; api_key: string}>(
        'SELECT id, api_key FROM api_keys WHERE provider = $1 AND id <> $2', [provider, id],
      );
      if (duplicate.rows.some((item) => safeDecryptSecret(item.api_key) === replacement)) {
        throw new DomainError('DUPLICATE_KEY', 409);
      }
      storedKey = isEncryptedPurpose(purpose) ? encryptSecret(replacement) : replacement;
      replaced = true;
    } else if (purpose !== String(existing.purpose)) {
      const plain = safeDecryptSecret(storedKey);
      if (plain) {
        const next = isEncryptedPurpose(purpose) ? encryptSecret(plain) : plain;
        reencrypted = next !== storedKey;
        storedKey = next;
      }
    }

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
              priority = $7, is_free = $8, daily_limit = $9, is_active = $10, notes = $11,
              api_key = $12
        WHERE id = $1 RETURNING *`,
      [id, provider,
        input.keyName === undefined ? existing.key_name : text(input.keyName, 'keyName', {max: 120}),
        input.model === undefined ? existing.model : optionalText(input.model, 'model', 120),
        purpose, baseUrl, priority, isFree, limit,
        input.isActive === undefined ? existing.is_active : Boolean(input.isActive),
        notesForPurpose(purpose, notesText, baseUrl), storedKey],
    );
    await recordAudit({actor, action: 'API_KEY_UPDATED', entity: 'api_key', entityId: id,
      detail: {updated: Object.keys(input), reencrypted, replaced}}, client);
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

export async function recordKeyTest(id: string, result: {ok: boolean; error?: string; status?: number}) {
  const status = Number(result.status ?? 0);
  const rateLimited = !result.ok && status === 429;
  // A manual test never disables a key: a human may pasted it wrong once. Only
  // live traffic (provider-client.completeChat) deactivates on 401/403.
  await row(
    `UPDATE api_keys
        SET last_used_at = CASE WHEN $2 THEN now() ELSE last_used_at END,
            last_error = $3,
            last_error_at = CASE WHEN $2 THEN last_error_at ELSE now() END,
            cooldown_until = CASE WHEN $2 THEN NULL
                                  WHEN $4 THEN now() + interval '60 seconds'
                                  ELSE cooldown_until END,
            fail_count = CASE WHEN $2 THEN 0 ELSE fail_count + 1 END
      WHERE id = $1`,
    [id, result.ok, result.ok ? null : String(result.error ?? 'TEST_FAILED').slice(0, 500), rateLimited],
  );
}

export type PurposeOverview = {
  purpose: string;
  total: number;
  active: number;
  cooldown: number;
  failed: number;
  provider: string | null;
  model: string | null;
  is_free: boolean | null;
  priority: number | null;
};

/**
 * Per-purpose summary for the settings dashboard: how many keys exist, how many
 * are usable right now, and which provider/model would be tried first.
 *
 * A key counts for every purpose in `purpose` plus `purpose_tags`, matching the
 * lookup used by lib/ai/key-store.ts.
 */
export async function apiKeyOverview(): Promise<PurposeOverview[]> {
  const counts = await rows<{
    purpose: string; total: number; active: number; cooldown: number; failed: number;
  }>(
    `WITH expanded AS (
       SELECT id, purpose, is_active, cooldown_until, last_error
         FROM api_keys
       UNION ALL
       SELECT id, unnest(purpose_tags), is_active, cooldown_until, last_error
         FROM api_keys
        WHERE coalesce(array_length(purpose_tags, 1), 0) > 0
     )
     SELECT purpose,
            count(DISTINCT id)::int AS total,
            count(DISTINCT id) FILTER (WHERE is_active)::int AS active,
            count(DISTINCT id) FILTER (WHERE is_active AND cooldown_until > now())::int AS cooldown,
            count(DISTINCT id) FILTER (
              WHERE is_active AND (cooldown_until IS NULL OR cooldown_until <= now())
                AND last_error IS NOT NULL)::int AS failed
       FROM expanded
      GROUP BY purpose`,
  );

  const best = await rows<{
    purpose: string; provider: string; model: string | null; is_free: boolean; priority: number;
  }>(
    `WITH expanded AS (
       SELECT id, purpose, provider, model, is_free, priority, fail_count, last_used_at
         FROM api_keys
        WHERE is_active = true
          AND (cooldown_until IS NULL OR cooldown_until <= now())
       UNION ALL
       SELECT id, unnest(purpose_tags), provider, model, is_free, priority, fail_count, last_used_at
         FROM api_keys
        WHERE is_active = true
          AND (cooldown_until IS NULL OR cooldown_until <= now())
          AND coalesce(array_length(purpose_tags, 1), 0) > 0
     )
     SELECT DISTINCT ON (purpose) purpose, provider, model, is_free, priority
       FROM expanded
      ORDER BY purpose,
               is_free DESC,
               coalesce(priority, 0) ASC,
               coalesce(fail_count, 0) ASC,
               coalesce(last_used_at, 'epoch'::timestamptz) ASC`,
  );

  const bestByPurpose = new Map(best.map((entry) => [entry.purpose, entry]));
  return counts.map((entry) => {
    const winner = bestByPurpose.get(entry.purpose);
    return {
      purpose: entry.purpose,
      total: Number(entry.total),
      active: Number(entry.active),
      cooldown: Number(entry.cooldown),
      failed: Number(entry.failed),
      provider: winner?.provider ?? null,
      model: winner?.model ?? null,
      is_free: winner ? winner.is_free === true : null,
      priority: winner ? Number(winner.priority ?? 0) : null,
    };
  });
}
