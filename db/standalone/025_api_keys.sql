BEGIN;

-- AL-RIFA'I — Migration 025: AI API key registry (1.13.7).
-- Cash/Vessel schemas are not touched. Keys are stored raw in this phase
-- (encryption is an explicit follow-up); the API never returns a full key.

CREATE TABLE IF NOT EXISTS public.api_keys (
  id text PRIMARY KEY DEFAULT 'apikey_' || gen_random_uuid()::text,
  provider text NOT NULL DEFAULT 'gemini'
    CHECK (provider IN ('gemini','openai','anthropic','other')),
  key_name text NOT NULL,
  api_key text NOT NULL,
  model text DEFAULT 'gemini-2.0-flash',
  purpose text DEFAULT 'recruitment'
    CHECK (purpose IN ('recruitment','vessel-ai','general','other')),
  is_active boolean NOT NULL DEFAULT true,
  usage_count integer NOT NULL DEFAULT 0,
  last_used_at timestamptz,
  last_error text,
  last_error_at timestamptz,
  cooldown_until timestamptz,
  daily_limit integer,
  daily_usage integer NOT NULL DEFAULT 0,
  daily_reset_at timestamptz DEFAULT date_trunc('day', now()),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_by text,
  notes text
);

CREATE INDEX IF NOT EXISTS idx_api_keys_active
  ON public.api_keys (provider, purpose, is_active)
  WHERE is_active = true;

CREATE OR REPLACE FUNCTION public.reset_daily_api_usage() RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE public.api_keys
     SET daily_usage = 0,
         daily_reset_at = date_trunc('day', now())
   WHERE daily_reset_at < date_trunc('day', now());
END $$;

CREATE OR REPLACE FUNCTION public.touch_api_key() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS api_keys_touch ON public.api_keys;
CREATE TRIGGER api_keys_touch BEFORE UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.touch_api_key();

UPDATE public.schema_meta SET value = '1.13.7' WHERE key = 'schema_version';

COMMIT;
