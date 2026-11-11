BEGIN;

-- AL-RIFA'I — Migration 026: recruitment AI reply audit + mode setting.
-- Cash/Vessel tables are not touched.

CREATE TABLE IF NOT EXISTS public.recruitment_reply_log (
  id text PRIMARY KEY DEFAULT 'rpl_' || gen_random_uuid()::text,
  timestamp timestamptz NOT NULL DEFAULT now(),
  chat_jid text NOT NULL,
  sender_name text,
  sender_mobile text,
  incoming_message text,
  incoming_message_type text,
  category text,
  ai_reply text,
  status text NOT NULL,
  skip_reason text,
  gemini_key_id text,
  gemini_latency_ms integer,
  error text
);

CREATE INDEX IF NOT EXISTS idx_recruitment_log_time
  ON public.recruitment_reply_log (timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_recruitment_log_chat
  ON public.recruitment_reply_log (chat_jid);

INSERT INTO public.app_settings (key, value)
VALUES ('recruitment.mode', '{"mode":"DRY_RUN"}'::jsonb)
ON CONFLICT (key) DO NOTHING;

COMMIT;
