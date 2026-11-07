-- AL-RIFA'I — Migration 011: Business Paid Events (additive, idempotent).
--
-- Applied after 010_vessel_draft_delivery.sql. This migration adds the
-- Business Paid Event model, which is deliberately separate from the
-- Financial POSTED ledger in cash_postings.
--
--   Business Paid  = a verified business payment occurrence.
--   Financial POSTED = an immutable ledger posting (cash_postings/ledger_entries).
--
-- A verified WhatsApp payment creates a Business Paid Event automatically
-- (when PHASE3_PAID_EVENTS_ENABLED=1) but never calls postInstruction() and
-- never writes cash_postings/ledger_entries.
--
-- Design: events are APPEND-ONLY. There is no UPDATE/DELETE. A correction is a
-- new CORRECTION event linked to the original PAYMENT event, and a reversal is
-- a new REVERSAL event. The financial posting link is recorded in a separate
-- append-only table once a privileged postInstruction() actually posts. This
-- keeps "paid" and "posted" independent and auditable.
--
-- Deduplication:
--   WhatsApp payment: unique (source_message_id, source_block_key)
--   Office payment:   unique (source_submission_id)
--   Instruction:      one PAYMENT event per instruction (when linked)
--   Reversal:         one REVERSAL per original event
--   Correction:       one CORRECTION per original event

-- ── Business Paid Events ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cash_payment_events (
  id                  text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,80}$'),
  event_type          text NOT NULL
                        CHECK (event_type IN ('PAYMENT','CORRECTION','REVERSAL')),
  instruction_id      text REFERENCES cash_instructions(id) ON DELETE RESTRICT,
  source_submission_id text REFERENCES cash_submissions(id) ON DELETE RESTRICT,
  employee_mobile     text NOT NULL
                        CHECK (employee_mobile ~ '^\+8801[3-9][0-9]{8}$'),
  payout_mobile       text NOT NULL
                        CHECK (payout_mobile ~ '^\+8801[3-9][0-9]{8}$'),
  employee_name       text NOT NULL
                        CHECK (length(btrim(employee_name)) BETWEEN 1 AND 150),
  -- Snapshot at event creation. No foreign key: a WhatsApp instruction may
  -- name a mobile that has not been registered as an employee yet, and an
  -- event must never be attached to a different employee record.
  employee_link_status text NOT NULL DEFAULT 'UNREGISTERED'
                        CHECK (employee_link_status IN ('REGISTERED','UNREGISTERED')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  method              text NOT NULL
                        CHECK (method IN ('bkash','nagad','rocket','bank','cash')),
  source_category     text NOT NULL CHECK (source_category IN ('WHATSAPP','OFFICE')),
  source_message_id   text,
  source_block_key    text,
  status              text NOT NULL CHECK (status IN ('PAID','CORRECTED','REVERSED')),
  -- Business payment timestamp. Reporting converts it to Asia/Dhaka.
  paid_at             timestamptz NOT NULL,
  reason              text CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  corrects_event_id   text REFERENCES cash_payment_events(id) ON DELETE RESTRICT,
  reverses_event_id   text REFERENCES cash_payment_events(id) ON DELETE RESTRICT,
  created_by          text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),

  -- Event-shape consistency: a base event is PAID; a correction/reversal is a
  -- separate row that always points at the event it corrects/reverses.
  CONSTRAINT cash_payment_events_shape CHECK (
       (event_type = 'PAYMENT' AND status = 'PAID'
        AND corrects_event_id IS NULL AND reverses_event_id IS NULL)
    OR (event_type = 'CORRECTION' AND status = 'CORRECTED'
        AND corrects_event_id IS NOT NULL AND reverses_event_id IS NULL
        AND reason IS NOT NULL)
    OR (event_type = 'REVERSAL' AND status = 'REVERSED'
        AND reverses_event_id IS NOT NULL AND corrects_event_id IS NULL
        AND reason IS NOT NULL)
  ),
  -- A WhatsApp source event must carry both provenance identifiers.
  CONSTRAINT cash_payment_events_whatsapp_source CHECK (
    source_category <> 'WHATSAPP'
    OR (source_message_id IS NOT NULL AND source_block_key IS NOT NULL)
  ),
  -- An Office-originated payment must identify the reviewed submission.
  CONSTRAINT cash_payment_events_office_submission CHECK (
    event_type <> 'PAYMENT'
    OR source_category <> 'OFFICE'
    OR source_submission_id IS NOT NULL
  )
);

-- One WhatsApp payment block can create at most one Business Paid Event.
CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_events_whatsapp_source
  ON cash_payment_events (source_message_id, source_block_key)
  WHERE event_type = 'PAYMENT'
    AND source_category = 'WHATSAPP'
    AND source_message_id IS NOT NULL;

-- One Office submission can create at most one Business Paid Event.
CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_events_office_submission
  ON cash_payment_events (source_submission_id)
  WHERE event_type = 'PAYMENT'
    AND source_category = 'OFFICE'
    AND source_submission_id IS NOT NULL;

-- One PAYMENT event per canonical instruction (WhatsApp automatic path and
-- Office approval path both link their instruction when it exists).
CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_events_instruction_payment
  ON cash_payment_events (instruction_id)
  WHERE event_type = 'PAYMENT' AND instruction_id IS NOT NULL;

-- Exactly one correction and one reversal per original event.
CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_events_one_correction
  ON cash_payment_events (corrects_event_id)
  WHERE event_type = 'CORRECTION' AND corrects_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS cash_payment_events_one_reversal
  ON cash_payment_events (reverses_event_id)
  WHERE event_type = 'REVERSAL' AND reverses_event_id IS NOT NULL;

-- Reporting indexes.
CREATE INDEX IF NOT EXISTS cash_payment_events_instruction
  ON cash_payment_events (instruction_id);
CREATE INDEX IF NOT EXISTS cash_payment_events_employee
  ON cash_payment_events (employee_mobile, paid_at DESC);
CREATE INDEX IF NOT EXISTS cash_payment_events_source
  ON cash_payment_events (source_category, paid_at DESC);
CREATE INDEX IF NOT EXISTS cash_payment_events_status
  ON cash_payment_events (status, paid_at DESC);
CREATE INDEX IF NOT EXISTS cash_payment_events_paid_at
  ON cash_payment_events (paid_at DESC);

-- ── Append-only financial posting link ────────────────────────────────────────
-- Written only by postInstruction() after an actual privileged posting. It is
-- not a lifecycle update on the Business Paid Event.
CREATE TABLE IF NOT EXISTS cash_payment_event_postings (
  payment_event_id text PRIMARY KEY
                     REFERENCES cash_payment_events(id) ON DELETE RESTRICT,
  instruction_id   text NOT NULL
                     REFERENCES cash_instructions(id) ON DELETE RESTRICT,
  posting_id       text NOT NULL UNIQUE
                     REFERENCES cash_postings(id) ON DELETE RESTRICT,
  posted_at        timestamptz NOT NULL DEFAULT now(),
  created_by       text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS cash_payment_event_postings_instruction
  ON cash_payment_event_postings (instruction_id);

-- ── Append-only enforcement ───────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'cash_payment_events_immutable'
       AND tgrelid = 'cash_payment_events'::regclass
  ) THEN
    CREATE TRIGGER cash_payment_events_immutable
      BEFORE UPDATE OR DELETE ON cash_payment_events
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgname = 'cash_payment_event_postings_immutable'
       AND tgrelid = 'cash_payment_event_postings'::regclass
  ) THEN
    CREATE TRIGGER cash_payment_event_postings_immutable
      BEFORE UPDATE OR DELETE ON cash_payment_event_postings
      FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
  END IF;
END $$;

-- ── schema version ────────────────────────────────────────────────────────────
UPDATE schema_meta SET value = '1.6.0' WHERE key = 'schema_version';