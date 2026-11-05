// Ingestion of live native pages into the immutable message store.
//
// This is the single write path for live WA-01 messages. It is scope-gated by
// public.conversation_scope (fail-closed), preserves the bridge envelope as
// evidence, and only QUEUES Cash/Vessel processing — it never posts, approves
// or releases anything.

import type { ConversationScope } from './conversation-scope.ts';
import type { NativeLivePage } from './native-live-reader.ts';

export type NativeIngestPool = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
};

export type NativeIngestTally = { scanned: number; inserted: number; archived: number; queuedCash: number; queuedVessel: number; excluded: number };

export async function ingestNativePage(
  pool: NativeIngestPool,
  scope: ConversationScope,
  account: string,
  page: NativeLivePage,
): Promise<NativeIngestTally> {
  const tally: NativeIngestTally = { scanned: 0, inserted: 0, archived: 0, queuedCash: 0, queuedVessel: 0, excluded: 0 };

  for (const record of page.records) {
    tally.scanned += 1;
    const conversation = scope.byChat(page.chatJid);
    // Never let an unapproved conversation enter business processing, even if
    // the bridge were to return one.
    if (!conversation || conversation.accountId !== account) {
      tally.excluded += 1;
      continue;
    }
    if (record.status !== 'CONTENT' || !record.envelope) continue;
    const envelope = record.envelope;
    const senderJid = envelope.senderJid || record.senderJid || null;

    const inserted = await pool.query(
      `INSERT INTO public.whatsapp_messages_original
       (wa_account,chat_jid,chat_type,message_id,direction,sender_jid,sender_phone,
        sender_push_name,receiver_jid,group_name,timestamp,message_type,raw_content,
        text_content,media_ref,ingested_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,$8,$9,$10,$11,$12::jsonb,$13,NULL,now())
       ON CONFLICT (wa_account,chat_jid,message_id) DO NOTHING
       RETURNING id`,
      [
        account,
        page.chatJid,
        envelope.chatType === 'group' ? 'group' : 'individual',
        envelope.nativeMessageId,
        envelope.direction === 'OUTGOING' ? 'outgoing' : 'incoming',
        senderJid,
        envelope.senderPhone,
        envelope.direction === 'OUTGOING' ? page.chatJid : null,
        envelope.chatType === 'group' ? envelope.groupDisplayName : null,
        envelope.sourceTimestamp,
        (envelope.eventType || 'text').toLowerCase(),
        JSON.stringify({
          provider: 'wa01-native-live',
          bridgeSequence: record.sequence,
          status: record.status,
          kind: record.kind,
          sourceHash: envelope.payload?.sha256 ?? record.semanticHash,
          senderLid: envelope.senderLid,
          quotedMessageId: envelope.quotedMessageId,
          forwarded: envelope.forwarded ?? null,
          observedAt: record.observedAt,
        }),
        envelope.payload?.text ?? '',
      ],
    );

    const originalId = inserted.rows[0]?.id ?? (await pool.query(
      'SELECT id FROM public.whatsapp_messages_original WHERE wa_account=$1 AND chat_jid=$2 AND message_id=$3',
      [account, page.chatJid, envelope.nativeMessageId],
    )).rows[0]?.id;
    if (originalId === undefined || originalId === null) continue;
    if (inserted.rows.length) tally.inserted += 1;

    const archived = await pool.query(
      `INSERT INTO public.whatsapp_messages_processing (original_id,domain,status,processed_content,processed_at)
       VALUES ($1,'archive','processed',$2::jsonb,now())
       ON CONFLICT (original_id,domain) DO NOTHING RETURNING id`,
      [originalId, JSON.stringify({ version: 'immutable-original-archive-v1', sourceMode: 'wa01-native-live' })],
    );
    if (archived.rows.length) tally.archived += 1;

    const domain = conversation.domain === 'CASH' ? 'cash' : 'vessel';
    const queued = await pool.query(
      `INSERT INTO public.whatsapp_messages_processing (original_id,domain,status)
       VALUES ($1,$2,'pending') ON CONFLICT (original_id,domain) DO NOTHING RETURNING id`,
      [originalId, domain],
    );
    if (queued.rows.length) {
      if (domain === 'cash') tally.queuedCash += 1;
      else tally.queuedVessel += 1;
    }
  }
  return tally;
}
