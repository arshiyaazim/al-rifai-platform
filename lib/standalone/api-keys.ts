import {row, rows, tx, text, optionalText, DomainError, type Actor} from './db.ts';
import {recordAudit} from './audit.ts';
import {assertCapability} from './authz.ts';

export type ApiKeyProvider = 'gemini' | 'openai' | 'anthropic' | 'other';
export type ApiKeyPurpose = 'recruitment' | 'vessel-ai' | 'general' | 'other';

const PROVIDERS = new Set(['gemini', 'openai', 'anthropic', 'other']);
const PURPOSES = new Set(['recruitment', 'vessel-ai', 'general', 'other']);

export function maskKey(value: string): string {
  const key = String(value ?? '');
  if (key.length <= 12) return `${key.slice(0, 3)}****${key.slice(-2)}`;
  return `${key.slice(0, 7)}...****${key.slice(-4)}`;
}

function validateKey(provider: string, apiKey: string) {
  if (provider === 'gemini' && !/^AIza[0-9A-Za-z_-]{35}$/.test(apiKey)) throw new DomainError('INVALID_KEY_FORMAT', 400);
  if (provider === 'openai' && !/^sk-[A-Za-z0-9_-]{16,}$/.test(apiKey)) throw new DomainError('INVALID_KEY_FORMAT', 400);
  if (provider === 'anthropic' && !/^sk-ant-[A-Za-z0-9_-]{16,}$/.test(apiKey)) throw new DomainError('INVALID_KEY_FORMAT', 400);
  if (!apiKey.trim() || apiKey.length > 500) throw new DomainError('INVALID_KEY_FORMAT', 400);
}

const publicRow = (rowData: Record<string, unknown>) => ({
  id: rowData.id,
  provider: rowData.provider,
  key_name: rowData.key_name,
  masked_key: maskKey(String(rowData.api_key ?? '')),
  model: rowData.model,
  purpose: rowData.purpose,
  is_active: rowData.is_active,
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
        AND ($2::text IS NULL OR purpose = $2)
        AND ($3::boolean IS NULL OR is_active = $3)
      ORDER BY created_at DESC`,
    [filters.provider ?? null, filters.purpose ?? null, filters.active ?? null],
  );
  return data.map(publicRow);
}

export async function createApiKey(actor: Actor, input: {
  provider: string; keyName: string; apiKey: string; model?: string;
  purpose?: string; dailyLimit?: number | null; notes?: string | null;
}) {
  assertCapability(actor as never, 'settings.manage');
  const provider = String(input.provider ?? '').toLowerCase();
  if (!PROVIDERS.has(provider)) throw new DomainError('INVALID_PROVIDER', 400);
  const purpose = String(input.purpose ?? 'recruitment').toLowerCase();
  if (!PURPOSES.has(purpose)) throw new DomainError('INVALID_PURPOSE', 400);
  const keyName = text(input.keyName, 'keyName', {max: 120});
  const apiKey = text(input.apiKey, 'apiKey', {max: 500});
  validateKey(provider, apiKey);
  const model = optionalText(input.model, 'model', 120) ?? (provider === 'gemini' ? 'gemini-2.0-flash' : null);
  const limit = input.dailyLimit === null || input.dailyLimit === undefined ? null : Number(input.dailyLimit);
  if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new DomainError('INVALID_DAILY_LIMIT', 400);

  return tx(async (client) => {
    const duplicate = await client.query('SELECT 1 FROM api_keys WHERE api_key = $1 LIMIT 1', [apiKey]);
    if (duplicate.rowCount) throw new DomainError('DUPLICATE_KEY', 409);
    const created = await client.query<Record<string, unknown>>(
      `INSERT INTO api_keys (provider, key_name, api_key, model, purpose, daily_limit, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [provider, keyName, apiKey, model, purpose, limit, optionalText(input.notes, 'notes', 2000), actor.id],
    );
    await recordAudit({actor, action: 'API_KEY_CREATED', entity: 'api_key',
      entityId: String(created.rows[0].id), detail: {provider, purpose, keyName, masked: maskKey(apiKey)}}, client);
    return publicRow(created.rows[0]);
  });
}

export async function updateApiKey(actor: Actor, input: {
  id: string; keyName?: string; model?: string; purpose?: string;
  dailyLimit?: number | null; isActive?: boolean; notes?: string | null;
}) {
  assertCapability(actor as never, 'settings.manage');
  const id = text(input.id, 'id', {max: 120});
  return tx(async (client) => {
    const current = await client.query<Record<string, unknown>>('SELECT * FROM api_keys WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) throw new DomainError('API_KEY_NOT_FOUND', 404);
    const purpose = input.purpose === undefined ? current.rows[0].purpose : String(input.purpose).toLowerCase();
    if (!PURPOSES.has(String(purpose))) throw new DomainError('INVALID_PURPOSE', 400);
    const currentLimit = current.rows[0].daily_limit;
    const limit: number | null = input.dailyLimit === undefined
      ? (currentLimit === null || currentLimit === undefined ? null : Number(currentLimit))
      : input.dailyLimit === null ? null : Number(input.dailyLimit);
    if (limit !== null && (!Number.isInteger(limit) || limit < 1)) throw new DomainError('INVALID_DAILY_LIMIT', 400);
    const updated = await client.query<Record<string, unknown>>(
      `UPDATE api_keys
          SET key_name = $2, model = $3, purpose = $4, daily_limit = $5,
              is_active = $6, notes = $7
        WHERE id = $1 RETURNING *`,
      [id,
        input.keyName === undefined ? current.rows[0].key_name : text(input.keyName, 'keyName', {max: 120}),
        input.model === undefined ? current.rows[0].model : optionalText(input.model, 'model', 120),
        purpose, limit,
        input.isActive === undefined ? current.rows[0].is_active : Boolean(input.isActive),
        input.notes === undefined ? current.rows[0].notes : optionalText(input.notes, 'notes', 2000)],
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

export function providerDefaultModel(provider: string): string {
  if (provider === 'openai') return 'gpt-4o-mini';
  if (provider === 'anthropic') return 'claude-3-5-haiku-latest';
  if (provider === 'gemini') return 'gemini-2.0-flash';
  return '';
}

export async function getApiKeyForTest(id: string) {
  return row<{id: string; provider: string; api_key: string; model: string | null}>(
    'SELECT id, provider, api_key, model FROM api_keys WHERE id = $1', [id],
  );
}

export async function recordKeyTest(id: string, result: {ok: boolean; error?: string}) {
  await row(
    `UPDATE api_keys
        SET last_used_at = CASE WHEN $2 THEN now() ELSE last_used_at END,
            last_error = $3,
            last_error_at = CASE WHEN $2 THEN last_error_at ELSE now() END,
            cooldown_until = CASE WHEN $2 THEN NULL ELSE now() + interval '60 seconds' END
      WHERE id = $1`,
    [id, result.ok, result.ok ? null : String(result.error ?? 'TEST_FAILED').slice(0, 500)],
  );
}
