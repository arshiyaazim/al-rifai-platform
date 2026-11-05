-- AL-RIFA'I — standalone baseline schema (fresh install)
--
-- This is the ONLY schema a new installation applies. It is not the historical
-- 75-migration chain and it contains no WhatsApp/transport tables beyond the
-- message-staging tables the optional adapter needs.
--
-- It is an independent, reusable business application schema: no organization
-- identifiers, no fixed WhatsApp account, no fixed contacts, no built-in
-- financial freeze. Financial operations are normal, permission-controlled and
-- fully audited.
--
-- Run through scripts/standalone/install.mjs (which sets search_path, applies
-- this file inside one transaction, then grants runtime privileges).
-- All identifiers are unqualified so the same file works in a dedicated
-- database (schema public) or in a shared database (dedicated schema).

-- ─────────────────────────────────────────────────────────────── helpers ──
CREATE FUNCTION touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'IMMUTABLE_%', TG_TABLE_NAME;
END $$;

-- +8801XXXXXXXXX or NULL. Never invents digits: 13-digit local and 880-prefixed
-- international forms only.
CREATE FUNCTION normalize_mobile(value text) RETURNS text LANGUAGE plpgsql
IMMUTABLE AS $$
DECLARE digits text;
BEGIN
  IF value IS NULL THEN RETURN NULL; END IF;
  digits := regexp_replace(value, '[^0-9]', '', 'g');
  IF digits ~ '^01[3-9][0-9]{8}$' THEN RETURN '+88' || digits; END IF;
  IF digits ~ '^8801[3-9][0-9]{8}$' THEN RETURN '+' || digits; END IF;
  RETURN NULL;
END $$;

CREATE TABLE schema_meta (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Key/value configuration for a specific installation: organization profile,
-- WhatsApp account identifiers, authorized chats, payroll defaults, etc.
-- Nothing organization-specific is compiled into the application.
CREATE TABLE app_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER app_settings_touch BEFORE UPDATE ON app_settings
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ──────────────────────────────────────────────────────────── accounts ──
CREATE TABLE cash_portal_users (
  id                   text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  username             text NOT NULL CHECK (length(username) BETWEEN 1 AND 80),
  password_hash        text NOT NULL CHECK (length(password_hash) BETWEEN 80 AND 200),
  role                 text NOT NULL CHECK (role IN ('ADMIN','USER')),
  display_name         text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 150),
  email                text CHECK (email IS NULL OR length(email) <= 320),
  mobile               text CHECK (mobile IS NULL OR length(mobile) <= 50),
  whatsapp_number      text CHECK (whatsapp_number IS NULL OR length(whatsapp_number) <= 50),
  must_change_password boolean NOT NULL DEFAULT true,
  active               boolean NOT NULL DEFAULT true,
  version              integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by           text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz,
  password_changed_at  timestamptz,
  capabilities         jsonb NOT NULL DEFAULT '[]'::jsonb,
  username_changed_at  timestamptz
);
CREATE UNIQUE INDEX cash_portal_users_username_ci ON cash_portal_users (lower(username));

CREATE TABLE cash_portal_sessions (
  id           text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  user_id      text NOT NULL REFERENCES cash_portal_users(id) ON DELETE CASCADE,
  csrf_hash    text NOT NULL CHECK (csrf_hash ~ '^[a-f0-9]{64}$'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  user_agent   text,
  client_ip    text
);
CREATE INDEX cash_portal_sessions_user ON cash_portal_sessions (user_id, last_seen_at DESC);
CREATE INDEX cash_portal_sessions_expiry ON cash_portal_sessions (expires_at);

CREATE TABLE cash_portal_audit (
  id         text PRIMARY KEY CHECK (id ~ '^[a-f0-9]{64}$'),
  actor_id   text,
  target_id  text,
  action     text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_.:-]{1,80}$'),
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_portal_audit_created ON cash_portal_audit (created_at DESC, id);

CREATE TABLE login_throttle_state (
  key               text PRIMARY KEY,
  failures          integer NOT NULL DEFAULT 0 CHECK (failures BETWEEN 0 AND 10000),
  window_started_at timestamptz NOT NULL DEFAULT now(),
  delay_until       timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────── employees ──
CREATE TABLE employees (
  employee_mobile text PRIMARY KEY CHECK (employee_mobile ~ '^\+8801[3-9][0-9]{8}$'),
  preferred_name  text NOT NULL CHECK (length(btrim(preferred_name)) BETWEEN 1 AND 150),
  name_aliases    text[] NOT NULL DEFAULT '{}',
  duty_type       text CHECK (duty_type IS NULL OR duty_type IN ('escort','crew','office','other')),
  designation     text CHECK (designation IS NULL OR length(designation) BETWEEN 1 AND 80),
  state           text NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE','INACTIVE','SUSPENDED')),
  joined_on       date,
  notes           text CHECK (notes IS NULL OR length(notes) <= 2000),
  revision        integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX employees_name ON employees (lower(preferred_name));
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ───────────────────────────────────────────────────────────── programs ──
-- One row per Lighter. Same mother + different lighters are separate programs.
CREATE TABLE programs (
  id                       text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,120}$'),
  revision                 integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  mother_vessel            text NOT NULL CHECK (length(btrim(mother_vessel)) BETWEEN 1 AND 120),
  lighter_vessel           text NOT NULL CHECK (length(btrim(lighter_vessel)) BETWEEN 1 AND 120),
  master_mobile            text CHECK (master_mobile ~ '^01[3-9][0-9]{8}$'),
  destination              text CHECK (destination IS NULL OR length(destination) <= 160),
  escort_name              text CHECK (escort_name IS NULL OR length(escort_name) <= 150),
  escort_mobile            text REFERENCES employees(employee_mobile) ON UPDATE CASCADE,
  start_date               date NOT NULL,
  start_shift              char(1) NOT NULL CHECK (start_shift IN ('D','N')),
  end_date                 date,
  end_shift                char(1) CHECK (end_shift IN ('D','N')),
  state                    text NOT NULL DEFAULT 'DRAFT'
                             CHECK (state IN ('DRAFT','CONFIRMED','ASSIGNED','IN_DUTY','RELEASED','COMPLETED','VOIDED')),
  source_channel           text NOT NULL DEFAULT 'WEB' CHECK (source_channel IN ('WEB','WHATSAPP','IMPORT')),
  source_message_id        text,
  source_chat_jid          text,
  confirmation_message_id  text,
  notes                    text CHECK (notes IS NULL OR length(notes) <= 2000),
  created_by               text NOT NULL DEFAULT 'system',
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT program_end_pair CHECK ((end_date IS NULL) = (end_shift IS NULL)),
  CONSTRAINT program_end_after_start CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT program_whatsapp_confirmation CHECK (
    confirmation_message_id IS NULL OR source_message_id IS NOT NULL
  )
);
CREATE INDEX programs_state ON programs (state);
CREATE INDEX programs_escort ON programs (escort_mobile);
CREATE INDEX programs_start ON programs (start_date DESC);
-- Exact duplicate identity only; the ±1-day rule is evaluated by the service
-- (it needs a warning, not a hard constraint).
CREATE UNIQUE INDEX programs_exact_identity
  ON programs (lower(btrim(mother_vessel)), lower(btrim(lighter_vessel)), start_date)
  WHERE state <> 'VOIDED';
CREATE TRIGGER programs_touch BEFORE UPDATE ON programs
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE program_assignments (
  id              text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,160}$'),
  program_id      text NOT NULL REFERENCES programs(id) ON DELETE RESTRICT,
  revision        integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  employee_mobile text NOT NULL REFERENCES employees(employee_mobile) ON UPDATE CASCADE,
  start_date      date NOT NULL,
  start_shift     char(1) NOT NULL CHECK (start_shift IN ('D','N')),
  end_date        date,
  end_shift       char(1) CHECK (end_shift IN ('D','N')),
  predecessor_id  text REFERENCES program_assignments(id),
  source          text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB','WHATSAPP','IMPORT')),
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX program_assignments_program ON program_assignments (program_id, created_at DESC);
CREATE INDEX program_assignments_employee ON program_assignments (employee_mobile, start_date DESC);
-- One open assignment per program.
CREATE UNIQUE INDEX program_assignments_open
  ON program_assignments (program_id) WHERE end_date IS NULL;

-- Append-only command ledger. `command_key` makes every write idempotent.
CREATE TABLE program_events (
  id          bigserial PRIMARY KEY,
  program_id  text NOT NULL,
  action      text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_]{2,40}$'),
  command_key text UNIQUE,
  actor       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX program_events_program ON program_events (program_id, created_at DESC);
CREATE TRIGGER program_events_immutable BEFORE UPDATE OR DELETE ON program_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ──────────────────────────────────────────────────────────── attendance ──
CREATE TABLE attendance (
  id              text PRIMARY KEY,
  employee_mobile text NOT NULL REFERENCES employees(employee_mobile) ON UPDATE CASCADE,
  duty_date       date NOT NULL,
  shift           char(1) NOT NULL CHECK (shift IN ('D','N')),
  state           text NOT NULL DEFAULT 'PRESENT' CHECK (state IN ('PRESENT','ABSENT','LEAVE')),
  hours           numeric(4,1) CHECK (hours IS NULL OR (hours >= 0 AND hours <= 24)),
  source          text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB','WHATSAPP','IMPORT')),
  recorded_by     text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_mobile, duty_date, shift)
);
CREATE INDEX attendance_date ON attendance (duty_date DESC);

-- ─────────────────────────────────────────────────────────────── payroll ──
-- Rate rows are installation data, never compiled policy. An empty table means
-- pay stays UNRESOLVED until an administrator configures the schedule.
CREATE TABLE rate_config (
  destination_key   text PRIMARY KEY,
  destination_label text NOT NULL,
  shift_rate_minor  bigint NOT NULL CHECK (shift_rate_minor > 0),
  conveyance_minor  bigint NOT NULL DEFAULT 0 CHECK (conveyance_minor >= 0),
  effective_from    date NOT NULL DEFAULT DATE '2025-01-01',
  active            boolean NOT NULL DEFAULT true,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE program_pay (
  program_id       text PRIMARY KEY REFERENCES programs(id) ON DELETE CASCADE,
  shifts           integer,
  salary_minor     bigint,
  conveyance_minor bigint,
  total_minor      bigint,
  state            text NOT NULL CHECK (state IN ('CALCULATED','UNRESOLVED')),
  reasons          jsonb NOT NULL DEFAULT '[]',
  computed_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'CALCULATED') = (total_minor IS NOT NULL))
);

-- Derived pay, never a posting: shifts x configured rate + destination conveyance.
CREATE FUNCTION compute_program_pay(p_program_id text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  p record; v_shifts integer; v_rate bigint; v_conv bigint; v_key text;
BEGIN
  SELECT * INTO p FROM programs WHERE id = p_program_id;
  IF NOT FOUND THEN RETURN; END IF;
  IF p.end_date IS NULL THEN
    INSERT INTO program_pay (program_id, state, reasons)
    VALUES (p_program_id, 'UNRESOLVED', '["END_DATE_REQUIRED"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = NULL, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["END_DATE_REQUIRED"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  v_shifts := (p.end_date - p.start_date) * 2
              + (CASE WHEN p.end_shift = 'N' THEN 1 ELSE 0 END)
              - (CASE WHEN p.start_shift = 'N' THEN 1 ELSE 0 END) + 1;
  IF v_shifts < 1 THEN
    INSERT INTO program_pay (program_id, state, reasons)
    VALUES (p_program_id, 'UNRESOLVED', '["INVALID_DATE_RANGE"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = NULL, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["INVALID_DATE_RANGE"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  v_key := coalesce(nullif(lower(btrim(p.destination)), ''), 'default');
  SELECT shift_rate_minor, conveyance_minor INTO v_rate, v_conv
    FROM rate_config
   WHERE destination_key = v_key AND active AND effective_from <= p.start_date
   ORDER BY effective_from DESC LIMIT 1;
  IF v_rate IS NULL THEN
    SELECT shift_rate_minor, conveyance_minor INTO v_rate, v_conv
      FROM rate_config
     WHERE destination_key = 'default' AND active AND effective_from <= p.start_date
     ORDER BY effective_from DESC LIMIT 1;
  END IF;
  IF v_rate IS NULL THEN
    INSERT INTO program_pay (program_id, shifts, state, reasons)
    VALUES (p_program_id, v_shifts, 'UNRESOLVED', '["NO_RATE_CONFIGURED"]'::jsonb)
    ON CONFLICT (program_id) DO UPDATE
      SET shifts = EXCLUDED.shifts, salary_minor = NULL, conveyance_minor = NULL,
          total_minor = NULL, state = 'UNRESOLVED',
          reasons = '["NO_RATE_CONFIGURED"]'::jsonb, computed_at = now();
    RETURN;
  END IF;
  INSERT INTO program_pay (program_id, shifts, salary_minor, conveyance_minor, total_minor, state, reasons, computed_at)
  VALUES (p_program_id, v_shifts, v_shifts * v_rate, coalesce(v_conv, 0), v_shifts * v_rate + coalesce(v_conv, 0), 'CALCULATED', '[]'::jsonb, now())
  ON CONFLICT (program_id) DO UPDATE
    SET shifts = EXCLUDED.shifts, salary_minor = EXCLUDED.salary_minor,
        conveyance_minor = EXCLUDED.conveyance_minor, total_minor = EXCLUDED.total_minor,
        state = 'CALCULATED', reasons = '[]'::jsonb, computed_at = now();
END $$;

CREATE FUNCTION programs_pay_sync() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM compute_program_pay(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER programs_pay_after_insert AFTER INSERT ON programs
  FOR EACH ROW EXECUTE FUNCTION programs_pay_sync();
CREATE TRIGGER programs_pay_after_update AFTER UPDATE OF start_date, start_shift, end_date, end_shift, destination, state
  ON programs FOR EACH ROW EXECUTE FUNCTION programs_pay_sync();

-- ──────────────────────────────────────────────── finance: accounts/ledger ──
-- Normal financial operations are supported. Money movement is recorded through
-- an explicit, double-checked posting step (instruction -> approval -> posting)
-- and every posting writes an immutable ledger entry.
CREATE TABLE cash_accounts (
  id                    text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,60}$'),
  code                  text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_]{2,20}$'),
  name                  text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  type                  text NOT NULL CHECK (type IN ('CASH','BANK','MOBILE','OTHER')),
  currency              char(3) NOT NULL DEFAULT 'BDT' CHECK (currency ~ '^[A-Z]{3}$'),
  opening_balance_minor bigint NOT NULL DEFAULT 0,
  active                boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cash_accounts_touch BEFORE UPDATE ON cash_accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Payment instruction to an employee/escort.
-- REVIEW -> APPROVED -> POSTED, or REJECTED / VOID. Posting is the only step
-- that touches an account balance, and it is a separate, permissioned action.
CREATE TABLE cash_instructions (
  id              text PRIMARY KEY,
  employee_mobile text CHECK (employee_mobile IS NULL OR employee_mobile ~ '^\+8801[3-9][0-9]{8}$'),
  employee_name   text NOT NULL CHECK (length(btrim(employee_name)) BETWEEN 1 AND 150),
  payout_mobile   text CHECK (payout_mobile IS NULL OR payout_mobile ~ '^\+8801[3-9][0-9]{8}$'),
  method          text NOT NULL CHECK (method IN ('bkash','nagad','rocket','bank','cash')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),
  purpose         text CHECK (purpose IS NULL OR length(purpose) <= 500),
  account_id      text REFERENCES cash_accounts(id),
  state           text NOT NULL DEFAULT 'REVIEW'
                    CHECK (state IN ('REVIEW','APPROVED','POSTED','REJECTED','VOID')),
  source_channel  text NOT NULL DEFAULT 'WEB' CHECK (source_channel IN ('WEB','WHATSAPP','IMPORT')),
  source_message_id text,
  source_block_key  text,
  source_hash       text,
  approved_at     timestamptz,
  approved_by     text,
  posted_at       timestamptz,
  posted_by       text,
  rejected_at     timestamptz,
  rejected_by     text,
  reject_reason   text,
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT instruction_post_needs_account CHECK (state <> 'POSTED' OR (account_id IS NOT NULL AND posted_at IS NOT NULL))
);
CREATE INDEX cash_instructions_state ON cash_instructions (state, created_at DESC);
CREATE INDEX cash_instructions_employee ON cash_instructions (employee_mobile, created_at DESC);
-- Source-message + logical block identity is the only deduplication key.
CREATE UNIQUE INDEX cash_instructions_source_identity
  ON cash_instructions (source_message_id, source_block_key)
  WHERE source_message_id IS NOT NULL;
CREATE TRIGGER cash_instructions_touch BEFORE UPDATE ON cash_instructions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Immutable posting record: one per instruction, written with the ledger entry.
CREATE TABLE cash_postings (
  id             text PRIMARY KEY,
  instruction_id text NOT NULL UNIQUE REFERENCES cash_instructions(id),
  account_id     text NOT NULL REFERENCES cash_accounts(id),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  method         text NOT NULL,
  posted_at      timestamptz NOT NULL DEFAULT now(),
  posted_by      text NOT NULL,
  ledger_entry_id bigint
);
CREATE TRIGGER cash_postings_immutable BEFORE UPDATE OR DELETE ON cash_postings
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- Single-entry ledger with signed impact. Credit increases an account balance,
-- Debit decreases it. Balance = opening + credits - debits.
CREATE TABLE ledger_entries (
  id             bigserial PRIMARY KEY,
  account_id     text NOT NULL REFERENCES cash_accounts(id),
  entry_date     date NOT NULL,
  direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  category       text NOT NULL CHECK (length(btrim(category)) BETWEEN 1 AND 60),
  description    text CHECK (description IS NULL OR length(description) <= 500),
  source         text NOT NULL DEFAULT 'MANUAL'
                   CHECK (source IN ('MANUAL','INSTRUCTION','PAYROLL','IMPORT')),
  instruction_id text,
  created_by     text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ledger_entries_account ON ledger_entries (account_id, entry_date DESC, id DESC);
CREATE INDEX ledger_entries_date ON ledger_entries (entry_date DESC);
CREATE TRIGGER ledger_entries_immutable BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

CREATE TABLE cash_submissions (
  id           text PRIMARY KEY,
  payload      jsonb NOT NULL,
  payload_hash text NOT NULL UNIQUE,
  submitted_by text NOT NULL,
  state        text NOT NULL DEFAULT 'PENDING_REVIEW'
                 CHECK (state IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE cash_submission_reviews (
  id            text PRIMARY KEY,
  submission_id text NOT NULL UNIQUE REFERENCES cash_submissions(id),
  decision      text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason        text,
  reviewer      text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER cash_submission_reviews_immutable BEFORE UPDATE OR DELETE ON cash_submission_reviews
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─────────────────────────────────────────────────────────────── review ──
CREATE TABLE review_items (
  id           text PRIMARY KEY,
  domain       text NOT NULL CHECK (domain IN ('EMPLOYEE','PROGRAM','ATTENDANCE','CASH')),
  action       text NOT NULL CHECK (action IN ('CREATE','UPDATE','DELETE')),
  target_ref   text,
  payload      jsonb NOT NULL,
  submitted_by text NOT NULL,
  state        text NOT NULL DEFAULT 'PENDING'
                 CHECK (state IN ('PENDING','APPROVED','REJECTED','WITHDRAWN')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  decided_at   timestamptz
);
CREATE UNIQUE INDEX review_items_one_pending
  ON review_items (domain, coalesce(target_ref, '')) WHERE state = 'PENDING';

CREATE TABLE review_decisions (
  id         text PRIMARY KEY,
  item_id    text NOT NULL UNIQUE REFERENCES review_items(id),
  decision   text NOT NULL CHECK (decision IN ('APPROVED','REJECTED')),
  reason     text,
  actor      text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER review_decisions_immutable BEFORE UPDATE OR DELETE ON review_decisions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ──────────────────────────────────────────────────────────────── audit ──
CREATE TABLE audit_events (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,
  actor_role text,
  action     text NOT NULL CHECK (action ~ '^[A-Z][A-Z0-9_.:-]{1,80}$'),
  entity     text NOT NULL,
  entity_id  text,
  detail     jsonb NOT NULL DEFAULT '{}',
  source     text NOT NULL DEFAULT 'WEB' CHECK (source IN ('WEB','WHATSAPP','SYSTEM')),
  source_ref text
);
CREATE INDEX audit_events_entity ON audit_events (entity, entity_id, at DESC);
CREATE TRIGGER audit_events_immutable BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ─────────────────────────────────────────────────────── whatsapp config ──
-- One row per installation-configured WhatsApp account. Nothing is hard-coded:
-- an administrator registers the account id, its bridge endpoint, the reader
-- token file and the authorized chats.
CREATE TABLE whatsapp_accounts (
  id            text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,60}$'),
  label         text NOT NULL CHECK (length(btrim(label)) BETWEEN 1 AND 120),
  enabled       boolean NOT NULL DEFAULT false,
  transport     text NOT NULL DEFAULT 'UNIX_SOCKET' CHECK (transport IN ('UNIX_SOCKET')),
  socket_path   text,
  token_file    text,
  account_jid   text,
  admin_jids    jsonb NOT NULL DEFAULT '[]',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT whatsapp_transport_config CHECK (
    transport <> 'UNIX_SOCKET' OR (socket_path IS NOT NULL AND token_file IS NOT NULL)
  )
);
CREATE TRIGGER whatsapp_accounts_touch BEFORE UPDATE ON whatsapp_accounts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE TABLE whatsapp_chats (
  account_id  text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  chat_jid    text NOT NULL,
  label       text,
  purpose     text NOT NULL DEFAULT 'BOTH' CHECK (purpose IN ('ORDERS','CASH','BOTH')),
  authorized  boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_jid)
);

-- Transport-neutral staging. The adapter writes here; domain processing reads
-- and promotes messages. No session or credential material is stored.
CREATE TABLE whatsapp_messages (
  id               bigserial PRIMARY KEY,
  account_id       text NOT NULL,
  chat_jid         text NOT NULL,
  message_id       text NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('INCOMING','OUTGOING')),
  sender_jid       text,
  source_timestamp timestamptz NOT NULL,
  text_content     text CHECK (text_content IS NULL OR length(text_content) <= 64000),
  content_hash     text NOT NULL,
  classification   text,
  processed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, message_id)
);
CREATE INDEX whatsapp_messages_unprocessed ON whatsapp_messages (processed_at, id) WHERE processed_at IS NULL;

CREATE TABLE whatsapp_cursors (
  account_id  text NOT NULL,
  chat_jid    text NOT NULL,
  cursor      text,
  last_error  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_jid)
);

-- ──────────────────────────────────────────────────────────────── seed ────
INSERT INTO schema_meta (key, value) VALUES ('schema_version', '1.1.0');
INSERT INTO cash_accounts (id, code, name, type, opening_balance_minor)
VALUES ('acc-cash', 'CASH', 'Main Cash', 'CASH', 0);
