BEGIN;

-- AL-RIFA'I — Migration 018: Vessel/Escort overhaul schema (1.13.0).
-- Additive only. Cash tables are not touched.
-- Rollback: db/standalone/rollback/018_vessel_overhaul.rollback.sql
-- (Keep rollback outside db/standalone top level: the runner treats every
--  top-level NNN_*.sql file as a forward migration.)

ALTER TABLE programs ADD COLUMN IF NOT EXISTS event_at timestamptz;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS source_block_key text;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS order_key text;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS draft_text text;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS draft_generated_at timestamptz;
ALTER TABLE programs ADD COLUMN IF NOT EXISTS escort_change_from_program_id text
  REFERENCES programs(id);

UPDATE programs p SET event_at = m.source_timestamp
  FROM whatsapp_messages m
 WHERE m.account_id = 'wa-01'
   AND m.message_id = p.source_message_id
   AND m.chat_jid = p.source_chat_jid
   AND p.event_at IS NULL;

UPDATE programs SET event_at = created_at WHERE event_at IS NULL;
ALTER TABLE programs ALTER COLUMN event_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_programs_event_at ON programs (event_at);
CREATE INDEX IF NOT EXISTS idx_programs_order_key_event
  ON programs (order_key, event_at DESC) WHERE order_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_programs_source_message
  ON programs (source_message_id) WHERE source_message_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_programs_source_block
  ON programs (source_message_id, source_block_key)
  WHERE source_message_id IS NOT NULL AND source_block_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_programs_escort_change
  ON programs (escort_change_from_program_id)
  WHERE escort_change_from_program_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS system_feature_flags (
  key text PRIMARY KEY,
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);

INSERT INTO system_feature_flags (key, enabled, config) VALUES
  ('vessel.processing',       true,  '{}'),
  ('vessel.auto_confirm',     true,  '{"fuzzy_threshold": 0.90}'),
  ('vessel.duplicate_days',   true,  '{"days": 5}'),
  ('vessel.shift_cutoff',     true,  '{"cutoff": "15:30", "tz": "Asia/Dhaka"}'),
  ('vessel.mv_prefix',        true,  '{"prefix": "MV "}'),
  ('vessel.draft_to_admin',   false, '{}'),
  ('vessel.draft_to_office',  false, '{}'),
  ('vessel.office_forward',   false, '{}'),
  ('release.food_divisor',    true,  '{"divisor": 150, "tolerance_days": 2}'),
  ('release.match_mode',      true,  '{"mode": "fuzzy"}'),
  ('wa02.ai_agent',           false, '{}')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS message_review_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_account_id text NOT NULL,
  source_chat_jid text NOT NULL,
  source_message_id text NOT NULL,
  source_timestamp timestamptz NOT NULL,
  sender_jid text NOT NULL,
  sender_display_name text,
  sender_mobile text,
  message_text text NOT NULL,
  message_media_url text,
  confusion_reason text NOT NULL,
  suggested_workflow text,
  resolved_workflow text,
  resolved_payload jsonb,
  resolved_by text,
  resolved_at timestamptz,
  admin_comment text,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','REJECTED','SENT_BACK','IGNORED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(source_account_id, source_chat_jid, source_message_id)
);
CREATE INDEX IF NOT EXISTS idx_review_queue_status ON message_review_queue (status, created_at);

CREATE TABLE IF NOT EXISTS message_pipeline_state (
  account_id text NOT NULL,
  message_id text NOT NULL,
  pipeline text NOT NULL CHECK (pipeline IN ('vessel','cash','release','employee')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','done','error','skipped')),
  result jsonb,
  processed_at timestamptz,
  PRIMARY KEY (account_id, message_id, pipeline)
);

CREATE TABLE IF NOT EXISTS vessel_backlog_progress (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  freeze_started_at timestamptz NOT NULL,
  freeze_cutover_rowid_wa01 bigint,
  freeze_cutover_rowid_wa02 bigint,
  unfreeze_at timestamptz,
  total_messages bigint,
  processed_messages bigint DEFAULT 0,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','done','error')),
  created_at timestamptz NOT NULL DEFAULT now()
);

UPDATE schema_meta SET value = '1.13.0' WHERE key = 'schema_version';

COMMIT;
