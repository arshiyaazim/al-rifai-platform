-- AL-RIFA'I — Migration 015: Cash correction and reversal workflow.
--
-- Posted financial rows are immutable. A correction is a new append-only
-- adjustment row; a reversal marks the original REVERSED and creates a new
-- POSTED replacement. No amount, method or state on a POSTED row is edited
-- directly.
--
-- Rollback (disposable/test only, after backup):
--   DROP TABLE IF EXISTS cash_transaction_adjustments;
--   ALTER TABLE cash_instructions DROP COLUMN IF EXISTS reversal_of;
--   ALTER TABLE cash_instructions DROP CONSTRAINT IF EXISTS cash_instructions_state_check;
--   ALTER TABLE cash_instructions ADD CONSTRAINT cash_instructions_state_check
--     CHECK (state IN ('REVIEW','APPROVED','POSTED','REJECTED','VOID'));
--   DELETE FROM schema_migrations WHERE version='015';
--   UPDATE schema_meta SET value='1.9.0' WHERE key='schema_version';

-- Reversal keeps the original row and marks it REVERSED.
ALTER TABLE cash_instructions DROP CONSTRAINT IF EXISTS cash_instructions_state_check;
ALTER TABLE cash_instructions ADD CONSTRAINT cash_instructions_state_check
  CHECK (state IN ('REVIEW','APPROVED','POSTED','REJECTED','VOID','REVERSED'));

-- The replacement instruction records which posted instruction it reverses.
ALTER TABLE cash_instructions ADD COLUMN IF NOT EXISTS reversal_of text
  REFERENCES cash_instructions(id);

CREATE TABLE IF NOT EXISTS cash_transaction_adjustments (
  id               text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  instruction_id   text NOT NULL REFERENCES cash_instructions(id),
  correction_of    text NOT NULL REFERENCES cash_instructions(id),
  posting_id       text REFERENCES cash_postings(id),
  adjustment_type  text NOT NULL DEFAULT 'CORRECTION'
                     CHECK (adjustment_type IN ('CORRECTION')),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  adjustment_minor bigint NOT NULL CHECK (adjustment_minor <> 0),
  reason           text NOT NULL CHECK (length(btrim(reason)) BETWEEN 10 AND 500),
  state            text NOT NULL DEFAULT 'CORRECTION'
                     CHECK (state IN ('CORRECTION')),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cash_transaction_adjustments_instruction
  ON cash_transaction_adjustments (instruction_id, created_at DESC);
CREATE INDEX IF NOT EXISTS cash_transaction_adjustments_correction
  ON cash_transaction_adjustments (correction_of, created_at DESC);

DROP TRIGGER IF EXISTS cash_transaction_adjustments_immutable ON cash_transaction_adjustments;
CREATE TRIGGER cash_transaction_adjustments_immutable
  BEFORE UPDATE OR DELETE ON cash_transaction_adjustments
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

UPDATE schema_meta SET value = '1.10.0' WHERE key = 'schema_version';
