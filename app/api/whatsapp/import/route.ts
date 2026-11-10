import {createHash} from 'node:crypto';
import {NextResponse} from 'next/server';
import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {tx} from '@/lib/standalone/db';
import {parseWhatsAppChat} from '@/lib/whatsapp-chat-parser';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 5 * 1024 * 1024;
const ACCOUNT = 'wa-01';
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const normalise = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();

function senderJid(sender: string): string {
  const digits = sender.replace(/[^0-9]/g, '');
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `${digits}@s.whatsapp.net`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}@s.whatsapp.net`;
  return `import-${sha(sender).slice(0, 16)}@s.whatsapp.net`;
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'vessel.command');
    if (actor.role !== 'ADMIN') {
      return NextResponse.json({error: 'ADMIN_REQUIRED'}, {status: 403});
    }

    const form = await request.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return ok({error: 'FILE_REQUIRED'}, 400);
    if (file.size <= 0 || file.size > MAX_BYTES) return ok({error: 'FILE_SIZE_INVALID'}, 400);
    if (!/\.txt$/i.test(file.name)) return ok({error: 'TXT_REQUIRED'}, 400);

    const text = await file.text();
    const parsed = parseWhatsAppChat(text);
    if (!parsed.messages.length) {
      return ok({
        imported: 0, skipped: parsed.skipped, duplicates: 0,
        rejected: parsed.rejected.length, errors: [],
        message: 'NO_MESSAGES_PARSED',
      });
    }

    const seen = new Set<string>();
    const prepared = parsed.messages.filter((message) => {
      const key = `${message.timestamp}|${normalise(message.body)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const inFileDuplicates = parsed.messages.length - prepared.length;

    let imported = 0;
    let duplicates = inFileDuplicates;
    const errors: string[] = [];

    const inserted = await tx(async (client) => {
      const ids: string[] = [];
      for (const message of prepared) {
        const jid = senderJid(message.sender);
        const messageId = `IMP_${sha(`${message.timestamp}|${message.sender}|${message.body}`).slice(0, 32).toUpperCase()}`;
        const duplicate = await client.query(
          `SELECT 1 FROM whatsapp_messages
            WHERE account_id = $1
              AND abs(extract(epoch from (source_timestamp - $2::timestamptz))) < 2
              AND lower(btrim(coalesce(text_content, ''))) = lower(btrim($3))
            LIMIT 1`,
          [ACCOUNT, message.timestamp, message.body],
        );
        if (duplicate.rowCount) {
          duplicates += 1;
          continue;
        }
        const contentHash = sha(normalise(message.body));
        const insertedRow = await client.query<{id: string}>(
          `INSERT INTO whatsapp_messages
             (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp,
              text_content, content_hash, classification, chat_label, chat_kind,
              sender_resolved_jid, chat_resolved_jid, identity_state,
              processing_status, source_sha256, raw_payload)
           VALUES ($1,$2,$3,'INCOMING',$4,$5::timestamptz,$6,$7,'PENDING',$8,'DIRECT',
                   $4,$2,'UNRESOLVED','PENDING',$9,$10::jsonb)
           ON CONFLICT (account_id, chat_jid, message_id) DO NOTHING
           RETURNING id`,
          [ACCOUNT, jid, messageId, jid, message.timestamp, message.body, contentHash,
            message.sender, sha(`${file.name}|${message.line}|${message.body}`),
            JSON.stringify({
              source: 'CHAT_EXPORT', filename: file.name, line: message.line,
              senderName: message.sender, exportedTimestamp: message.timestamp,
            })],
        );
        if (insertedRow.rowCount) {
          ids.push(insertedRow.rows[0].id);
          imported += 1;
        } else {
          duplicates += 1;
        }
      }
      return ids;
    });

    let router: unknown = null;
    if (inserted.length) {
      try {
        const {routePendingMessages} = await import('@/lib/message-router');
        router = await routePendingMessages(actor as never, Math.min(inserted.length + 5, 200));
      } catch (error) {
        errors.push(`ROUTER:${String(error instanceof Error ? error.message : error).slice(0, 160)}`);
      }
    }

    return ok({
      imported,
      skipped: parsed.skipped,
      duplicates,
      rejected: parsed.rejected.length,
      rejectedLines: parsed.rejected.slice(0, 20),
      errors,
      router,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
