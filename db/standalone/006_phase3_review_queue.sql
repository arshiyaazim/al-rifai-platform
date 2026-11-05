-- AL-RIFA'I — Phase 3 Increment 4: Review Queue & group participant authorization.
--
-- Applied after 005_phase3_vessel_correlation.sql. Every statement is idempotent.
--
-- 1. escort_client_group_authorizations: approved group participants for vessel
--    order intake. Referenced by lib/whatsapp-archive.ts but not defined in any
--    migration. Created here additively.
--
-- 2. review_items.category: review category for efficient querying and
--    deduplication by category. Existing payload JSONB still holds full detail.

-- ── Group participant authorization ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS escort_client_group_authorizations (
  id                 text PRIMARY KEY,
  account_id         text NOT NULL,
  group_jid          text NOT NULL,
  participant_jid    text NOT NULL,
  client_contact_id  text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS escort_client_group_authorizations_active
  ON escort_client_group_authorizations (account_id, group_jid, participant_jid)
  WHERE active = true;

-- ── Review Queue category column ───────────────────────────────────────────
ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS category text
    CHECK (category IN (
      'UNKNOWN_IDENTITY',
      'AMBIGUOUS_DOMAIN',
      'INCOMPLETE_CASH_INSTRUCTION',
      'CASH_DUPLICATE_CANDIDATE',
      'INCOMPLETE_VESSEL_ORDER',
      'VESSEL_DUPLICATE_CANDIDATE',
      'AMBIGUOUS_VESSEL_CONFIRMATION',
      'UNMATCHED_VESSEL_ASSIGNMENT',
      'EXTRACTION_FAILED',
      'PROCESSING_ERROR'
    ));

CREATE INDEX IF NOT EXISTS review_items_category_pending
  ON review_items (category, state)
  WHERE state = 'PENDING';

-- Schema version bump
UPDATE schema_meta SET value = '1.3.2' WHERE key = 'schema_version';
