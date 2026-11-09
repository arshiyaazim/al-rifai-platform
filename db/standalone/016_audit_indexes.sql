-- AL-RIFA'I — Migration 016: Audit Trail viewer indexes.
--
-- Additive and idempotent. No table or column changes; only indexes used by the
-- admin /audit page and its domain/action filters.
--
-- Rollback (disposable/test only):
--   DROP INDEX IF EXISTS audit_events_at;
--   DROP INDEX IF EXISTS audit_events_action_at;
--   DROP INDEX IF EXISTS program_events_created_at;
--   DELETE FROM schema_migrations WHERE version='016';
--   UPDATE schema_meta SET value='1.10.0' WHERE key='schema_version';

CREATE INDEX IF NOT EXISTS audit_events_at
  ON audit_events (at DESC);

CREATE INDEX IF NOT EXISTS audit_events_action_at
  ON audit_events (action, at DESC);

-- audit_events_entity (entity, entity_id, at DESC) already exists in the
-- baseline schema and continues to serve target-detail queries.

CREATE INDEX IF NOT EXISTS program_events_created_at
  ON program_events (created_at DESC);

UPDATE schema_meta SET value = '1.11.0' WHERE key = 'schema_version';
