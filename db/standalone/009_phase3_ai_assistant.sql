-- AL-RIFA'I — Phase 3 AI communication foundation (additive, idempotent).
--
-- WA-02 AI is a separate channel from the WA-01 Cash/Vessel router. These tables
-- store conversation state, applicant drafts, scoped tool runs, outbound drafts
-- and escalations. No table grants the AI direct SQL or an unrestricted sender.
--
-- Nothing here activates WA-02 AI. Activation requires:
--   app_settings.ai_wa02_enabled = true
--   app_settings.ai_wa02_start_rowid = <explicit non-negative integer>
--   AI_WA02_ENABLED=1 for the optional worker
-- and a separately approved outbound bridge adapter (AI_OUTBOUND_ENABLED=1).
-- Outbound sending is not implemented in this migration.

CREATE TABLE IF NOT EXISTS ai_contacts (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  account_id      text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid        text NOT NULL,
  person_ref      text,
  category        text NOT NULL DEFAULT 'UNKNOWN'
                    CHECK (category IN ('VERIFIED_ADMIN','VERIFIED_EMPLOYEE','JOB_APPLICANT','EXISTING_CUSTOMER','ESCORT_CLIENT','UNKNOWN_CONTACT','UNAUTHORIZED')),
  employee_mobile text,
  active          boolean NOT NULL DEFAULT true,
  verified_by     text,
  verified_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, chat_jid)
);

CREATE TABLE IF NOT EXISTS ai_admin_jids (
  id          text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  account_id  text NOT NULL CHECK (account_id = 'wa-02'),
  jid         text NOT NULL,
  label       text,
  active      boolean NOT NULL DEFAULT true,
  verified_by text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, jid)
);

CREATE TABLE IF NOT EXISTS ai_conversations (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  account_id      text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid        text NOT NULL,
  contact_jid     text,
  category        text NOT NULL DEFAULT 'UNKNOWN_CONTACT',
  employee_mobile text,
  state           text NOT NULL DEFAULT 'OPEN' CHECK (state IN ('OPEN','ESCALATED','CLOSED')),
  summary         text CHECK (summary IS NULL OR length(summary) <= 4000),
  last_intent     text,
  last_message_at timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, chat_jid)
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id                text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id   text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  account_id        text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid          text NOT NULL,
  source_message_id text,
  direction         text NOT NULL CHECK (direction IN ('INCOMING','OUTGOING')),
  sender_jid        text,
  content           text,
  role              text NOT NULL CHECK (role IN ('CONTACT','ASSISTANT','SYSTEM')),
  intent            text,
  classification    text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, source_message_id)
);

CREATE TABLE IF NOT EXISTS ai_applicant_drafts (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  account_id      text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid        text NOT NULL,
  full_name       text,
  phone           text,
  job_category    text,
  status          text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','SUBMITTED','REVIEW','APPROVED','REJECTED')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_hash     text NOT NULL UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_job_catalog (
  key                text PRIMARY KEY,
  label_bn           text NOT NULL,
  label_en           text NOT NULL,
  public_description text NOT NULL,
  active             boolean NOT NULL DEFAULT true,
  display_order      integer NOT NULL DEFAULT 0,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_outbound_messages (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id text REFERENCES ai_conversations(id) ON DELETE SET NULL,
  account_id      text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid        text NOT NULL,
  recipient_jid   text NOT NULL,
  content         text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  state           text NOT NULL DEFAULT 'DRAFT'
                    CHECK (state IN ('DRAFT','PREVIEW','APPROVED','QUEUED','SENT','FAILED','CANCELLED')),
  source_ref      text,
  approval_by     text,
  approved_at     timestamptz,
  queued_at       timestamptz,
  sent_at         timestamptz,
  delivery_state  text,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_tool_runs (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id text REFERENCES ai_conversations(id) ON DELETE SET NULL,
  actor_ref       text,
  account_id      text,
  tool            text NOT NULL,
  allowed         boolean NOT NULL,
  input           jsonb NOT NULL DEFAULT '{}'::jsonb,
  output          jsonb NOT NULL DEFAULT '{}'::jsonb,
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_escalations (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id text REFERENCES ai_conversations(id) ON DELETE SET NULL,
  reason          text NOT NULL,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ACKNOWLEDGED','CLOSED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz
);

CREATE TABLE IF NOT EXISTS ai_order_drafts (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,100}$'),
  conversation_id text NOT NULL REFERENCES ai_conversations(id) ON DELETE CASCADE,
  account_id      text NOT NULL CHECK (account_id = 'wa-02'),
  chat_jid        text NOT NULL,
  mother_vessel   text,
  lighter_vessel  text,
  master_mobile   text,
  destination     text,
  start_date      date,
  start_shift     text CHECK (start_shift IS NULL OR start_shift IN ('D','N')),
  status          text NOT NULL DEFAULT 'DRAFT'
                    CHECK (status IN ('DRAFT','REVIEW','APPROVED','REJECTED')),
  payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_hash     text NOT NULL UNIQUE,
  source_message_id text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_conversations_account_time ON ai_conversations (account_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS ai_applicant_status ON ai_applicant_drafts (status, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_outbound_state ON ai_outbound_messages (state, created_at DESC);
CREATE INDEX IF NOT EXISTS ai_tool_runs_conversation ON ai_tool_runs (conversation_id, created_at DESC);

INSERT INTO ai_job_catalog (key, label_bn, label_en, public_description, active, display_order)
VALUES
  ('security_guard', 'সিকিউরিটি গার্ড', 'Security Guard', 'Security Guard role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 10),
  ('security_supervisor', 'সিকিউরিটি সুপারভাইজার', 'Security Supervisor', 'Security Supervisor role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 20),
  ('vessel_escort', 'ভেসেল এস্কর্ট', 'Vessel Escort', 'Vessel Escort role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 30),
  ('survey_escort', 'সার্ভে এস্কর্ট', 'Survey Escort', 'Survey Escort role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 40),
  ('operations_officer', 'অপারেশনস অফিসার', 'Operations Officer', 'Operations Officer role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 50),
  ('marketing_officer', 'মার্কেটিং অফিসার', 'Marketing Officer', 'Marketing Officer role category. Current vacancy, duty terms, salary and joining date must be confirmed by the office.', true, 60),
  ('other', 'অন্যান্য', 'Other', 'Other role category. The office must confirm the applicable position and terms.', true, 90)
ON CONFLICT (key) DO NOTHING;

UPDATE schema_meta SET value = '1.5.0' WHERE key = 'schema_version';
