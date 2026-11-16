import {readFileSync, statSync} from 'node:fs';
import {actorFor, bodyOf, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {DomainError} from '@/lib/standalone/db';
import {getMedia} from '@/lib/standalone/messages';
import {resolveMediaPath} from '@/lib/standalone/media-storage';
import {composeVision} from '@/lib/ai/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BYTES = 12 * 1024 * 1024;

const PROMPT = [
  'You are reading an Al-Rifai escort release slip from a WhatsApp image.',
  'Transcribe only what is clearly visible. Never guess a digit, name or date.',
  'Use an empty string for a field that is missing or unreadable.',
  'Return ONLY JSON with these keys:',
  '{"mother_vessel":"","lighter_vessel":"","lighter_master":"","escort_name":"","escort_mobile":"","start_date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","shift":"D or N","notes":""}',
].join('\n');

function parseFields(text: string): Record<string, string> | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const fields: Record<string, string> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (raw === null || raw === undefined) continue;
      const clean = String(raw).trim().slice(0, 200);
      if (!clean || clean.toLowerCase() === 'null') continue;
      fields[key] = clean;
    }
    return fields;
  } catch {
    return null;
  }
}

/**
 * On-demand OCR for one release slip image.
 *
 * Read-only by design: the image is read from the media store, described by the
 * vision model, and the draft is returned for human verification. Nothing is
 * written to the database and no worker or timer calls this.
 */
export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'vessel.release');
    const body = await bodyOf<{account?: string; chat?: string; message?: string}>(request);
    const account = String(body.account ?? '');
    const chat = String(body.chat ?? '');
    const message = String(body.message ?? '');
    if (!account || !chat || !message) throw new DomainError('MEDIA_ID_REQUIRED', 400);

    const media = await getMedia(account, chat, message);
    if (!media || media.status !== 'STORED' || !media.storage_path) {
      throw new DomainError('MEDIA_NOT_FOUND', 404);
    }
    if (!/^image\//.test(String(media.mime_type ?? ''))) {
      throw new DomainError('MEDIA_NOT_IMAGE', 400);
    }
    const path = resolveMediaPath(media.storage_path);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new DomainError('MEDIA_FILE_MISSING', 404);
    }
    if (!stats.isFile()) throw new DomainError('MEDIA_FILE_INVALID', 400);
    if (stats.size > MAX_BYTES) throw new DomainError('MEDIA_TOO_LARGE', 413);

    const imageBase64 = readFileSync(path).toString('base64');
    const result = await composeVision({
      imageBase64,
      mimeType: String(media.mime_type ?? 'image/jpeg'),
      prompt: PROMPT,
    });

    if (!result.used) return ok({ok: false, reason: result.reason, model: result.model});
    return ok({
      ok: true,
      model: result.model,
      text: result.text,
      fields: parseFields(result.text),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
