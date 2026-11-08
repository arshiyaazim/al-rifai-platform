-- AL-RIFA'I — Migration 014: manual vessel programs and cash instruction notes.
--
-- Additive and idempotent. No existing values are rewritten except the
-- source_type backfill, which only classifies the existing source_channel.
--
--   programs.master_name  optional Master name captured from a manually
--                         created program. WhatsApp orders still store the
--                         Master Mobile and never invent a name.
--   programs.source_type  MANUAL for web-created programs; WHATSAPP_ORDER for
--                         programs created from the authorised WhatsApp order
--                         path. This is a label only; source_channel and all
--                         authorisation rules remain unchanged.
--
-- Cash instruction free-text "notes" reuse the existing `purpose` column; no
-- new cash column is added.
--
-- Rollback (disposable/test only, after backup):
--   ALTER TABLE programs DROP COLUMN IF EXISTS master_name;
--   ALTER TABLE programs DROP COLUMN IF EXISTS source_type;
--   DELETE FROM schema_migrations WHERE version='014';
--   UPDATE schema_meta SET value='1.8.0' WHERE key='schema_version';

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS master_name text
  CHECK (master_name IS NULL OR length(btrim(master_name)) BETWEEN 1 AND 150);

ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'MANUAL'
  CHECK (source_type IN ('MANUAL','WHATSAPP_ORDER'));

UPDATE programs
   SET source_type = 'WHATSAPP_ORDER'
 WHERE source_channel = 'WHATSAPP'
   AND source_type = 'MANUAL';

UPDATE schema_meta SET value = '1.9.0' WHERE key = 'schema_version';
