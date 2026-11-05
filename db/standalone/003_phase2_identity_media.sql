-- AL-RIFA'I — Phase 2: identity evidence and new-media capture.
--
-- Additive and repeat-safe. Applied after schema.sql (001) and
-- 002_raw_import.sql on a fresh installation, and applied once to an existing
-- installation before the Phase 2 worker starts.
--
-- Nothing here resets data: every statement is CREATE ... IF NOT EXISTS or
-- ALTER ... ADD COLUMN IF NOT EXISTS. The runtime role grants are issued by the
-- installer (fresh installs) or by the operator (existing installs).

-- ─────────────────────────────────────────────── identity evidence ──
-- The bridge gives us JIDs, a chat label and (for WA-01) bridge-resolved
-- PN/LID links. These columns keep that evidence so identity can be reconciled
-- later without inventing a phone number or a name.
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS display_name  text;
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS name_source   text;
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS canonical_jid text;
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS person_key    text;
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS first_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS last_seen_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE identity_aliases ADD COLUMN IF NOT EXISTS metadata      jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS identity_aliases_canonical
  ON identity_aliases (account_id, canonical_jid) WHERE canonical_jid IS NOT NULL;
CREATE INDEX IF NOT EXISTS identity_aliases_person
  ON identity_aliases (account_id, person_key) WHERE person_key IS NOT NULL;

-- ───────────────────────────────────────────────── new-media store ──
-- One row per captured attachment. The bytes live in the persistent media
-- directory; only the relative path, size and checksum are stored here. A row
-- exists only for a message the worker has actually seen in the bridge store.
CREATE TABLE IF NOT EXISTS whatsapp_media (
  account_id   text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  chat_jid     text NOT NULL,
  message_id   text NOT NULL,
  media_type   text NOT NULL,
  mime_type    text,
  filename     text,
  byte_length  bigint NOT NULL CHECK (byte_length >= 0),
  sha256       text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  storage_path text NOT NULL,
  status       text NOT NULL DEFAULT 'STORED'
               CHECK (status IN ('STORED','FAILED','SKIPPED')),
  error        text,
  captured_at  timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_jid, message_id),
  CONSTRAINT whatsapp_media_message_fk
    FOREIGN KEY (account_id, chat_jid, message_id)
    REFERENCES whatsapp_messages (account_id, chat_jid, message_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS whatsapp_media_sha
  ON whatsapp_media (sha256);
CREATE INDEX IF NOT EXISTS whatsapp_media_account_time
  ON whatsapp_media (account_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_media_failed
  ON whatsapp_media (account_id, updated_at DESC) WHERE status = 'FAILED';

-- ──────────────────────────────────────────────────── schema version ──
UPDATE schema_meta SET value = '1.2.0' WHERE key = 'schema_version';
