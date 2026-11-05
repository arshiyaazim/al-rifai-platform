import {rows, row} from './db.ts';

export type MessageQuery = {
  account?: string;
  chat?: string;
  direction?: string;
  q?: string;
  limit?: number;
  offset?: number;
};

export type MessageRow = {
  id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  direction: 'INCOMING' | 'OUTGOING';
  sender_jid: string | null;
  source_timestamp: string;
  text_content: string | null;
  chat_kind: string | null;
  chat_label: string | null;
  chat_name: string | null;
  chat_confidence: string | null;
  group_participant_jid: string | null;
  sender_name: string | null;
  sender_canonical_jid: string | null;
  sender_confidence: string | null;
  media_type: string | null;
  media_status: string | null;
  media_mime_type: string | null;
  media_byte_length: string | null;
  media_filename: string | null;
  deleted_at: string | null;
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

const MEDIA_JOIN = `
  LEFT JOIN whatsapp_media wm
         ON wm.account_id = m.account_id
        AND wm.chat_jid = m.chat_jid
        AND wm.message_id = m.message_id`;

/** Inbox listing. Read-only; never mutates the ingested store. */
export async function listMessages(query: MessageQuery = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.account) {
    params.push(query.account);
    where.push(`m.account_id = $${params.length}`);
  }
  if (query.chat) {
    params.push(query.chat);
    where.push(`m.chat_jid = $${params.length}`);
  }
  if (query.direction === 'INCOMING' || query.direction === 'OUTGOING') {
    params.push(query.direction);
    where.push(`m.direction = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    where.push(`(m.text_content ILIKE $${params.length} OR m.chat_jid ILIKE $${params.length}
      OR m.sender_jid ILIKE $${params.length} OR ci.display_name ILIKE $${params.length}
      OR si.display_name ILIKE $${params.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const items = await rows<MessageRow>(
    `SELECT m.id::text, m.account_id, m.chat_jid, m.message_id, m.direction, m.sender_jid,
            m.source_timestamp::text, m.text_content, m.chat_kind,
            m.chat_label, ci.display_name AS chat_name,
            ci.confidence AS chat_confidence,
            m.group_participant_jid,
            si.display_name AS sender_name,
            si.canonical_jid AS sender_canonical_jid,
            si.confidence AS sender_confidence,
            m.media_type, wm.status AS media_status, wm.mime_type AS media_mime_type,
            wm.byte_length::text AS media_byte_length, wm.filename AS media_filename,
            m.deleted_at::text
       FROM whatsapp_messages m
       LEFT JOIN identity_aliases si
              ON si.account_id = m.account_id
             AND si.jid = COALESCE(NULLIF(m.group_participant_jid,''), NULLIF(m.sender_jid,''))
       LEFT JOIN identity_aliases ci
              ON ci.account_id = m.account_id AND ci.jid = m.chat_jid
       ${MEDIA_JOIN}
       ${clause}
      ORDER BY m.source_timestamp DESC, m.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await row<{count: string}>(
    `SELECT count(*)::text AS count
       FROM whatsapp_messages m
       LEFT JOIN identity_aliases si
              ON si.account_id = m.account_id
             AND si.jid = COALESCE(NULLIF(m.group_participant_jid,''), NULLIF(m.sender_jid,''))
       LEFT JOIN identity_aliases ci
              ON ci.account_id = m.account_id AND ci.jid = m.chat_jid
       ${clause}`,
    params.slice(0, params.length - 2),
  );
  return {items, total: Number(total?.count ?? 0), limit, offset};
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
  }));
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
