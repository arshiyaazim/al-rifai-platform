-- AL-RIFA'I — Phase 3 Increment 5: Review Queue frontend integration.
--
-- Applied after 006_phase3_review_queue.sql. Every statement is idempotent.
-- This migration is intentionally additive: it does not change business state,
-- does not approve/post/settle anything, and does not widen authorization.
--
-- 1. Review Queue uniqueness
--    The Increment 4 index (domain, coalesce(target_ref,'')) allowed only ONE
--    pending review per program/source. That suppressed unrelated legitimate
--    issues (for example an incomplete order AND a duplicate warning for the
--    same program). The replacement index includes the review category, so
--    distinct categories can coexist while duplicate pending items of the SAME
--    category are still prevented. Existing NULL categories are grouped under
--    '' so legacy rows remain protected by a single pending slot.
--
-- 2. Review item correction metadata
--    Reviewers may correct supported extracted fields without approving,
--    posting or settling. Corrections are recorded in the append-only audit
--    trail; these columns only retain the latest correction metadata.
--
-- 3. Cash submission correction/source metadata
--    Cash review candidates are stored in cash_submissions (not review_items)
--    because submitForReview() rejects the CASH domain by design. The extra
--    columns let the Review Queue show source evidence and category filters
--    without changing the cash submission state machine.

-- ── 1. Review Queue uniqueness by category ────────────────────────────────
DROP INDEX IF EXISTS review_items_one_pending;

CREATE UNIQUE INDEX IF NOT EXISTS review_items_one_pending_category
  ON review_items (domain, coalesce(target_ref, ''), coalesce(category, ''))
  WHERE state = 'PENDING';

CREATE INDEX IF NOT EXISTS review_items_category_state
  ON review_items (category, state);

CREATE INDEX IF NOT EXISTS review_items_domain_state
  ON review_items (domain, state);

-- ── 2. Review item correction metadata ────────────────────────────────────
ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS corrected_by text;

ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz;

ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS retry_count integer NOT NULL DEFAULT 0;

ALTER TABLE review_items
  ADD COLUMN IF NOT EXISTS last_error text;

-- ── 3. Cash submission review metadata ────────────────────────────────────
ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS corrected_by text;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS corrected_at timestamptz;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS source_message_id text;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS source_chat_jid text;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS source_account_id text;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS category text;

CREATE INDEX IF NOT EXISTS cash_submissions_state
  ON cash_submissions (state, created_at DESC);

CREATE INDEX IF NOT EXISTS cash_submissions_source
  ON cash_submissions (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Schema version bump
UPDATE schema_meta SET value = '1.3.3' WHERE key = 'schema_version';
