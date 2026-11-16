import {mkdir, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {actorFor, errorResponse, ok} from '../../_shared';
import {assertCapability} from '@/lib/standalone/authz';
import {
  addEmployeeDocument, employeeProfileExtensions, setEmployeePhoto,
} from '@/lib/standalone/employees';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Root of the employee upload tree. Override with EMPLOYEE_UPLOAD_DIR (volume). */
const EMPLOYEE_UPLOAD_ROOT = process.env.EMPLOYEE_UPLOAD_DIR
  ?? path.join(process.cwd(), 'uploads', 'employees');

const MAX_BYTES = 10 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const DOCUMENT_TYPES = new Set([...IMAGE_TYPES, 'application/pdf']);
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'application/pdf': 'pdf',
};

/** `01XXXXXXXXX` / `8801XXXXXXXXX` → `+8801XXXXXXXXX`; anything else is rejected. */
function normalizeMobile(raw: string): string | null {
  const digits = raw.replace(/\D/g, '');
  if (/^01[3-9]\d{8}$/.test(digits)) return `+880${digits.slice(1)}`;
  if (/^8801[3-9]\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export async function POST(request: Request) {
  try {
    const actor = await actorFor(request);
    assertCapability(actor as never, 'employee.manage');
    const extensions = await employeeProfileExtensions();
    if (!extensions.photo && !extensions.documents) {
      return ok({error: 'EMPLOYEE_FILES_NOT_MIGRATED'}, 409);
    }

    const form = await request.formData();
    const file = form.get('file');
    const rawMobile = String(form.get('employee_mobile') ?? '');
    const fileType = String(form.get('file_type') ?? 'document');
    if (!(file instanceof File)) return ok({error: 'FILE_REQUIRED'}, 400);
    if (fileType !== 'photo' && fileType !== 'document') return ok({error: 'INVALID_FILE_TYPE'}, 400);

    const employeeMobile = normalizeMobile(rawMobile);
    if (!employeeMobile) return ok({error: 'INVALID_EMPLOYEE_MOBILE'}, 400);
    if (file.size > MAX_BYTES) return ok({error: 'FILE_TOO_LARGE', maxBytes: MAX_BYTES}, 413);

    const allowed = fileType === 'photo' ? IMAGE_TYPES : DOCUMENT_TYPES;
    if (!allowed.has(file.type)) return ok({error: 'UNSUPPORTED_MIME_TYPE', mimeType: file.type}, 415);

    const extension = EXTENSIONS[file.type] ?? 'bin';
    const fileName = `${fileType === 'photo' ? 'photo' : 'doc'}-${randomUUID()}.${extension}`;
    const folder = path.join(EMPLOYEE_UPLOAD_ROOT, employeeMobile);
    await mkdir(folder, {recursive: true});
    await writeFile(path.join(folder, fileName), Buffer.from(await file.arrayBuffer()));

    const publicPath = `/uploads/employees/${employeeMobile}/${fileName}`;
    const payload: Record<string, unknown> = {
      url: publicPath, file_name: file.name || fileName, file_size_bytes: file.size, file_type: fileType,
    };

    if (fileType === 'photo') {
      if (!extensions.photo) return ok({error: 'EMPLOYEE_PHOTO_NOT_MIGRATED'}, 409);
      await setEmployeePhoto(actor as never, employeeMobile, publicPath);
    } else {
      if (!extensions.documents) return ok({error: 'EMPLOYEE_DOCUMENTS_NOT_MIGRATED'}, 409);
      const document = await addEmployeeDocument(actor as never, {
        employeeMobile,
        fileName: file.name || fileName,
        filePath: publicPath,
        fileType: extension === 'pdf' ? 'pdf' : 'image',
        mimeType: file.type,
        fileSizeBytes: file.size,
      });
      payload.document = document;
    }

    return ok(payload, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
