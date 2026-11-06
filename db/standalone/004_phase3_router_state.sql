-- AL-RIFA'I — Phase 3: router processing state (additive, idempotent).
--
-- Applied after schema.sql (001), 002_raw_import.sql and
-- 003_phase2_identity_media.sql. Every statement is CREATE ... IF NOT EXISTS
-- or ALTER ... ADD COLUMN IF NOT EXISTS. Nothing resets data; existing
-- processed_at/classification columns are preserved.
--
-- Columns added to whatsapp_messages for crash-safe routing:
--   processing_status : PENDING | PROCESSING | COMPLETED | FAILED
--   retry_count       : number of failed processing attempts (0..10)
--   last_error        : error message from the most recent failure
--   last_processed_at : timestamp of the last processing attempt
--
-- These columns let the router claim a message as PROCESSING, retry failures,
-- and distinguish "never processed" from "processed with error" without
-- relying on processed_at alone.

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'PENDING'
    CHECK (processing_status IN ('PENDING','PROCESSING','COMPLETED','FAILED'));

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0
    CHECK (retry_count >= 0 AND retry_count <= 10);

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS last_error text;

ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS last_processed_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_messages_processing_pending
  ON whatsapp_messages (processing_status, id)
  WHERE processing_status IN ('PENDING','FAILED');

CREATE INDEX IF NOT EXISTS whatsapp_messages_processing_retry
  ON whatsapp_messages (processing_status, last_processed_at)
  WHERE processing_status = 'FAILED';

-- Schema version bump
UPDATE schema_meta SET value = '1.3.0' WHERE key = 'schema_version';
