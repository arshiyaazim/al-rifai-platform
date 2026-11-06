-- AL-RIFA'I — Phase 3: complete Cash lifecycle (additive, idempotent).
--
-- Applied after 007_phase3_review_queue_ui.sql. This migration adds the missing
-- instruction-level completion path that production Cash review needs:
--
--   1. a review candidate can become a REVIEW instruction (never a posting);
--   2. a posted instruction can be reversed with an immutable contra entry;
--   3. an account/period can be reconciled against a counted balance.
--
-- Nothing in this file posts, approves or reconciles a transaction. It only
-- creates storage and constraints; every state change is an explicit,
-- authenticated, audited service action.

-- ── candidate → instruction linkage ────────────────────────────────────────
ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS instruction_id text REFERENCES cash_instructions(id);

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS decided_at timestamptz;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS decided_by text;

ALTER TABLE cash_submissions
  ADD COLUMN IF NOT EXISTS decision_reason text;

CREATE INDEX IF NOT EXISTS cash_submissions_instruction
  ON cash_submissions (instruction_id)
  WHERE instruction_id IS NOT NULL;

-- ── reversal metadata on the instruction ───────────────────────────────────
ALTER TABLE cash_instructions
  ADD COLUMN IF NOT EXISTS reversed_at timestamptz;

ALTER TABLE cash_instructions
  ADD COLUMN IF NOT EXISTS reversed_by text;

ALTER TABLE cash_instructions
  ADD COLUMN IF NOT EXISTS reversal_reason text;

-- ── immutable reversal record ──────────────────────────────────────────────
-- One reversal per posting. The reversal does not edit the posting or the
-- original ledger entry; it writes a separate CREDIT entry so the immutable
-- financial history remains a complete, additive record.
CREATE TABLE IF NOT EXISTS cash_reversals (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  posting_id      text NOT NULL UNIQUE REFERENCES cash_postings(id),
  instruction_id  text NOT NULL REFERENCES cash_instructions(id),
  account_id      text NOT NULL REFERENCES cash_accounts(id),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  reason          text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reversed_by     text NOT NULL,
  reversed_at     timestamptz NOT NULL DEFAULT now(),
  ledger_entry_id bigint NOT NULL REFERENCES ledger_entries(id)
);

CREATE INDEX IF NOT EXISTS cash_reversals_instruction
  ON cash_reversals (instruction_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'cash_reversals_immutable'
       AND tgrelid = 'cash_reversals'::regclass
  ) THEN
    CREATE TRIGGER cash_reversals_immutable BEFORE UPDATE OR DELETE ON cash_reversals
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  END IF;
END $$;

-- ── account reconciliation ─────────────────────────────────────────────────
-- One row per reconciliation attempt. The expected balance is derived from the
-- immutable ledger; the counted balance is supplied by the operator. A non-zero
-- variance is preserved and must be explained before the row can be closed.
-- Closing never creates an automatic adjustment posting.
CREATE TABLE IF NOT EXISTS cash_reconciliations (
  id                      text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  account_id              text NOT NULL REFERENCES cash_accounts(id),
  period_start            date NOT NULL,
  period_end              date NOT NULL,
  opening_balance_minor   bigint NOT NULL,
  movement_minor          bigint NOT NULL,
  expected_balance_minor  bigint NOT NULL,
  counted_balance_minor   bigint NOT NULL,
  variance_minor          bigint NOT NULL,
  state                   text NOT NULL DEFAULT 'OPEN'
                            CHECK (state IN ('OPEN','CLOSED')),
  note                    text CHECK (note IS NULL OR length(note) <= 1000),
  created_by              text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  closed_by               text,
  closed_at               timestamptz,
  CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS cash_reconciliations_account
  ON cash_reconciliations (account_id, period_end DESC, created_at DESC);

-- ── ledger source values for additive financial corrections ────────────────
-- The original baseline allows MANUAL/INSTRUCTION/PAYROLL/IMPORT. Reversal and
-- reconciliation are additive corrections, never mutations of old rows.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ledger_entries'::regclass
       AND conname = 'ledger_entries_source_check'
  ) THEN
    ALTER TABLE ledger_entries DROP CONSTRAINT ledger_entries_source_check;
  END IF;
  ALTER TABLE ledger_entries
    ADD CONSTRAINT ledger_entries_source_check
    CHECK (source IN ('MANUAL','INSTRUCTION','PAYROLL','IMPORT','REVERSAL','RECONCILIATION'));
END $$;

UPDATE schema_meta SET value = '1.4.0' WHERE key = 'schema_version';
