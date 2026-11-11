-- AL-RIFA'I — 010: durable WA-01 Vessel Draft delivery queue.
--
-- This migration is ADDITIVE and PENDING OWNER APPROVAL. It must NOT be applied
-- to production until the outbound sender, recipient, account, chat scope,
-- template, trigger, retry behaviour and rollback plan are explicitly approved.
--
-- It creates no WhatsApp capability, sends no message and rewrites no legacy
-- Cash or Vessel row. The table is safe to leave empty (and safe to be absent):
-- the application degrades to MANUAL_COPY_ONLY when it does not exist.
--
-- One row per ELIGIBLE, COMPLETE draft version. The id is the stable
-- idempotency key vdd_<sha256(programId + sha256(draft text) + recipientJid)>,
-- computed by lib/vessel-draft-delivery.ts. An unchanged draft can never be
-- enqueued twice; a changed draft (new version) gets a new id.

CREATE TABLE IF NOT EXISTS vessel_draft_deliveries (
  id                text PRIMARY KEY CHECK (id ~ '^vdd_[a-f0-9]{64}$'),
  program_id        text NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
  source_message_id text,
  account_id        text NOT NULL DEFAULT 'wa-01' CHECK (account_id = 'wa-01'),
  recipient_jid     text NOT NULL CHECK (length(btrim(recipient_jid)) BETWEEN 1 AND 120),
  content           text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  content_hash      text NOT NULL CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  state             text NOT NULL DEFAULT 'PREPARED'
                    CHECK (state IN ('PREPARED','QUEUED','SENDING','SENT',
                                     'FAILED','DELIVERY_UNKNOWN','DEAD','CANCELLED')),
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   timestamptz,
  -- Claim lease. A worker restart must never resend a message the bridge may
  -- already have accepted; expired leases become DELIVERY_UNKNOWN (terminal).
  lease_until       timestamptz,
  delivery_ref      text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (program_id, content_hash, recipient_jid)
);

-- Queue claim: only QUEUED and due FAILED rows, oldest first.
CREATE INDEX IF NOT EXISTS vessel_draft_deliveries_queue
  ON vessel_draft_deliveries (state, next_attempt_at, created_at)
  WHERE state IN ('QUEUED','FAILED');

-- Admin-visible per-program status.
CREATE INDEX IF NOT EXISTS vessel_draft_deliveries_program
  ON vessel_draft_deliveries (program_id, created_at DESC);

-- Recovery of leases abandoned by a restarted worker.
CREATE INDEX IF NOT EXISTS vessel_draft_deliveries_lease
  ON vessel_draft_deliveries (lease_until)
  WHERE state = 'SENDING';
