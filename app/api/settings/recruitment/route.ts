import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {row, rows} from '@/lib/standalone/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function readMode(): Promise<string> {
  const setting = await row<{value: {mode?: string}}>(
    "SELECT value FROM app_settings WHERE key = 'recruitment.mode'",
  );
  return setting?.value?.mode === 'LIVE' ? 'LIVE' : 'DRY_RUN';
}

async function readBlocked(): Promise<string[]> {
  const setting = await row<{value: {mobiles?: string[]}}>(
    "SELECT value FROM app_settings WHERE key = 'recruitment.blocked'",
  );
  return setting?.value?.mobiles ?? [];
}

export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);

    const [stats, byStatus, byCategory, logs, mode, blocked] = await Promise.all([
      row<Record<string, unknown>>(
        `SELECT count(*)::int AS messages,
                count(*) FILTER (WHERE status = 'SENT')::int AS sent,
                count(*) FILTER (WHERE status = 'DRY_RUN')::int AS dry_run,
                count(*) FILTER (WHERE status = 'SKIPPED')::int AS skipped,
                count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
                count(*) FILTER (WHERE status = 'QUEUED')::int AS queued,
                count(*) FILTER (WHERE skip_reason LIKE 'known:%')::int AS known_filtered
           FROM recruitment_reply_log
          WHERE timestamp >= now() - interval '24 hours'`,
      ),
      rows<{status: string; count: number}>(
        `SELECT status, count(*)::int FROM recruitment_reply_log
          WHERE timestamp >= now() - interval '24 hours' GROUP BY status ORDER BY 2 DESC`,
      ),
      rows<{category: string | null; count: number}>(
        `SELECT category, count(*)::int FROM recruitment_reply_log
          WHERE timestamp >= now() - interval '24 hours' GROUP BY category ORDER BY 2 DESC`,
      ),
      rows<Record<string, unknown>>(
        `SELECT id, timestamp, chat_jid, sender_name, sender_mobile, incoming_message,
                incoming_message_type, category, ai_reply, status, skip_reason,
                gemini_key_id, gemini_latency_ms, error
           FROM recruitment_reply_log ORDER BY timestamp DESC LIMIT 50`,
      ),
      readMode(),
      readBlocked(),
    ]);

    return ok({
      mode,
      env: {
        dryRun: process.env.DRY_RUN ?? '1',
        sendEnabled: process.env.SEND_ENABLED ?? '0',
        allowSendStep3: process.env.ALLOW_SEND_STEP3 ?? '0',
      },
      liveEffective: mode === 'LIVE' && process.env.SEND_ENABLED === '1'
        && process.env.ALLOW_SEND_STEP3 === '1' && (process.env.DRY_RUN ?? '1') === '0',
      stats, byStatus, byCategory, logs, blocked,
    });
  } catch (error) { return errorResponse(error); }
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'settings.manage');
    if (actor.role !== 'ADMIN') return ok({error: 'ADMIN_REQUIRED'}, 403);
    const body = await bodyOf<{action?: string; mode?: string; confirm?: string; mobile?: string}>(request);

    if (body.action === 'mode') {
      const mode = body.mode === 'LIVE' ? 'LIVE' : 'DRY_RUN';
      if (mode === 'LIVE' && body.confirm !== 'LIVE_APPROVED') {
        return ok({error: 'LIVE_CONFIRMATION_REQUIRED'}, 400);
      }
      await row(
        `INSERT INTO app_settings (key, value) VALUES ('recruitment.mode', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({mode})],
      );
      return ok({mode});
    }

    if (body.action === 'block') {
      const mobile = String(body.mobile ?? '').trim();
      if (!/^(\+?8801[3-9][0-9]{8}|[0-9]{8,15})$/.test(mobile)) return ok({error: 'INVALID_MOBILE'}, 400);
      const current = await readBlocked();
      const next = [...new Set([...current, mobile])];
      await row(
        `INSERT INTO app_settings (key, value) VALUES ('recruitment.blocked', $1::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [JSON.stringify({mobiles: next})],
      );
      return ok({blocked: next});
    }

    return ok({error: 'UNKNOWN_ACTION'}, 400);
  } catch (error) { return errorResponse(error); }
}
