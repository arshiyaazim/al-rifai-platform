// Platform AI key resolution — provider-agnostic, multi-key, failover-aware.
//
// There is no provider filter here. A key is a candidate for a purpose when its
// `purpose` column matches OR its `purpose_tags` array contains that purpose.
// Ordering implements the free-model-first policy:
//
//   free tier first -> priority ASC -> least recently used -> oldest
//
// A key that is cooling down (rate limited), disabled, or over its daily limit
// is never returned. When nothing is usable the caller gets an empty list and
// falls back to a deterministic answer; it never throws to the user.

import {row, rows} from '../standalone/db.ts';
import {safeDecryptSecret} from './crypto.ts';
import {baseUrlFromNotes, resolveBaseUrl} from '../ai-provider.ts';

export type PlatformKey = {
  id: string;
  provider: string;
  apiKey: string;
  model: string;
  baseUrl: string;
  priority: number;
  isFree: boolean;
  timeoutMs: number;
  source: 'database' | 'env';
};

export type KeyPurpose = 'platform-llm' | 'platform-assistant' | 'ocr' | 'general';

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? '');
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.max(Math.floor(value), 1_000), 300_000);
}

/** Per-provider timeout. Gemini is fast; local Ollama can take a minute or more. */
export function providerTimeoutMs(provider: string): number {
  if (provider === 'ollama') return numberEnv('AI_OLLAMA_TIMEOUT_MS', 120_000);
  if (provider === 'gemini') return numberEnv('AI_LLM_TIMEOUT_MS', 12_000);
  if (provider === 'anthropic') return numberEnv('AI_ANTHROPIC_TIMEOUT_MS', 30_000);
  return numberEnv('AI_PROVIDER_TIMEOUT_MS', 30_000);
}

type KeyRow = {
  id: string;
  provider: string;
  api_key: string;
  model: string | null;
  base_url: string | null;
  notes: string | null;
  priority: number | null;
  is_free: boolean | null;
};

/**
 * Every usable key for a purpose, best candidate first.
 *
 * `purpose_tags` lets one key serve several purposes without duplicating rows,
 * e.g. the legacy `general` key tagged `platform-llm`.
 */
export async function listPlatformKeys(purpose: KeyPurpose, limit = 10): Promise<PlatformKey[]> {
  const data = await rows<KeyRow>(
    `SELECT id, provider, api_key, model, base_url, notes, priority, is_free
       FROM api_keys
      WHERE is_active = true
        AND (purpose = $1 OR $1 = ANY (purpose_tags))
        AND (daily_limit IS NULL OR daily_usage < daily_limit)
        AND (cooldown_until IS NULL OR cooldown_until <= now())
        AND model IS NOT NULL
        AND btrim(model) <> ''
      ORDER BY is_free DESC,
               coalesce(priority, 0) ASC,
               coalesce(last_used_at, 'epoch'::timestamptz) ASC,
               created_at ASC
      LIMIT $2`,
    [purpose, limit],
  );

  const keys: PlatformKey[] = [];
  for (const record of data) {
    const provider = String(record.provider ?? '').trim().toLowerCase();
    const apiKey = safeDecryptSecret(record.api_key);
    // Ollama needs no credential; every other provider needs a usable secret.
    if (!apiKey && provider !== 'ollama') continue;
    const baseUrl = resolveBaseUrl(provider, record.base_url || baseUrlFromNotes(record.notes));
    if (!baseUrl) continue;
    keys.push({
      id: String(record.id),
      provider,
      apiKey: apiKey || 'ollama',
      model: String(record.model),
      baseUrl,
      priority: Number(record.priority ?? 0),
      isFree: record.is_free === true,
      timeoutMs: providerTimeoutMs(provider),
      source: 'database',
    });
  }
  return keys;
}

/** Best single candidate, or null when the purpose has nothing usable. */
export async function getActiveKey(purpose: KeyPurpose = 'platform-llm'): Promise<PlatformKey | null> {
  const keys = await listPlatformKeys(purpose, 1);
  return keys[0] ?? null;
}

/** Backwards-compatible alias: older callers asked for the first key only. */
export const getPlatformKey = getActiveKey;

// Markers never throw: telemetry must not break a reply, and an `env` key has no
// row to update.
const isStored = (id: string) => Boolean(id) && id !== 'env' && !id.startsWith('env:');

export async function markSuccess(id: string): Promise<void> {
  if (!isStored(id)) return;
  try {
    await row(
      `UPDATE api_keys
          SET usage_count = usage_count + 1,
              daily_usage = daily_usage + 1,
              last_used_at = now(),
              last_error = NULL,
              last_error_at = NULL,
              fail_count = 0,
              cooldown_until = NULL
        WHERE id = $1`, [id],
    );
  } catch { /* ignore */ }
}

/** 429: park the key until the retry window passes, then it is eligible again. */
export async function markRateLimited(id: string, retryAfterSeconds = 60): Promise<void> {
  if (!isStored(id)) return;
  const seconds = Math.min(Math.max(Math.floor(retryAfterSeconds) || 60, 5), 86_400);
  try {
    await row(
      `UPDATE api_keys
          SET last_error = 'RATE_LIMITED',
              last_error_at = now(),
              cooldown_until = now() + ($2 || ' seconds')::interval
        WHERE id = $1`,
      [id, String(seconds)],
    );
  } catch { /* ignore */ }
}

/** 5xx / network / empty response: record it and bump the failure counter. */
export async function markError(id: string, message: string): Promise<void> {
  if (!isStored(id)) return;
  try {
    await row(
      `UPDATE api_keys
          SET last_error = $2,
              last_error_at = now(),
              fail_count = fail_count + 1
        WHERE id = $1`,
      [id, String(message ?? 'FAILED').slice(0, 500)],
    );
  } catch { /* ignore */ }
}

/** 401/403: the credential is not usable, so stop offering it at all. */
export async function markAuthFailure(id: string, message = 'AUTH_FAILED'): Promise<void> {
  if (!isStored(id)) return;
  try {
    await row(
      `UPDATE api_keys
          SET is_active = false,
              last_error = $2,
              last_error_at = now(),
              fail_count = fail_count + 1
        WHERE id = $1`,
      [id, String(message).slice(0, 500)],
    );
  } catch { /* ignore */ }
}

/** Which purposes have at least one usable key (for status screens). */
export async function usablePurposes(): Promise<Record<string, number>> {
  const data = await rows<{purpose: string; n: string}>(
    `SELECT purpose, count(*)::text AS n
       FROM api_keys
      WHERE is_active = true
        AND (cooldown_until IS NULL OR cooldown_until <= now())
      GROUP BY purpose`,
  );
  return Object.fromEntries(data.map((entry) => [entry.purpose, Number(entry.n)]));
}
