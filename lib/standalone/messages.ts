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
  group_participant_jid: string | null;
  media_type: string | null;
  deleted_at: string | null;
};

/** Inbox listing. Read-only; never mutates the ingested store. */
export async function listMessages(query: MessageQuery = {}) {
  const limit = Math.min(Math.max(Number(query.limit ?? 50), 1), 200);
  const offset = Math.max(Number(query.offset ?? 0), 0);
  const where: string[] = [];
  const params: unknown[] = [];

  if (query.account) {
    params.push(query.account);
    where.push(`account_id = $${params.length}`);
  }
  if (query.chat) {
    params.push(query.chat);
    where.push(`chat_jid = $${params.length}`);
  }
  if (query.direction === 'INCOMING' || query.direction === 'OUTGOING') {
    params.push(query.direction);
    where.push(`direction = $${params.length}`);
  }
  if (query.q) {
    params.push(`%${query.q}%`);
    where.push(`(text_content ILIKE $${params.length} OR chat_jid ILIKE $${params.length} OR sender_jid ILIKE $${params.length})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);

  const items = await rows<MessageRow>(
    `SELECT id::text, account_id, chat_jid, message_id, direction, sender_jid,
            source_timestamp::text, text_content, chat_kind, chat_label,
            group_participant_jid, media_type, deleted_at::text
       FROM whatsapp_messages
       ${clause}
      ORDER BY source_timestamp DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
  const total = await row<{count: string}>(
    `SELECT count(*)::text AS count FROM whatsapp_messages ${clause}`,
    params.slice(0, params.length - 2),
  );
  return {items, total: Number(total?.count ?? 0), limit, offset};
}

export async function listChats(account?: string) {
  return rows<{
    account_id: string;
    chat_jid: string;
    label: string | null;
    messages: string;
    last_at: string | null;
  }>(
    `SELECT m.account_id, m.chat_jid, max(c.label) AS label,
            count(*)::text AS messages, max(m.source_timestamp)::text AS last_at
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_chats c
              ON c.account_id = m.account_id AND c.chat_jid = m.chat_jid
      WHERE ($1::text IS NULL OR m.account_id = $1)
      GROUP BY m.account_id, m.chat_jid
      ORDER BY max(m.source_timestamp) DESC
      LIMIT 200`,
    [account ?? null],
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
  }>(
    `SELECT m.account_id,
            count(*)::text AS messages,
            count(DISTINCT m.chat_jid)::text AS chats,
            count(*) FILTER (WHERE m.direction='INCOMING')::text AS incoming,
            count(*) FILTER (WHERE m.direction='OUTGOING')::text AS outgoing,
            count(*) FILTER (WHERE m.chat_kind='GROUP')::text AS groups,
            max(m.source_timestamp)::text AS last_at,
            max(s.last_synced_at)::text AS last_synced_at,
            max(s.last_error) AS last_error
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_sync_state s ON s.account_id = m.account_id
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
  }));
}
