'use client';

import {useRef, useState} from 'react';
import {toast} from 'sonner';
import {FileText, Trash2, Upload, UserRound} from 'lucide-react';
import {Button} from '@/components/ui/button';

export type EmployeeDoc = {
  id: string;
  employee_mobile: string;
  file_name: string;
  file_path: string;
  file_type: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  created_at: string;
};

export const employeeFileUrl = (filePath?: string | null) =>
  filePath ? `/api/employees/file?path=${encodeURIComponent(filePath)}` : '';

export async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  const body = await response.json().catch(() => ({}));
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf as string;
}

/** Uploads one file for an existing employee. Errors carry the server code. */
export async function uploadEmployeeFile(
  employeeMobile: string, file: File, fileType: 'photo' | 'document', token: string,
): Promise<{url: string; file_name: string; document?: EmployeeDoc}> {
  const body = new FormData();
  body.append('employee_mobile', employeeMobile);
  body.append('file_type', fileType);
  body.append('file', file);
  const response = await fetch('/api/employees/upload', {
    method: 'POST', credentials: 'same-origin', headers: {'X-CSRF-Token': token}, body,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP_${response.status}`);
  return payload as {url: string; file_name: string; document?: EmployeeDoc};
}

const sizeLabel = (bytes: number | null) =>
  bytes ? `${(bytes / 1024 / 1024).toFixed(2)} MB` : '';

/**
 * Photo + documents block shared by the create form, the edit form and the
 * view sidebar. In create mode (`mobile` is null) files are queued and the
 * parent uploads them right after the employee exists.
 */
export function EmployeeFileFields({
  mobile, photoUrl, documents, editable, onChanged, onPending,
}: {
  mobile: string | null;
  photoUrl: string | null;
  documents: EmployeeDoc[];
  editable: boolean;
  onChanged?: () => void;
  onPending?: (files: {photo: File | null; documents: File[]}) => void;
}) {
  const photoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const [pendingPhoto, setPendingPhoto] = useState<File | null>(null);
  const [pendingDocs, setPendingDocs] = useState<File[]>([]);
  const [busy, setBusy] = useState('');
  const [preview, setPreview] = useState<string | null>(null);

  const pushPending = (photo: File | null, docs: File[]) => onPending?.({photo, documents: docs});

  async function send(file: File, fileType: 'photo' | 'document') {
    if (!mobile) return;
    setBusy(`Uploading ${file.name}…`);
    try {
      const token = await csrfToken();
      await uploadEmployeeFile(mobile, file, fileType, token);
      toast.success(`${file.name} uploaded.`);
      onChanged?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Upload failed.', {duration: Infinity});
    } finally {
      setBusy('');
    }
  }

  async function removeDocument(document: EmployeeDoc) {
    if (!window.confirm(`Remove ${document.file_name}?`)) return;
    setBusy('Removing…');
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/employees/documents/${encodeURIComponent(document.id)}`, {
        method: 'DELETE', credentials: 'same-origin', headers: {'X-CSRF-Token': token},
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `HTTP_${response.status}`);
      toast.success('Document removed.');
      onChanged?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Remove failed.', {duration: Infinity});
    } finally {
      setBusy('');
    }
  }

  const shownPhoto = preview ?? employeeFileUrl(photoUrl);

  return (
    <div className="grid gap-3">
      <div className="flex items-center gap-3">
        {shownPhoto ? (
          // eslint-disable-next-line @next/next/no-img-element -- private uploads are served through an auth route.
          <img src={shownPhoto} alt="Profile photo" width={80} height={80}
            style={{width: 80, height: 80, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)'}} />
        ) : (
          <div aria-hidden="true" style={{width: 80, height: 80, borderRadius: 8, border: '1px dashed var(--line)',
            display: 'grid', placeItems: 'center', color: 'var(--muted)'}}>
            <UserRound className="size-7" />
          </div>
        )}
        <div className="grid gap-1">
          <span className="text-sm font-semibold">Profile Photo</span>
          <input ref={photoInput} type="file" accept="image/*" hidden
            onChange={(event) => {
              const file = event.target.files?.[0] ?? null;
              event.target.value = '';
              if (!file) return;
              if (!mobile) { setPendingPhoto(file); setPreview(URL.createObjectURL(file)); pushPending(file, pendingDocs); return; }
              void send(file, 'photo');
            }} />
          {editable ? (
            <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)}
              onClick={() => photoInput.current?.click()}>
              <Upload className="size-4" /> {shownPhoto ? 'Replace photo' : 'Profile Photo'}
            </Button>
          ) : null}
          {!mobile && pendingPhoto ? (
            <span className="muted" style={{fontSize: 11}}>{pendingPhoto.name} · uploads on save
              <button type="button" aria-label="Cancel photo" style={{marginLeft: 6}}
                onClick={() => { setPendingPhoto(null); setPreview(null); pushPending(null, pendingDocs); }}>×</button>
            </span>
          ) : null}
        </div>
      </div>

      <div className="grid gap-1">
        <span className="text-sm font-semibold">Documents</span>
        <input ref={docInput} type="file" accept="image/*,.pdf" multiple hidden
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = '';
            if (!files.length) return;
            if (!mobile) {
              const next = [...pendingDocs, ...files];
              setPendingDocs(next);
              pushPending(pendingPhoto, next);
              return;
            }
            for (const file of files) void send(file, 'document');
          }} />
        {editable ? (
          <Button type="button" size="sm" variant="outline" disabled={Boolean(busy)}
            onClick={() => docInput.current?.click()}>
            <Upload className="size-4" /> {mobile ? 'Upload documents' : 'Documents'}
          </Button>
        ) : null}
        {busy ? <span className="muted" style={{fontSize: 11}}>{busy}</span> : null}

        <ul style={{listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4}}>
          {documents.map((document) => (
            <li key={document.id} style={{display: 'flex', gap: 8, alignItems: 'center', fontSize: 12}}>
              <FileText className="size-4" />
              <a href={employeeFileUrl(document.file_path)} target="_blank" rel="noreferrer">{document.file_name}</a>
              <span className="muted">{sizeLabel(document.file_size_bytes)}</span>
              {editable ? (
                <button type="button" aria-label={`Remove ${document.file_name}`} disabled={Boolean(busy)}
                  onClick={() => void removeDocument(document)}><Trash2 className="size-4" /></button>
              ) : null}
            </li>
          ))}
          {!documents.length && !pendingDocs.length ? <li className="muted">No documents uploaded.</li> : null}
          {!mobile && pendingDocs.map((file, index) => (
            <li key={`${file.name}-${index}`} style={{display: 'flex', gap: 8, alignItems: 'center', fontSize: 12}}>
              <FileText className="size-4" /> {file.name}
              <span className="muted">uploads on save</span>
              <button type="button" aria-label={`Cancel ${file.name}`}
                onClick={() => {
                  const next = pendingDocs.filter((_, position) => position !== index);
                  setPendingDocs(next);
                  pushPending(pendingPhoto, next);
                }}>×</button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
