import {rows, row, tx, DomainError} from './db.ts';
import {recordAudit} from './audit.ts';
import {normalizeMobile} from '../business-rules.mjs';
import {phoneFromJid} from '../whatsapp-identity.mjs';
import {approvedGroupRoleMap, isSourceRole, type SourceRole} from '../source-roles.ts';

export type MessageQuery = {
  account?: string;
  chat?: string;
  direction?: string;
  kind?: string;
  q?: string;
  role?: string;
  domain?: string;
  identity?: string;
  mediaStatus?: string;
  messageType?: string;
  reviewStatus?: string;
  sourceRole?: string;
  sort?: string;
  limit?: number;
  offset?: number;
};

export type MessageRow = {
  id: string;
  account_id: string;
  whatsapp_account_id: string | null;
  chat_jid: string;
  message_id: string;
  direction: 'INCOMING' | 'OUTGOING';
  sender_jid: string | null;
  sender_original_jid: string | null;
  source_timestamp: string;
  created_at: string;
  mirrored_at: string;
  dhaka_date: string;
  dhaka_time: string;
  dhaka_timestamp: string;
  text_content: string | null;
  message_classification: string | null;
  processing_status: string;
  retry_count: number;
  last_error: string | null;
  quoted_message_id: string | null;
  deleted_at: string | null;
  media_type: string | null;
  media_filename: string | null;
  media_sha256: string | null;
  media_length: string | null;
  media_status: string;
  media_mime_type: string | null;
  media_byte_length: string | null;
  media_error: string | null;
  message_type: string;
  chat_type: string;
  chat_name: string;
  group_name: string | null;
  chat_jid_original: string;
  chat_identity_status: string | null;
  group_participant_jid: string | null;
  group_participant_identity: string | null;
  sender_saved_name: string;
  my_contact_name: string;
  whatsapp_push_name: string;
  sender_display_name: string;
  sender_mobile: string | null;
  sender_country_code: string;
  sender_identity_status: string;
  sender_identity_role: string;
  identity_role: string;
  identity_role_source: string;
  sender_canonical_jid: string | null;
  sender_person_key: string | null;
  pn_jid: string | null;
  lid_jid: string | null;
  identity_resolution_method: string;
  identity_confidence: string;
  identity_verification_status: string;
  business_domain: string;
  business_domain_source: string;
  review_status: string;
  call_trace_id: string | null;
  call_type: string;
  call_direction: string;
  call_status: string;
  call_event_timestamp: string | null;
  missed_call_trace_id: string | null;
  missed_call_status: string;
  related_chat: string;
  original_source: string;
  source_rowid: string | null;
  import_run_id: string | null;
  source_sha256: string | null;
  source_role: SourceRole;
};

export type ChatRow = {
  account_id: string;
  chat_jid: string;
  kind: string;
  display_name: string | null;
  canonical_jid: string | null;
  confidence: string | null;
  messages: string;
  incoming: string;
  outgoing: string;
  media: string;
  last_at: string | null;
};

export type CallRow = {
  account_id: string;
  call_id: string;
  chat_jid: string;
  from_jid: string | null;
  source_timestamp: string;
  direction: 'INCOMING' | 'OUTGOING';
  call_type: string | null;
  is_group: boolean;
  status: string | null;
  duration_sec: number | null;
  ended_at: string | null;
  reason: string | null;
};

const dhakaDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Dhaka', year: 'numeric', month: '2-digit', day: '2-digit',
});
const dhakaTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Dhaka', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

/** Original WhatsApp event time rendered in Asia/Dhaka. */
export function dhakaParts(value: string | null | undefined): {date: string; time: string; timestamp: string} {
  if (!value) return {date: 'NOT_AVAILABLE', time: 'NOT_AVAILABLE', timestamp: 'NOT_AVAILABLE'};
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return {date: 'NOT_AVAILABLE', time: 'NOT_AVAILABLE', timestamp: 'NOT_AVAILABLE'};
  return {
    date: dhakaDate.format(parsed),
    time: dhakaTime.format(parsed),
    timestamp: parsed.toISOString(),
  };
}

function mobileFor(pnJid: string | null): {mobile: string | null; country: string} {
  const digits = pnJid ? phoneFromJid(pnJid) : null;
  if (!digits) return {mobile: null, country: 'NOT_AVAILABLE'};
  const bd = normalizeMobile(digits);
  if (bd) return {mobile: bd, country: '+880'};
  // A live PN JID is already an international WhatsApp identity. Display the
  // full international form but do not guess a country name from its prefix.
  return {mobile: `+${digits}`, country: 'NOT_AVAILABLE'};
}

function verification(confidence: string | null): string {
  if (confidence === 'EXACT') return 'VERIFIED';
  if (confidence === 'VARIANT') return 'VARIANT';
  if (confidence === 'AMBIGUOUS') return 'AMBIGUOUS';
  return 'UNRESOLVED';
}

function viewRowToMessage(item: Record<string, unknown>): MessageRow {
  const sourceTimestamp = String(item.source_timestamp ?? '');
  const dhaka = dhakaParts(sourceTimestamp);
  const mobile = mobileFor(item.pn_jid ? String(item.pn_jid) : null);
  return {
    id: String(item.id),
    account_id: String(item.account_id),
    whatsapp_account_id: item.whatsapp_account_id ? String(item.whatsapp_account_id) : null,
    chat_jid: String(item.chat_jid),
    message_id: String(item.message_id),
    direction: item.direction as 'INCOMING' | 'OUTGOING',
    sender_jid: item.sender_jid ? String(item.sender_jid) : null,
    sender_original_jid: item.sender_original_jid ? String(item.sender_original_jid) : null,
    source_timestamp: sourceTimestamp,
    created_at: String(item.created_at ?? ''),
    mirrored_at: String(item.mirrored_at ?? ''),
    dhaka_date: dhaka.date,
    dhaka_time: dhaka.time,
    dhaka_timestamp: dhaka.timestamp,
    text_content: item.text_content ? String(item.text_content) : null,
    message_classification: item.message_classification ? String(item.message_classification) : null,
    processing_status: String(item.processing_status ?? 'PENDING'),
    retry_count: Number(item.retry_count ?? 0),
    last_error: item.last_error ? String(item.last_error) : null,
    quoted_message_id: item.quoted_message_id ? String(item.quoted_message_id) : null,
    deleted_at: item.deleted_at ? String(item.deleted_at) : null,
    media_type: item.media_type ? String(item.media_type) : null,
    media_filename: item.media_filename ? String(item.media_filename) : null,
    media_sha256: item.media_sha256 ? String(item.media_sha256) : null,
    media_length: item.media_length === null || item.media_length === undefined ? null : String(item.media_length),
    media_status: String(item.media_status ?? 'NOT_APPLICABLE'),
    media_mime_type: item.media_mime_type ? String(item.media_mime_type) : null,
    media_byte_length: item.media_byte_length === null || item.media_byte_length === undefined ? null : String(item.media_byte_length),
    media_error: item.media_error ? String(item.media_error) : null,
    message_type: String(item.message_type ?? 'text'),
    chat_type: String(item.chat_type ?? 'DIRECT'),
    chat_name: String(item.chat_name ?? item.chat_jid ?? 'NOT_AVAILABLE'),
    group_name: item.group_name ? String(item.group_name) : null,
    chat_jid_original: String(item.original_conversation_id ?? item.chat_jid),
    chat_identity_status: item.chat_confidence ? String(item.chat_confidence) : 'UNRESOLVED',
    group_participant_jid: item.group_participant_jid ? String(item.group_participant_jid) : null,
    group_participant_identity: item.group_participant_identity ? String(item.group_participant_identity) : null,
    sender_saved_name: String(item.sender_saved_name ?? 'NOT_AVAILABLE'),
    my_contact_name: String(item.my_contact_name ?? 'NOT_AVAILABLE'),
    whatsapp_push_name: String(item.whatsapp_push_name ?? 'NOT_AVAILABLE'),
    sender_display_name: String(item.sender_display_name ?? 'UNRESOLVED'),
    sender_mobile: mobile.mobile,
    sender_country_code: mobile.country,
    sender_identity_status: String(item.identity_confidence ?? 'UNRESOLVED'),
    sender_identity_role: String(item.identity_role ?? 'UNKNOWN'),
    identity_role: String(item.identity_role ?? 'UNKNOWN'),
    identity_role_source: String(item.identity_role_source ?? 'UNKNOWN'),
    sender_canonical_jid: item.sender_canonical_jid ? String(item.sender_canonical_jid) : null,
    sender_person_key: item.sender_person_key ? String(item.sender_person_key) : null,
    pn_jid: item.pn_jid ? String(item.pn_jid) : null,
    lid_jid: item.lid_jid ? String(item.lid_jid) : null,
    identity_resolution_method: String(item.identity_resolution_method ?? 'UNRESOLVED'),
    identity_confidence: String(item.identity_confidence ?? 'UNRESOLVED'),
    identity_verification_status: verification(item.identity_confidence ? String(item.identity_confidence) : null),
    business_domain: String(item.business_domain ?? 'UNKNOWN'),
    business_domain_source: String(item.business_domain_source ?? 'UNKNOWN'),
    review_status: String(item.review_status ?? 'PENDING'),
    call_trace_id: item.call_trace_id ? String(item.call_trace_id) : null,
    call_type: String(item.call_type ?? 'NOT_AVAILABLE'),
    call_direction: String(item.call_direction ?? 'NOT_AVAILABLE'),
    call_status: String(item.call_status ?? 'NOT_AVAILABLE'),
    call_event_timestamp: item.call_event_timestamp ? String(item.call_event_timestamp) : null,
    missed_call_trace_id: item.missed_call_trace_id ? String(item.missed_call_trace_id) : null,
    missed_call_status: String(item.missed_call_status ?? 'NOT_AVAILABLE'),
    related_chat: String(item.related_chat ?? item.chat_jid),
    original_source: String(item.original_source ?? 'BRIDGE_SQLITE'),
    source_rowid: item.source_rowid === null || item.source_rowid === undefined ? null : String(item.source_rowid),
    import_run_id: item.import_run_id ? String(item.import_run_id) : null,
    source_sha256: item.source_sha256 ? String(item.source_sha256) : null,
    source_role: isSourceRole(item.source_role) ? item.source_role : 'REVIEW_REQUIRED',
  };
}

const SORTABLE: Record<string, string> = {
  time_desc: 'source_timestamp DESC, id DESC',
  time_asc: 'source_timestamp ASC, id ASC',
  sender: 'sender_display_name ASC, source_timestamp DESC',
  domain: 'business_domain ASC, source_timestamp DESC',
  role: 'identity_role ASC, source_timestamp DESC',
};

/** Inbox listing. Read-only; never mutates the ingested store. */
export async function listMessages(query: MessageQuery = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const where: string[] = [];
  // Parameter 1 is the approved group JID → role map used to compute the
  // effective role without relying on a display name.
  const params: unknown[] = [JSON.stringify(approvedGroupRoleMap())];
  const bind = (value: unknown) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (query.account) where.push(`account_id = ${bind(query.account)}`);
  if (query.chat) where.push(`chat_jid = ${bind(query.chat)}`);
  if (query.direction === 'INCOMING' || query.direction === 'OUTGOING') {
    where.push(`direction = ${bind(query.direction)}`);
  }
  if (query.kind === 'GROUP' || query.kind === 'DIRECT') {
    where.push(`chat_type = ${bind(query.kind)}`);
  }
  if (query.role) where.push(`identity_role = ${bind(query.role)}`);
  if (query.domain) where.push(`business_domain = ${bind(query.domain)}`);
  if (query.identity) where.push(`identity_confidence = ${bind(query.identity)}`);
  if (query.mediaStatus) where.push(`media_status = ${bind(query.mediaStatus)}`);
  if (query.messageType) where.push(`message_type = ${bind(query.messageType)}`);
  if (query.reviewStatus) where.push(`review_status = ${bind(query.reviewStatus)}`);
  if (query.sourceRole) where.push(`source_role = ${bind(query.sourceRole)}`);
  if (query.q) {
    const term = `%${query.q}%`;
    const p = bind(term);
    where.push(`(text_content ILIKE ${p} OR chat_jid ILIKE ${p} OR message_id ILIKE ${p}
      OR sender_jid ILIKE ${p} OR sender_display_name ILIKE ${p} OR my_contact_name ILIKE ${p}
      OR whatsapp_push_name ILIKE ${p} OR chat_name ILIKE ${p} OR group_name ILIKE ${p})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const order = SORTABLE[query.sort ?? 'time_desc'] ?? SORTABLE.time_desc;
  // Effective source role: explicit DB role wins; approved group JIDs are
  // resolved from the shared map; direct chats fall back to their configured
  // purpose. A group is never inferred from a display name.
  const base = `SELECT v.*,
      COALESCE(c.source_role,
        CASE
          WHEN v.chat_type = 'GROUP' THEN COALESCE($1::jsonb->>v.chat_jid, 'REVIEW_REQUIRED')
          WHEN v.chat_purpose = 'ORDERS' THEN 'ORDER_INTAKE'
          WHEN v.chat_purpose = 'CASH' THEN 'CASH_ONLY'
          ELSE 'REVIEW_REQUIRED'
        END) AS source_role
    FROM whatsapp_message_intelligence_view v
    LEFT JOIN whatsapp_chats c
           ON c.account_id = v.account_id AND c.chat_jid = v.chat_jid`;
  params.push(limit, offset);
  const items = await rows<Record<string, unknown>>(
    `SELECT * FROM (${base}) m
      ${clause}
      ORDER BY ${order}
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await row<{count: string}>(
    `SELECT count(*)::text AS count FROM (${base}) m ${clause}`,
    params.slice(0, params.length - 2),
  );
  return {
    items: items.map(viewRowToMessage),
    total: Number(total?.count ?? 0),
    limit,
    offset,
  };
}

/**
 * Conversation list. `kind` accepts GROUP or DIRECT; the label prefers the
 * bridge/resolver name and falls back to the raw JID, which stays visible when
 * an identity is unresolved.
 */
export async function listChats(account?: string, kind?: string) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (account) {
    params.push(account);
    where.push(`m.account_id = $${params.length}`);
  }
  if (kind === 'GROUP') where.push(`m.chat_kind = 'GROUP'`);
  if (kind === 'DIRECT') where.push(`m.chat_kind <> 'GROUP'`);
  return rows<ChatRow>(
    `SELECT m.account_id, m.chat_jid,
            max(m.chat_kind) AS kind,
            max(ci.display_name) AS display_name,
            max(ci.canonical_jid) AS canonical_jid,
            max(ci.confidence) AS confidence,
            count(*)::text AS messages,
            count(*) FILTER (WHERE m.direction='INCOMING')::text AS incoming,
            count(*) FILTER (WHERE m.direction='OUTGOING')::text AS outgoing,
            count(wm.message_id)::text AS media,
            max(m.source_timestamp)::text AS last_at
       FROM whatsapp_messages m
       LEFT JOIN identity_aliases ci
              ON ci.account_id = m.account_id AND ci.jid = m.chat_jid
       LEFT JOIN whatsapp_media wm
              ON wm.account_id = m.account_id AND wm.chat_jid = m.chat_jid
             AND wm.message_id = m.message_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      GROUP BY m.account_id, m.chat_jid
      ORDER BY max(m.source_timestamp) DESC
      LIMIT 300`,
    params,
  );
}

/** Actual bridge call events, if migration 012 is present. */
export async function listCalls(account?: string, chat?: string, limit = 100) {
  const params: unknown[] = [];
  const where: string[] = [];
  if (account) { params.push(account); where.push(`account_id=$${params.length}`); }
  if (chat) { params.push(chat); where.push(`chat_jid=$${params.length}`); }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 300));
  const present = await row<{present: boolean}>("SELECT to_regclass('public.whatsapp_calls') IS NOT NULL AS present");
  if (!present?.present) return [] as CallRow[];
  return rows<CallRow>(
    `SELECT account_id, call_id, chat_jid, from_jid, source_timestamp::text,
            direction, call_type, is_group, status, duration_sec, ended_at::text, reason
       FROM whatsapp_calls
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY source_timestamp DESC
      LIMIT $${params.length}`,
    params,
  );
}

export async function messageStats() {
  const totals = await rows<{
    account_id: string;
    messages: string;
    chats: string;
    incoming: string;
    outgoing: string;
    groups: string;
    last_at: string | null;
    last_synced_at: string | null;
    last_error: string | null;
    checkpoint: string | null;
    media_stored: string;
    media_failed: string;
    media_bytes: string;
    identities: string;
  }>(
    `SELECT m.account_id,
            count(*)::text AS messages,
            count(DISTINCT m.chat_jid)::text AS chats,
            count(*) FILTER (WHERE m.direction='INCOMING')::text AS incoming,
            count(*) FILTER (WHERE m.direction='OUTGOING')::text AS outgoing,
            count(*) FILTER (WHERE m.chat_kind='GROUP')::text AS groups,
            max(m.source_timestamp)::text AS last_at,
            max(s.last_synced_at)::text AS last_synced_at,
            max(s.last_error) AS last_error,
            max(s.last_rowid)::text AS checkpoint,
            coalesce(max(w.stored),0)::text AS media_stored,
            coalesce(max(w.failed),0)::text AS media_failed,
            coalesce(max(w.bytes),0)::text AS media_bytes,
            coalesce(max(i.total),0)::text AS identities
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_sync_state s ON s.account_id = m.account_id
       LEFT JOIN (
         SELECT account_id,
                count(*) FILTER (WHERE status='STORED') AS stored,
                count(*) FILTER (WHERE status='FAILED') AS failed,
                coalesce(sum(byte_length) FILTER (WHERE status='STORED'),0) AS bytes
           FROM whatsapp_media GROUP BY account_id
       ) w ON w.account_id = m.account_id
       LEFT JOIN (
         SELECT account_id, count(*) AS total FROM identity_aliases GROUP BY account_id
       ) i ON i.account_id = m.account_id
      GROUP BY m.account_id
      ORDER BY m.account_id`,
  );
  let callStats = new Map<string, {calls: number; missed: number}>();
  const callsPresent = await row<{present: boolean}>("SELECT to_regclass('public.whatsapp_calls') IS NOT NULL AS present").catch(() => null);
  if (callsPresent?.present) {
    const calls = await rows<{account_id: string; calls: string; missed: string}>(
      `SELECT account_id, count(*)::text AS calls,
              count(*) FILTER (WHERE status='missed')::text AS missed
         FROM whatsapp_calls GROUP BY account_id`,
    );
    callStats = new Map(calls.map((entry) => [entry.account_id, {calls: Number(entry.calls), missed: Number(entry.missed)}]));
  }
  return totals.map((item) => ({
    account: item.account_id,
    messages: Number(item.messages),
    chats: Number(item.chats),
    incoming: Number(item.incoming),
    outgoing: Number(item.outgoing),
    groups: Number(item.groups),
    lastAt: item.last_at,
    lastSyncedAt: item.last_synced_at,
    lastError: item.last_error,
    checkpoint: item.checkpoint === null ? null : Number(item.checkpoint),
    mediaStored: Number(item.media_stored),
    mediaFailed: Number(item.media_failed),
    mediaBytes: Number(item.media_bytes),
    identities: Number(item.identities),
    calls: callStats.get(item.account_id)?.calls ?? 0,
    missedCalls: callStats.get(item.account_id)?.missed ?? 0,
  }));
}

export type MessageEvidenceRow = {
  message_id: string;
  account_id: string;
  chat_jid: string;
  direction: string;
  sender_jid: string | null;
  source_timestamp: string;
  text_content: string | null;
};

/** One mirrored message by stable identity, for provenance display. */
export async function getMessageEvidence(account: string, chat: string, messageId: string) {
  return row<MessageEvidenceRow>(
    `SELECT message_id, account_id, chat_jid, direction, sender_jid,
            source_timestamp::text AS source_timestamp, text_content
       FROM whatsapp_messages
      WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3`,
    [account, chat, messageId],
  );
}

export type MediaRow = {
  account_id: string;
  chat_jid: string;
  message_id: string;
  media_type: string;
  mime_type: string | null;
  filename: string | null;
  byte_length: string;
  sha256: string;
  storage_path: string;
  status: 'STORED' | 'FAILED' | 'SKIPPED';
  error: string | null;
  captured_at: string;
};

/** One stored attachment, looked up by the message that carried it. */
export async function getMedia(account: string, chat: string, message: string) {
  return row<MediaRow>(
    `SELECT account_id, chat_jid, message_id, media_type, mime_type, filename,
            byte_length::text, sha256, storage_path, status, error, captured_at::text
       FROM whatsapp_media
      WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3`,
    [account, chat, message],
  );
}

export type IntelligenceInput = {
  account: string;
  chat: string;
  messageId: string;
  identityRole?: string | null;
  businessDomain?: string | null;
  reviewStatus?: string | null;
  notes?: string | null;
};

/**
 * Authorized review/correction of one message's identity role and business
 * domain. This is metadata only: it never changes chat authorization, WhatsApp
 * permissions, Cash, the ledger or a Vessel program.
 */
export async function setMessageIntelligence(actor: {id: string; role?: string}, input: IntelligenceInput) {
  const account = String(input.account ?? '').trim();
  const chat = String(input.chat ?? '').trim();
  const messageId = String(input.messageId ?? '').trim();
  if (!account || !chat || !messageId) throw new DomainError('MESSAGE_IDENTITY_REQUIRED', 400);
  const allowedRoles = new Set(['OWNER', 'ADMIN', 'ACCOUNTANT', 'ESCORT_CLIENT', 'ESCORT', 'EMPLOYEE', 'SUPPLIER', 'CUSTOMER', 'UNKNOWN']);
  const allowedDomains = new Set(['CASH', 'VESSEL', 'SECURITY', 'HR', 'PAYROLL', 'OPERATIONS', 'PERSONAL', 'GENERAL', 'UNKNOWN']);
  const allowedReview = new Set(['UNREVIEWED', 'CONFIRMED', 'CORRECTED', 'REJECTED']);
  const identityRole = input.identityRole ? String(input.identityRole).trim().toUpperCase() : null;
  const businessDomain = input.businessDomain ? String(input.businessDomain).trim().toUpperCase() : null;
  const reviewStatus = input.reviewStatus ? String(input.reviewStatus).trim().toUpperCase() : null;
  if (identityRole && !allowedRoles.has(identityRole)) throw new DomainError('IDENTITY_ROLE_INVALID', 400);
  if (businessDomain && !allowedDomains.has(businessDomain)) throw new DomainError('BUSINESS_DOMAIN_INVALID', 400);
  if (reviewStatus && !allowedReview.has(reviewStatus)) throw new DomainError('REVIEW_STATUS_INVALID', 400);

  return tx(async (client) => {
    const found = await client.query(
      'SELECT 1 FROM whatsapp_messages WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3',
      [account, chat, messageId],
    );
    if (!found.rowCount) throw new DomainError('MESSAGE_NOT_FOUND', 404);
    const existing = await client.query(
      'SELECT identity_role, business_domain, review_status, notes, previous FROM whatsapp_message_intelligence WHERE account_id=$1 AND chat_jid=$2 AND message_id=$3',
      [account, chat, messageId],
    );
    const before = existing.rows[0] ?? null;
    const previous = Array.isArray(before?.previous) ? before.previous : [];
    if (before) {
      previous.push({
        at: new Date().toISOString(),
        by: actor.id,
        identityRole: before.identity_role,
        businessDomain: before.business_domain,
        reviewStatus: before.review_status,
        notes: before.notes,
      });
    }
    const saved = await client.query(
      `INSERT INTO whatsapp_message_intelligence
         (account_id, chat_jid, message_id, identity_role, identity_role_source,
          identity_role_reviewed_by, identity_role_reviewed_at,
          business_domain, business_domain_source, business_domain_reviewed_by,
          business_domain_reviewed_at, review_status, notes, previous, updated_at)
       VALUES ($1,$2,$3,$4,CASE WHEN $4::text IS NULL THEN 'AUTO' ELSE 'MANUAL' END,
               CASE WHEN $4::text IS NULL THEN NULL ELSE $9 END,
               CASE WHEN $4::text IS NULL THEN NULL ELSE now() END,
               $5,CASE WHEN $5::text IS NULL THEN 'AUTO' ELSE 'MANUAL' END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE $9 END,
               CASE WHEN $5::text IS NULL THEN NULL ELSE now() END,
               COALESCE($6,'UNREVIEWED'),$7,$8::jsonb,now())
       ON CONFLICT (account_id, chat_jid, message_id) DO UPDATE SET
         identity_role = COALESCE(EXCLUDED.identity_role, whatsapp_message_intelligence.identity_role),
         identity_role_source = CASE WHEN EXCLUDED.identity_role IS NULL THEN whatsapp_message_intelligence.identity_role_source ELSE 'MANUAL' END,
         identity_role_reviewed_by = CASE WHEN EXCLUDED.identity_role IS NULL THEN whatsapp_message_intelligence.identity_role_reviewed_by ELSE EXCLUDED.identity_role_reviewed_by END,
         identity_role_reviewed_at = CASE WHEN EXCLUDED.identity_role IS NULL THEN whatsapp_message_intelligence.identity_role_reviewed_at ELSE now() END,
         business_domain = COALESCE(EXCLUDED.business_domain, whatsapp_message_intelligence.business_domain),
         business_domain_source = CASE WHEN EXCLUDED.business_domain IS NULL THEN whatsapp_message_intelligence.business_domain_source ELSE 'MANUAL' END,
         business_domain_reviewed_by = CASE WHEN EXCLUDED.business_domain IS NULL THEN whatsapp_message_intelligence.business_domain_reviewed_by ELSE EXCLUDED.business_domain_reviewed_by END,
         business_domain_reviewed_at = CASE WHEN EXCLUDED.business_domain IS NULL THEN whatsapp_message_intelligence.business_domain_reviewed_at ELSE now() END,
         review_status = COALESCE(EXCLUDED.review_status, whatsapp_message_intelligence.review_status),
         notes = COALESCE(EXCLUDED.notes, whatsapp_message_intelligence.notes),
         previous = EXCLUDED.previous,
         updated_at = now()
       RETURNING *`,
      [account, chat, messageId, identityRole, businessDomain, reviewStatus,
        input.notes ?? null, JSON.stringify(previous), actor.id],
    );
    await recordAudit({
      actor: actor as never,
      action: 'WHATSAPP_MESSAGE_INTELLIGENCE_UPDATED',
      entity: 'whatsapp_message',
      entityId: messageId,
      detail: {
        accountId: account, chatJid: chat,
        before: before ? {
          identityRole: before.identity_role, businessDomain: before.business_domain,
          reviewStatus: before.review_status, notes: before.notes,
        } : null,
        after: {
          identityRole: identityRole ?? before?.identity_role ?? null,
          businessDomain: businessDomain ?? before?.business_domain ?? null,
          reviewStatus: reviewStatus ?? before?.review_status ?? null,
          notes: input.notes ?? before?.notes ?? null,
        },
        source: 'ADMIN_REVIEW',
      },
      source: 'WEB',
      sourceRef: messageId,
    }, client);
    return saved.rows[0];
  });
}
