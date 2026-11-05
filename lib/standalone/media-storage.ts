import {resolve, sep} from 'node:path';
import {DomainError} from './db.ts';

/**
 * Root of the persistent media store. Inside the container the compose volume
 * mounts it at `/media`; the worker and this route read the same setting.
 */
export function mediaRoot() {
  return process.env.ALRIFAI_MEDIA_DIR || '/media';
}

/**
 * Resolve a stored relative path and confine it to the media root. A database
 * value is never trusted to escape the mount, even though only the worker
 * writes it.
 */
export function resolveMediaPath(storagePath: string) {
  const root = resolve(mediaRoot());
  const candidate = resolve(root, storagePath);
  if (candidate !== root && !candidate.startsWith(root + sep)) {
    throw new DomainError('MEDIA_PATH_INVALID', 400);
  }
  return candidate;
}

/** A safe filename for Content-Disposition. */
export function attachmentName(filename: string | null, fallback: string) {
  const raw = String(filename ?? '').replace(/[\\/\u0000-\u001f\u007f"]/g, '_').trim();
  return raw.slice(0, 180) || fallback;
}
