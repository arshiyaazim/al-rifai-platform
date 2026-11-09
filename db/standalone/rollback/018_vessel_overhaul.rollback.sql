BEGIN;

-- AL-RIFA'I — Rollback for migration 018 (Vessel/Escort overhaul schema).
-- Restores the 1.12.0 Vessel shape. Cash tables are not touched.
-- This file lives in db/standalone/rollback/ so the migration runner never
-- mistakes it for a forward migration.

UPDATE schema_meta SET value = '1.12.0' WHERE key = 'schema_version';
DROP TABLE IF EXISTS vessel_backlog_progress;
DROP TABLE IF EXISTS message_pipeline_state;
DROP TABLE IF EXISTS message_review_queue;
DROP TABLE IF EXISTS system_feature_flags;
DROP INDEX IF EXISTS idx_programs_escort_change;
DROP INDEX IF EXISTS idx_programs_source_block;
DROP INDEX IF EXISTS idx_programs_source_message;
DROP INDEX IF EXISTS idx_programs_order_key_event;
DROP INDEX IF EXISTS idx_programs_event_at;
ALTER TABLE programs ALTER COLUMN event_at DROP NOT NULL;
ALTER TABLE programs DROP COLUMN IF EXISTS escort_change_from_program_id;
ALTER TABLE programs DROP COLUMN IF EXISTS draft_generated_at;
ALTER TABLE programs DROP COLUMN IF EXISTS draft_text;
ALTER TABLE programs DROP COLUMN IF EXISTS order_key;
ALTER TABLE programs DROP COLUMN IF EXISTS source_block_key;
ALTER TABLE programs DROP COLUMN IF EXISTS event_at;

COMMIT;
