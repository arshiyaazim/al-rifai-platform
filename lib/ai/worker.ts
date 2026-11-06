// Optional WA-02 AI worker. Default-disabled by both environment and database
// gates. It only creates AI conversation state, applicant/order drafts and
// outbound DRAFT rows; it never sends a WhatsApp message.

import {rows} from '../standalone/db.ts';
import {processWa02Message} from './engine.ts';

let timer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let running = false;
let lastReason: string | null = null;
let lastRun: {at: string; processed: number; errors: number} | null = null;

const intervalMs = () => {
  const value = Number(process.env.AI_WA02_INTERVAL_MS ?? 5000);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1000), 300_000) : 5000;
};
const limit = () => {
  const value = Number(process.env.AI_WA02_LIMIT ?? 25);
  return Number.isFinite(value) ? Math.min(Math.max(Math.floor(value), 1), 100) : 25;
};

async function configuration(): Promise<{enabled: boolean; startRowid: bigint | null; reason: string | null}> {
  const settings = await rows<{key: string; value: unknown}>(
    `SELECT key, value FROM app_settings WHERE key IN ('ai_wa02_enabled','ai_wa02_start_rowid:wa-02')`,
  );
  const byKey = new Map(settings.map((entry) => [entry.key, entry.value]));
  if (byKey.get('ai_wa02_enabled') !== true) return {enabled: false, startRowid: null, reason: 'AI_WA02_DISABLED'};
  const raw = byKey.get('ai_wa02_start_rowid:wa-02');
  if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < 0) {
    return {enabled: false, startRowid: null, reason: 'AI_WA02_START_ROWID_MISSING'};
  }
  return {enabled: true, startRowid: BigInt(raw), reason: null};
}

async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const config = await configuration();
    if (!config.enabled || config.startRowid === null) {
      if (lastReason !== config.reason) {
        lastReason = config.reason;
        console.error(`WA-02 AI worker idle (${config.reason}).`);
      }
      return;
    }
    lastReason = null;
    const candidates = await rows<{
      message_id: string; chat_jid: string; sender_jid: string | null; text_content: string | null;
    }>(
      `SELECT m.message_id, m.chat_jid, m.sender_jid, m.text_content
         FROM whatsapp_messages m
        WHERE m.account_id = 'wa-02'
          AND m.direction = 'INCOMING'
          AND m.source_rowid > $1
          AND m.text_content IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM ai_messages a
             WHERE a.account_id = 'wa-02' AND a.source_message_id = m.message_id
          )
        ORDER BY m.source_rowid
        LIMIT $2`,
      [config.startRowid.toString(), limit()],
    );
    let processed = 0;
    let errors = 0;
    for (const candidate of candidates) {
      try {
        await processWa02Message({
          messageId: candidate.message_id,
          chatJid: candidate.chat_jid,
          senderJid: candidate.sender_jid,
          text: candidate.text_content ?? '',
          direction: 'INCOMING',
        });
        processed += 1;
      } catch (error) {
        errors += 1;
        console.error('WA-02 AI message failed:', error instanceof Error ? error.message : 'AI_MESSAGE_FAILED');
      }
    }
    lastRun = {at: new Date().toISOString(), processed, errors};
    if (processed || errors) console.error(`WA-02 AI worker processed=${processed} errors=${errors}.`);
  } catch (error) {
    const code = error instanceof Error && /^[A-Z][A-Z0-9_]{3,80}$/.test(error.message)
      ? error.message : 'AI_WA02_TICK_FAILED';
    console.error(`WA-02 AI worker tick failed (${code}).`);
  } finally {
    running = false;
    if (started) {
      timer = setTimeout(() => void tick(), intervalMs());
      timer.unref?.();
    }
  }
}

export function startAiWa02Worker(): {started: boolean; reason?: string; intervalMs?: number; limit?: number} {
  if (process.env.AI_WA02_ENABLED !== '1') return {started: false, reason: 'AI_WA02_ENV_DISABLED'};
  if (started) return {started: false, reason: 'ALREADY_STARTED'};
  started = true;
  timer = setTimeout(() => void tick(), 1000);
  timer.unref?.();
  return {started: true, intervalMs: intervalMs(), limit: limit()};
}

export function stopAiWa02Worker(): void {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export function aiWa02WorkerStatus() {
  return {started, running, lastReason, lastRun, intervalMs: intervalMs(), limit: limit()};
}
