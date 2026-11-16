BEGIN;

-- AL-RIFA'I — Migration 027: multi-provider AI key registry (schema 1.13.8).
--
-- Additive only. No existing row, purpose, provider or key value is removed or
-- rewritten. The recruitment application keeps reading `api_key` as plaintext;
-- platform keys continue to carry the `enc:v1:` prefix produced by
-- lib/ai/crypto.ts, so a single column stays the one source of truth.
--
-- Column mapping note: `cooldown_until` IS the rate-limit marker. It is already
-- written by the live recruitment app, so a second `rate_limit_until` column
-- would drift out of sync. The new key manager treats cooldown_until as the
-- rate-limit-until value.

-- 1. provider: the closed enum becomes an open string.
--    Any OpenAI-compatible provider (gemini, openai, anthropic, groq, mistral,
--    openrouter, ollama, other, or something added later) is accepted.
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_provider_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_provider_check
  CHECK (char_length(btrim(provider)) BETWEEN 1 AND 60);

-- 2. purpose: keep every existing value, add the platform values.
--    'general' is deliberately NOT renamed; it remains its own purpose.
ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_purpose_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_purpose_check
  CHECK (purpose IN (
    'recruitment', 'vessel-ai', 'general', 'other',
    'platform-llm', 'platform-assistant', 'ocr'
  ));

-- 3. New columns.
--    base_url          explicit endpoint for OpenAI-compatible providers
--    priority          failover order, lower is tried first
--    is_free           free-tier marker for the free-model-first policy
--    purpose_tags      additional purposes a key may serve (alias tags)
--    fail_count        consecutive failures, for diagnostics and backoff
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS base_url text;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false;
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS purpose_tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS fail_count integer NOT NULL DEFAULT 0;

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_priority_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_priority_check CHECK (priority >= 0);

ALTER TABLE public.api_keys DROP CONSTRAINT IF EXISTS api_keys_fail_count_check;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_fail_count_check CHECK (fail_count >= 0);

-- 4. Backfill base_url from the legacy `notes` convention (`base_url:<url>`).
--    The notes text is left untouched so the recruitment application's
--    baseUrlFromNotes() keeps resolving exactly as it does today.
UPDATE public.api_keys
   SET base_url = substring(notes from 'base_url:([^[:space:]]+)')
 WHERE base_url IS NULL
   AND notes LIKE '%base_url:%';

-- 5. Free-tier flags for the existing OpenRouter free models.
UPDATE public.api_keys
   SET is_free = true
 WHERE is_free = false
   AND (model LIKE '%:free' OR model LIKE '%.free');

-- 6. Alias tag: the row whose purpose is 'general' may also serve
--    'platform-llm'. The purpose column itself is not changed.
UPDATE public.api_keys
   SET purpose_tags = array_append(purpose_tags, 'platform-llm')
 WHERE purpose = 'general'
   AND NOT ('platform-llm' = ANY (purpose_tags));

-- 7. Lookup indexes for key selection (purpose + priority + availability)
--    and for the purpose_tags alias match.
CREATE INDEX IF NOT EXISTS idx_api_keys_pick
  ON public.api_keys (purpose, priority, is_active)
  WHERE is_active = true;

CREATE INDEX IF NOT EXISTS idx_api_keys_purpose_tags
  ON public.api_keys USING GIN (purpose_tags);

COMMENT ON COLUMN public.api_keys.base_url IS
  'Explicit provider endpoint. Gemini may leave this empty (OpenAI-compatible default is applied by the app); Ollama defaults to http://ollama:11434/v1.';
COMMENT ON COLUMN public.api_keys.is_free IS
  'Free-tier model marker used by the free-model-first selection policy.';
COMMENT ON COLUMN public.api_keys.purpose_tags IS
  'Additional purposes this key may serve, e.g. a general key tagged platform-llm.';

UPDATE public.schema_meta SET value = '1.13.8' WHERE key = 'schema_version';

COMMIT;
