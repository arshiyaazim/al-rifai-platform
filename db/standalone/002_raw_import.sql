-- AL-RIFA'I — raw message import layer (additive, idempotent).
--
-- Applied after 001 (schema.sql) on a fresh installation. It widens the
-- transport-neutral message staging table so the bridge's persisted SQLite
-- store can be imported and then tailed continuously, without using the MCP
-- content-reader interface and without copying any session or key material.
--
-- Nothing here references the historical migration chain.

-- ─────────────────────────────────────────────── ingestion transports ──
-- The bridge persists every message it sees to its own SQLite store. Reading
-- that store is a supported, credential-free ingestion path: it needs no MCP
-- tool grant and no per-chat profile entry. It is registered as a transport so
-- the account row stays the single source of truth.
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_accounts_transport_check;
ALTER TABLE whatsapp_accounts DROP CONSTRAINT IF EXISTS whatsapp_transport_config;
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_accounts_transport_check
  CHECK (transport IN ('UNIX_SOCKET','SQLITE_STORE'));
ALTER TABLE whatsapp_accounts ADD CONSTRAINT whatsapp_transport_config CHECK (
  (transport = 'UNIX_SOCKET' AND socket_path IS NOT NULL AND token_file IS NOT NULL)
  OR (transport = 'SQLITE_STORE' AND socket_path IS NOT NULL)
);

-- ───────────────────────────────────────────────────────── import ledger ──
-- One row per import/tail run. Keeps provenance of every batch so a mismatch
-- can be traced without a separate verification framework.
CREATE TABLE IF NOT EXISTS whatsapp_import_runs (
  id            text PRIMARY KEY,
  account_id    text NOT NULL,
  source_path   text NOT NULL,
  source_sha256 text NOT NULL,
  snapshot_at   timestamptz NOT NULL,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  rows_seen     integer NOT NULL DEFAULT 0,
  rows_inserted integer NOT NULL DEFAULT 0,
  rows_skipped  integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'RUNNING'
                CHECK (status IN ('RUNNING','COMPLETED','FAILED')),
  error         text
);

-- ─────────────────────────────────────────────── raw provenance columns ──
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS source_rowid          bigint;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS import_run_id         text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS source_sha256         text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS chat_label            text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS chat_kind             text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS sender_resolved_jid   text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS chat_resolved_jid     text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS identity_state        text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS group_participant_jid text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS quoted_message_id     text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_type            text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_filename        text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_sha256          text;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS media_length          bigint;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS deleted_at            timestamptz;
ALTER TABLE whatsapp_messages ADD COLUMN IF NOT EXISTS raw_payload           jsonb;

-- The baseline key (account_id, message_id) is not sufficient: the bridge can
-- hold the same message id under two chat JIDs. A message is identified by its
-- account, its chat and its id.
DO $$
DECLARE constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
    FROM pg_constraint
   WHERE conrelid = 'whatsapp_messages'::regclass
     AND contype = 'u'
     AND pg_get_constraintdef(oid) LIKE '%(account_id, message_id)%';
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE whatsapp_messages DROP CONSTRAINT %I', constraint_name);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'whatsapp_messages'::regclass
       AND conname = 'whatsapp_messages_source_key'
  ) THEN
    ALTER TABLE whatsapp_messages
      ADD CONSTRAINT whatsapp_messages_source_key
      UNIQUE (account_id, chat_jid, message_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS whatsapp_messages_account_chat
  ON whatsapp_messages (account_id, chat_jid, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_source_sha
  ON whatsapp_messages (account_id, source_sha256);

-- ─────────────────────────────────────────────── shared identity registry ──
-- One place where a WhatsApp JID (PN, LID or group) maps to a business person.
-- Cash, Vessel, HR, Attendance, Payroll and future CRM/AI all resolve identity
-- here instead of re-implementing phone matching.
CREATE TABLE IF NOT EXISTS identity_aliases (
  account_id      text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  jid             text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('PN','LID','GROUP','OTHER')),
  person_ref      text,
  employee_mobile text REFERENCES employees(employee_mobile) ON UPDATE CASCADE,
  confidence      text NOT NULL DEFAULT 'UNRESOLVED'
                  CHECK (confidence IN ('EXACT','VARIANT','UNRESOLVED')),
  evidence_ref    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, jid)
);
CREATE INDEX IF NOT EXISTS identity_aliases_employee
  ON identity_aliases (employee_mobile) WHERE employee_mobile IS NOT NULL;

-- ───────────────────────────────────────── archive / legacy data marker ──
-- A rebuilt installation keeps only new activity as "current". Historical rows
-- ported from an earlier system are marked so lifetime totals and "posted
-- today" figures stay honest without a second epoch column everywhere.
ALTER TABLE cash_instructions ADD COLUMN IF NOT EXISTS legacy boolean NOT NULL DEFAULT false;
ALTER TABLE cash_postings     ADD COLUMN IF NOT EXISTS legacy boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS cash_postings_current
  ON cash_postings (posted_at DESC) WHERE NOT legacy;

-- ─────────────────────────────────────────────────────── sync checkpoints ──
-- Per-account tail state. The bridge store is an append-only rowid stream, so
-- the checkpoint is the highest rowid fully committed.
CREATE TABLE IF NOT EXISTS whatsapp_sync_state (
  account_id      text PRIMARY KEY REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  source_path     text NOT NULL,
  last_rowid      bigint NOT NULL DEFAULT 0,
  last_synced_at  timestamptz,
  last_error      text,
  messages_total  bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
