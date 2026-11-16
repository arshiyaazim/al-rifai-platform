import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {actorFor, errorResponse} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = path.resolve(process.env.EMPLOYEE_UPLOAD_DIR ?? path.join(process.cwd(), 'uploads', 'employees'));

const MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', pdf: 'application/pdf',
};

/** Streams a stored employee file. Only paths inside the upload root are served. */
export async function GET(request: Request) {
  try {
    const actor = await actorFor(request, {csrf: false});
    assertCapability(actor as never, 'employee.read');

    const url = new URL(request.url);
    const requested = decodeURIComponent(url.searchParams.get('path') ?? '');
    const relative = requested.replace(/^\/?uploads\/employees\//, '').replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, relative);
    if (!relative || !resolved.startsWith(`${ROOT}${path.sep}`)) {
      return new Response(JSON.stringify({error: 'INVALID_PATH'}), {
        status: 400, headers: {'content-type': 'application/json'},
      });
    }

    const body = await readFile(resolved);
    const extension = path.extname(resolved).slice(1).toLowerCase();
    return new Response(new Uint8Array(body), {
      status: 200,
      headers: {
        'content-type': MIME[extension] ?? 'application/octet-stream',
        'content-disposition': `inline; filename="${path.basename(resolved)}"`,
        'cache-control': 'private, max-age=300',
      },
    });
  } catch (error) {
    if ((error as {code?: string}).code === 'ENOENT') {
      return new Response(JSON.stringify({error: 'FILE_NOT_FOUND'}), {
        status: 404, headers: {'content-type': 'application/json'},
      });
    }
    return errorResponse(error);
  }
}
