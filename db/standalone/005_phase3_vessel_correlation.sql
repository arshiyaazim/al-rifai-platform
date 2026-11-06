-- AL-RIFA'I — Phase 3 Increment 3: vessel order multi-message correlation.
--
-- Applied after 004_phase3_router_state.sql. Every statement is idempotent.
-- Tracks contributing source messages for vessel programs created from
-- multiple WhatsApp messages in the same authorized conversation.
--
-- One row per contributing source message. A program may have multiple
-- contributing messages (multi-message correlation). The primary source
-- message is recorded on programs.source_message_id; additional references
-- live here for full provenance.

CREATE TABLE IF NOT EXISTS program_source_messages (
  id             text PRIMARY KEY,
  program_id     text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  account_id     text NOT NULL,
  chat_jid       text NOT NULL,
  message_id     text NOT NULL,
  source_role    text NOT NULL DEFAULT 'contributor'
    CHECK (source_role IN ('primary','contributor')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, account_id, chat_jid, message_id)
);

CREATE INDEX IF NOT EXISTS program_source_messages_program
  ON program_source_messages (program_id);
CREATE INDEX IF NOT EXISTS program_source_messages_source
  ON program_source_messages (account_id, chat_jid, message_id);

-- Schema version bump
UPDATE schema_meta SET value = '1.3.1' WHERE key = 'schema_version';
