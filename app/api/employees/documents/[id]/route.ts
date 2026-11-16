import {unlink} from 'node:fs/promises';
import path from 'node:path';
import {actorFor, errorResponse, ok} from '../../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {deleteEmployeeDocument} from '@/lib/standalone/employees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ROOT = path.resolve(process.env.EMPLOYEE_UPLOAD_DIR ?? path.join(process.cwd(), 'uploads', 'employees'));

/** Removes a document row and its file. The DB row is the source of truth. */
export async function DELETE(request: Request, context: {params: Promise<{id: string}>}) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'employee.manage');
    const {id} = await context.params;
    const document = await deleteEmployeeDocument(actor as never, decodeURIComponent(id));

    const relative = document.file_path.replace(/^\/?uploads\/employees\//, '').replace(/^\/+/, '');
    const resolved = path.resolve(ROOT, relative);
    if (relative && resolved.startsWith(`${ROOT}${path.sep}`)) {
      await unlink(resolved).catch(() => undefined);
    }
    return ok({deleted: true, id: document.id});
  } catch (error) {
    return errorResponse(error);
  }
}
