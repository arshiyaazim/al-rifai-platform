-- AL-RIFA'I — Migration 017: Cash event time.
--
-- `event_at` stores the real-world WhatsApp event time (the bridge
-- `messages.timestamp` mirrored as `whatsapp_messages.source_timestamp`).
-- `created_at` continues to store the database insertion time.
--
-- Additive and idempotent. Existing rows are backfilled from `created_at`
-- before the NOT NULL constraint is applied, so the migration is safe to run
-- independently of the Cash backfill.
--
-- Rollback (disposable/test only, after backup):
--   DROP INDEX IF EXISTS idx_cash_instructions_event_at;
--   ALTER TABLE cash_instructions DROP COLUMN IF EXISTS event_at;
--   DELETE FROM schema_migrations WHERE version='017';
--   UPDATE schema_meta SET value='1.11.0' WHERE key='schema_version';

ALTER TABLE cash_instructions
  ADD COLUMN IF NOT EXISTS event_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_cash_instructions_event_at
  ON cash_instructions (event_at);

UPDATE cash_instructions
   SET event_at = created_at
 WHERE event_at IS NULL;

ALTER TABLE cash_instructions
  ALTER COLUMN event_at SET NOT NULL;

UPDATE schema_meta SET value = '1.12.0' WHERE key = 'schema_version';
