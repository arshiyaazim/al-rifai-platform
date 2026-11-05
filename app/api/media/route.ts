import {readFileSync, statSync} from 'node:fs';
import {actorFor, errorResponse} from '../_shared';
import {DomainError} from '@/lib/standalone/db';
import {getMedia} from '@/lib/standalone/messages';
import {attachmentName, resolveMediaPath} from '@/lib/standalone/media-storage';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function disposition(mime: string, filename: string | null) {
  const inline = /^(image|audio|video)\//.test(mime);
  const name = attachmentName(filename, inline ? 'attachment' : 'download');
  return `${inline ? 'inline' : 'attachment'}; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * Authenticated access to one captured attachment.
 *
 * The caller must hold a valid workspace session; the file is never served from
 * a public directory. Media rows are looked up by account/chat/message, so a
 * client cannot request an arbitrary path.
 */
export async function GET(request: Request) {
  try {
    await actorFor(request, {csrf: false});
    const url = new URL(request.url);
    const account = url.searchParams.get('account');
    const chat = url.searchParams.get('chat');
    const message = url.searchParams.get('message');
    if (!account || !chat || !message) throw new DomainError('MEDIA_ID_REQUIRED', 400);

    const media = await getMedia(account, chat, message);
    if (!media || media.status !== 'STORED' || !media.storage_path) {
      throw new DomainError('MEDIA_NOT_FOUND', 404);
    }
    const path = resolveMediaPath(media.storage_path);
    let stats;
    try {
      stats = statSync(path);
    } catch {
      throw new DomainError('MEDIA_FILE_MISSING', 404);
    }
    if (!stats.isFile()) throw new DomainError('MEDIA_FILE_INVALID', 404);

    const body = readFileSync(path);
    const mime = media.mime_type || 'application/octet-stream';
    return new Response(new Uint8Array(body), {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(body.length),
        'Content-Disposition': disposition(mime, media.filename),
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
