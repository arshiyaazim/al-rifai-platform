-- AL-RIFA'I — Migration 013: authorised Escort source roles and confirmation/
-- release provenance (additive, idempotent).
--
-- Applied after 012_whatsapp_message_intelligence.sql.
--
-- This migration does NOT rewrite any existing record. It adds:
--   1. whatsapp_chats.source_role — the explicit business purpose of a
--      conversation. It is independent of `purpose` (which only gates the
--      message classifier) and of `authorized` (capture permission). Order
--      intake, support, release and "other approved" groups must never be
--      treated as interchangeable.
--   2. programs.confirmation_* — the verified Admin confirmation provenance:
--      the confirmation message, the conversation it was sent in, the sending
--      Admin JID, the account and the original WhatsApp event time.
--   3. programs.release_* — the Release-group provenance: the release message,
--      its chat, verified sender, account and event time.
--
-- Existing direct chats already have an explicit `purpose`; the backfill below
-- maps only those operator-configured purposes. Group roles are NOT derived
-- from a display name: they stay NULL until an explicit role is configured
-- (the router also recognises the three approved group JIDs and fails closed
-- for any other group).
--
-- Rollback (disposable/test only, after backing up):
--   ALTER TABLE programs DROP COLUMN IF EXISTS release_timestamp;
--   ALTER TABLE programs DROP COLUMN IF EXISTS release_account_id;
--   ALTER TABLE programs DROP COLUMN IF EXISTS release_sender_jid;
--   ALTER TABLE programs DROP COLUMN IF EXISTS release_chat_jid;
--   ALTER TABLE programs DROP COLUMN IF EXISTS release_message_id;
--   ALTER TABLE programs DROP COLUMN IF EXISTS confirmation_timestamp;
--   ALTER TABLE programs DROP COLUMN IF EXISTS confirmation_account_id;
--   ALTER TABLE programs DROP COLUMN IF EXISTS confirmation_sender_jid;
--   ALTER TABLE programs DROP COLUMN IF EXISTS confirmation_chat_jid;
--   ALTER TABLE whatsapp_chats DROP COLUMN IF EXISTS source_role;
--   DELETE FROM schema_migrations WHERE version='013';
--   UPDATE schema_meta SET value='1.7.0' WHERE key='schema_version';

-- ── explicit conversation business role ─────────────────────────────────────
ALTER TABLE whatsapp_chats
  ADD COLUMN IF NOT EXISTS source_role text
  CHECK (source_role IS NULL OR source_role IN (
    'ORDER_INTAKE',     -- verified direct Escort Client order conversation
    'CASH_ONLY',        -- authorised Cash/Accountant conversation
    'SUPPORT_ONLY',     -- Escort Support / operational group: never an order source
    'RELEASE_ONLY',     -- Escort Release Information group
    'OTHER_APPROVED',   -- approved group with context-only purpose
    'REVIEW_REQUIRED'   -- role explicitly unresolved: block state-changing work
  ));

-- Direct chats: honour the operator-configured purpose. A direct chat whose
-- purpose is BOTH keeps a NULL role until the Owner classifies it; the router
-- will not create an order draft from an unclassified direct chat.
UPDATE whatsapp_chats
   SET source_role = CASE
         WHEN purpose = 'ORDERS' THEN 'ORDER_INTAKE'
         WHEN purpose = 'CASH'   THEN 'CASH_ONLY'
         ELSE NULL
       END
 WHERE chat_jid NOT LIKE '%@g.us'
   AND source_role IS NULL;

CREATE INDEX IF NOT EXISTS whatsapp_chats_source_role
  ON whatsapp_chats (account_id, source_role)
  WHERE source_role IS NOT NULL;

-- ── Admin confirmation provenance ───────────────────────────────────────────
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS confirmation_chat_jid text,
  ADD COLUMN IF NOT EXISTS confirmation_sender_jid text,
  ADD COLUMN IF NOT EXISTS confirmation_account_id text,
  ADD COLUMN IF NOT EXISTS confirmation_timestamp timestamptz;

-- ── Release provenance ──────────────────────────────────────────────────────
ALTER TABLE programs
  ADD COLUMN IF NOT EXISTS release_message_id text,
  ADD COLUMN IF NOT EXISTS release_chat_jid text,
  ADD COLUMN IF NOT EXISTS release_sender_jid text,
  ADD COLUMN IF NOT EXISTS release_account_id text,
  ADD COLUMN IF NOT EXISTS release_timestamp timestamptz;

CREATE INDEX IF NOT EXISTS programs_release_message
  ON programs (release_message_id)
  WHERE release_message_id IS NOT NULL;

UPDATE schema_meta SET value = '1.8.0' WHERE key = 'schema_version';
