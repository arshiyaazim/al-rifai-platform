-- AL-RIFA'I — Migration 012: WhatsApp message intelligence, contact evidence
-- and call trace (additive, idempotent).
--
-- This migration does not rewrite historical message content. It adds:
--   1. whatsapp_messages.mirrored_at — the synchronization time, kept separate
--      from the original WhatsApp event time (source_timestamp) and the first
--      ingestion time (created_at).
--   2. whatsapp_calls — actual call events persisted by the WA-01/WA-02 bridge
--      SQLite `calls` table. Calls are not ordinary messages and have no
--      message_id; the Message table shows NOT_AVAILABLE for per-message call
--      trace and the Calls panel shows the actual events for a conversation.
--   3. whatsapp_message_intelligence — authorized review/correction of identity
--      role and business domain, with previous values and reviewer provenance.
--      It is metadata about an existing message, not a second message table.
--
-- Rollback (disposable/test only, after backing up):
--   DROP TABLE IF EXISTS whatsapp_message_intelligence;
--   DROP TABLE IF EXISTS whatsapp_calls;
--   ALTER TABLE whatsapp_messages DROP COLUMN IF EXISTS mirrored_at;
--   DELETE FROM schema_migrations WHERE version='012';
--   UPDATE schema_meta SET value='1.6.0' WHERE key='schema_version';

-- ── mirror time (separate from event and ingestion time) ─────────────────────
ALTER TABLE whatsapp_messages
  ADD COLUMN IF NOT EXISTS mirrored_at timestamptz;
UPDATE whatsapp_messages SET mirrored_at = created_at WHERE mirrored_at IS NULL;
ALTER TABLE whatsapp_messages ALTER COLUMN mirrored_at SET DEFAULT now();
ALTER TABLE whatsapp_messages ALTER COLUMN mirrored_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS whatsapp_messages_source_time
  ON whatsapp_messages (account_id, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_chat_time
  ON whatsapp_messages (account_id, chat_jid, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS whatsapp_messages_sender
  ON whatsapp_messages (account_id, sender_jid);
CREATE INDEX IF NOT EXISTS whatsapp_messages_message_id
  ON whatsapp_messages (message_id);

-- ── call trace (source: bridge SQLite `calls`) ───────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_calls (
  account_id       text NOT NULL REFERENCES whatsapp_accounts(id) ON DELETE CASCADE,
  call_id          text NOT NULL CHECK (length(btrim(call_id)) BETWEEN 1 AND 160),
  chat_jid         text NOT NULL CHECK (length(btrim(chat_jid)) BETWEEN 1 AND 200),
  from_jid         text,
  source_timestamp timestamptz NOT NULL,
  direction        text NOT NULL CHECK (direction IN ('INCOMING','OUTGOING')),
  call_type        text,
  is_group         boolean NOT NULL DEFAULT false,
  status           text,
  duration_sec     integer CHECK (duration_sec IS NULL OR duration_sec >= 0),
  ended_at         timestamptz,
  reason           text,
  raw_payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, call_id, chat_jid)
);
CREATE INDEX IF NOT EXISTS whatsapp_calls_chat_time
  ON whatsapp_calls (account_id, chat_jid, source_timestamp DESC);
CREATE INDEX IF NOT EXISTS whatsapp_calls_missed
  ON whatsapp_calls (account_id, status, source_timestamp DESC)
  WHERE status = 'missed';
DROP TRIGGER IF EXISTS whatsapp_calls_touch ON whatsapp_calls;
CREATE TRIGGER whatsapp_calls_touch BEFORE UPDATE ON whatsapp_calls
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ── per-message identity/domain review ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS whatsapp_message_intelligence (
  account_id                text NOT NULL,
  chat_jid                  text NOT NULL,
  message_id                text NOT NULL,
  identity_role             text,
  identity_role_source      text NOT NULL DEFAULT 'AUTO',
  identity_role_reviewed_by text,
  identity_role_reviewed_at timestamptz,
  business_domain           text,
  business_domain_source    text NOT NULL DEFAULT 'AUTO',
  business_domain_reviewed_by text,
  business_domain_reviewed_at timestamptz,
  review_status             text NOT NULL DEFAULT 'UNREVIEWED'
                              CHECK (review_status IN ('UNREVIEWED','CONFIRMED','CORRECTED','REJECTED')),
  notes                     text CHECK (notes IS NULL OR length(notes) <= 2000),
  previous                  jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, chat_jid, message_id),
  CONSTRAINT whatsapp_message_intelligence_message_fk
    FOREIGN KEY (account_id, chat_jid, message_id)
    REFERENCES whatsapp_messages (account_id, chat_jid, message_id)
    ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS whatsapp_message_intelligence_role
  ON whatsapp_message_intelligence (account_id, identity_role, updated_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_message_intelligence_domain
  ON whatsapp_message_intelligence (account_id, business_domain, updated_at DESC);
CREATE INDEX IF NOT EXISTS whatsapp_message_intelligence_review
  ON whatsapp_message_intelligence (account_id, review_status, updated_at DESC);
DROP TRIGGER IF EXISTS whatsapp_message_intelligence_touch ON whatsapp_message_intelligence;
CREATE TRIGGER whatsapp_message_intelligence_touch BEFORE UPDATE ON whatsapp_message_intelligence
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

UPDATE schema_meta SET value = '1.7.0' WHERE key = 'schema_version';

-- ── unified read model for the existing Message Data Table ───────────────────
-- This is a VIEW, not a second message table. It joins the canonical message
-- row to identity, chat, media, review and manual-intelligence metadata. The
-- router/parser still read whatsapp_messages directly; this view is read-only.
CREATE OR REPLACE VIEW whatsapp_message_intelligence_view AS
SELECT
  m.id::text AS id,
  m.account_id,
  a.account_jid AS whatsapp_account_id,
  m.chat_jid,
  m.message_id,
  m.direction,
  m.sender_jid,
  act.actor_jid AS sender_original_jid,
  m.source_timestamp::text AS source_timestamp,
  m.created_at::text AS created_at,
  m.mirrored_at::text AS mirrored_at,
  m.text_content,
  m.classification AS message_classification,
  m.processing_status,
  m.retry_count,
  m.last_error,
  m.quoted_message_id,
  m.deleted_at::text AS deleted_at,
  m.media_type,
  m.media_filename,
  m.media_sha256,
  m.media_length,
  m.chat_label,
  m.chat_kind,
  m.group_participant_jid,
  m.source_rowid,
  m.import_run_id,
  m.source_sha256,
  c.label AS chat_label_registry,
  c.purpose AS chat_purpose,
  si.jid AS sender_alias_jid,
  si.kind AS sender_kind,
  si.confidence AS sender_confidence,
  si.name_source AS sender_name_source,
  si.canonical_jid AS sender_canonical_jid,
  si.person_key AS sender_person_key,
  si.employee_mobile AS sender_employee_mobile,
  si.evidence_ref AS sender_evidence_ref,
  si.metadata AS sender_metadata,
  ci.display_name AS chat_display_name,
  ci.canonical_jid AS chat_canonical_jid,
  ci.confidence AS chat_confidence,
  gpi.display_name AS group_participant_name,
  gpi.canonical_jid AS group_participant_canonical_jid,
  gpi.confidence AS group_participant_confidence,
  wm.status AS media_capture_status,
  wm.mime_type AS media_mime_type,
  wm.byte_length AS media_byte_length,
  wm.filename AS media_registry_filename,
  wm.error AS media_error,
  mi.identity_role AS override_identity_role,
  mi.identity_role_source AS override_identity_role_source,
  mi.business_domain AS override_business_domain,
  mi.business_domain_source AS override_business_domain_source,
  mi.review_status AS override_review_status,
  mi.notes AS intelligence_notes,
  mi.updated_at::text AS intelligence_updated_at,
  -- identity/contact names
  COALESCE(si.metadata->>'saved_name', si.display_name, 'NOT_AVAILABLE') AS sender_saved_name,
  COALESCE(si.metadata->>'my_contact_name', 'NOT_AVAILABLE') AS my_contact_name,
  COALESCE(si.metadata->>'push_name', 'NOT_AVAILABLE') AS whatsapp_push_name,
  COALESCE(si.display_name, si.metadata->>'saved_name', si.metadata->>'push_name', act.actor_jid, 'UNRESOLVED') AS sender_display_name,
  CASE
    WHEN si.canonical_jid LIKE '%@s.whatsapp.net' THEN si.canonical_jid
    WHEN si.kind = 'PN' THEN si.jid
    ELSE NULL
  END AS pn_jid,
  CASE
    WHEN si.kind = 'LID' THEN si.jid
    WHEN NULLIF(si.metadata->>'lid', '') IS NOT NULL THEN si.metadata->>'lid'
    ELSE NULL
  END AS lid_jid,
  CASE
    WHEN si.kind = 'PN' THEN 'PN_JID'
    WHEN si.canonical_jid IS NOT NULL THEN 'VERIFIED_ALIAS'
    WHEN si.display_name IS NOT NULL THEN 'DISPLAY_NAME'
    ELSE 'UNRESOLVED'
  END AS identity_resolution_method,
  COALESCE(si.confidence, 'UNRESOLVED') AS identity_confidence,
  -- conversation identity
  CASE WHEN m.chat_jid LIKE '%@g.us' THEN 'GROUP' ELSE 'DIRECT' END AS chat_type,
  COALESCE(ci.display_name, c.label, m.chat_label, m.chat_jid) AS chat_name,
  CASE WHEN m.chat_jid LIKE '%@g.us' THEN COALESCE(ci.display_name, c.label, m.chat_label, m.chat_jid) ELSE NULL END AS group_name,
  m.chat_jid AS original_conversation_id,
  COALESCE(gpi.display_name, m.group_participant_jid) AS group_participant_identity,
  -- media
  CASE
    WHEN m.media_type IS NULL OR m.media_type = '' OR m.media_type = 'reaction' THEN 'NOT_APPLICABLE'
    WHEN wm.status IS NOT NULL THEN wm.status
    ELSE 'MISSING'
  END AS media_status,
  COALESCE(NULLIF(m.media_type, ''), 'text') AS message_type,
  -- calls are a separate evidence stream with no message_id
  NULL::text AS call_trace_id,
  'NOT_AVAILABLE'::text AS call_type,
  'NOT_AVAILABLE'::text AS call_direction,
  'NOT_AVAILABLE'::text AS call_status,
  NULL::timestamptz AS call_event_timestamp,
  NULL::text AS missed_call_trace_id,
  'NOT_AVAILABLE'::text AS missed_call_status,
  m.chat_jid AS related_chat,
  'BRIDGE_SQLITE'::text AS original_source,
  -- identity role (manual override wins; classification never grants authority)
  CASE
    WHEN mi.identity_role IS NOT NULL THEN mi.identity_role
    WHEN si.metadata->>'role' = 'account' AND (a.account_jid = act.actor_jid OR a.admin_jids ? act.actor_jid) THEN 'OWNER'
    WHEN a.account_jid = act.actor_jid
      OR a.admin_jids ? act.actor_jid
      OR a.admin_jids ? split_part(act.actor_jid, '@', 1)
      OR a.admin_jids ? regexp_replace(act.actor_jid, ':[0-9]+@', '@')
      THEN 'ADMIN'
    WHEN ga.client_contact_id IS NOT NULL THEN 'ESCORT_CLIENT'
    WHEN emp.employee_mobile IS NOT NULL THEN CASE WHEN emp.duty_type = 'escort' THEN 'ESCORT' ELSE 'EMPLOYEE' END
    ELSE 'UNKNOWN'
  END AS identity_role,
  CASE
    WHEN mi.identity_role IS NOT NULL THEN 'MANUAL'
    WHEN a.account_jid = act.actor_jid OR a.admin_jids ? act.actor_jid OR a.admin_jids ? split_part(act.actor_jid, '@', 1) THEN 'ADMIN_JIDS'
    WHEN ga.client_contact_id IS NOT NULL THEN 'GROUP_AUTHORIZATION'
    WHEN emp.employee_mobile IS NOT NULL THEN 'EMPLOYEE_REGISTRY'
    ELSE 'UNKNOWN'
  END AS identity_role_source,
  -- business domain (manual override wins; examples do not grant permission)
  CASE
    WHEN mi.business_domain IS NOT NULL THEN mi.business_domain
    WHEN m.classification LIKE 'CASH%' THEN 'CASH'
    WHEN m.classification LIKE 'VESSEL%' OR m.classification LIKE 'CONFIRM%'
      OR m.classification LIKE 'RELEASE%' OR m.classification LIKE 'PROGRAM%' THEN 'VESSEL'
    WHEN c.purpose = 'CASH' THEN 'CASH'
    WHEN c.purpose = 'ORDERS' THEN 'VESSEL'
    WHEN c.purpose = 'BOTH' THEN 'GENERAL'
    ELSE 'UNKNOWN'
  END AS business_domain,
  CASE
    WHEN mi.business_domain IS NOT NULL THEN 'MANUAL'
    WHEN m.classification IS NOT NULL THEN 'MESSAGE_CLASSIFIER'
    WHEN c.purpose IS NOT NULL THEN 'CHAT_PURPOSE'
    ELSE 'UNKNOWN'
  END AS business_domain_source,
  CASE
    WHEN mi.review_status IS NOT NULL THEN mi.review_status
    WHEN m.processing_status = 'FAILED'
      OR EXISTS (SELECT 1 FROM review_items ri WHERE ri.target_ref = m.message_id AND ri.state = 'PENDING')
      OR EXISTS (SELECT 1 FROM cash_submissions cs WHERE cs.source_message_id = m.message_id AND cs.state = 'PENDING_REVIEW')
      THEN 'REVIEW_REQUIRED'
    WHEN m.processing_status = 'COMPLETED' THEN 'PROCESSED'
    WHEN m.processing_status = 'PROCESSING' THEN 'PROCESSING'
    ELSE 'PENDING'
  END AS review_status
FROM whatsapp_messages m
LEFT JOIN whatsapp_accounts a ON a.id = m.account_id
LEFT JOIN whatsapp_chats c ON c.account_id = m.account_id AND c.chat_jid = m.chat_jid
LEFT JOIN LATERAL (
  SELECT COALESCE(NULLIF(m.group_participant_jid, ''), NULLIF(m.sender_jid, '')) AS actor_jid
) act ON true
LEFT JOIN LATERAL (
  SELECT ia.*
    FROM identity_aliases ia
   WHERE ia.account_id = m.account_id
     AND (ia.jid = act.actor_jid OR ia.jid = split_part(act.actor_jid, '@', 1) OR ia.canonical_jid = act.actor_jid)
   ORDER BY CASE WHEN ia.jid = act.actor_jid THEN 0 WHEN ia.jid = split_part(act.actor_jid, '@', 1) THEN 1 ELSE 2 END,
            CASE ia.confidence WHEN 'EXACT' THEN 0 WHEN 'VARIANT' THEN 1 ELSE 2 END
   LIMIT 1
) si ON true
LEFT JOIN identity_aliases ci ON ci.account_id = m.account_id AND ci.jid = m.chat_jid
LEFT JOIN identity_aliases gpi ON gpi.account_id = m.account_id AND gpi.jid = m.group_participant_jid
LEFT JOIN whatsapp_media wm ON wm.account_id = m.account_id AND wm.chat_jid = m.chat_jid AND wm.message_id = m.message_id
LEFT JOIN whatsapp_message_intelligence mi ON mi.account_id = m.account_id AND mi.chat_jid = m.chat_jid AND mi.message_id = m.message_id
LEFT JOIN LATERAL (
  SELECT ga.client_contact_id
    FROM escort_client_group_authorizations ga
   WHERE ga.account_id = m.account_id AND ga.active = true
     AND (ga.participant_jid = act.actor_jid OR ga.participant_jid = split_part(act.actor_jid, '@', 1))
   LIMIT 1
) ga ON true
LEFT JOIN LATERAL (
  SELECT e.employee_mobile, e.duty_type
    FROM employees e
   WHERE e.employee_mobile = CASE
     WHEN split_part(act.actor_jid, '@', 1) LIKE '8801%'
       THEN '+88' || right(split_part(act.actor_jid, '@', 1), 10)
     ELSE NULL
   END
   LIMIT 1
) emp ON true;
