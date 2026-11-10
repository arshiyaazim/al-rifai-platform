'use client';

import Link from 'next/link';
import {useEffect, useState} from 'react';
import {toast} from 'sonner';
import {DetailSidebar} from '@/components/standalone/detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {Textarea} from '@/components/ui/textarea';
import {cleanEmployeeName} from '@/lib/display-name';

export type VesselProgram = {
  id: string; mother_vessel: string; lighter_vessel: string; master_name?: string | null;
  master_mobile: string | null; escort_name: string | null; escort_mobile: string | null;
  start_date: string; start_shift: string; end_date: string | null; end_shift: string | null;
  state: string; notes: string | null; created_at?: string; updated_at?: string; event_at?: string | null;
  source_message_id?: string | null; source_chat_jid?: string | null;
  confirmation_message_id?: string | null; confirmation_chat_jid?: string | null;
  confirmation_sender_jid?: string | null; confirmation_account_id?: string | null;
  confirmation_timestamp?: string | null; release_message_id?: string | null;
  release_chat_jid?: string | null; release_sender_jid?: string | null;
  release_account_id?: string | null; release_timestamp?: string | null;
};

export type VesselDetail = {
  program: VesselProgram;
  sources?: Array<{message_id: string; chat_jid: string; source_role: string; text_content: string | null; source_timestamp: string | null; sender_jid?: string | null}>;
  events?: Array<{action: string; actor: string; created_at: string}>;
  confirmationEvidence?: {text_content: string | null; source_timestamp?: string | null} | null;
  releaseEvidence?: {text_content: string | null; source_timestamp?: string | null} | null;
};

const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const when = (value: string | null | undefined) => value ? new Date(value).toISOString().slice(0, 16).replace('T', ' ') : '—';
export const stateTone = (state: string) => state === 'RELEASED' || state === 'COMPLETED' ? 'ok'
  : state === 'CONFIRMED' || state === 'ASSIGNED' || state === 'IN_DUTY' ? 'info'
    : state === 'VOIDED' || state === 'WITHDRAWN' ? 'bad' : '';

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

export function VesselDetailSidebar({
  programId, onClose, onUpdated, onFilterEscort, canCommand, canRelease,
}: {
  programId: string | null;
  onClose: () => void;
  onUpdated?: () => void;
  onFilterEscort?: (mobile: string, name?: string | null) => void;
  canCommand: boolean;
  canRelease: boolean;
}) {
  const [detail, setDetail] = useState<VesselDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [form, setForm] = useState({
    masterMobile: '', escortMobile: '', escortName: '',
    startDate: '', startShift: 'D', endDate: '', endShift: '', notes: '',
  });

  useEffect(() => {
    if (!programId) return;
    const controller = new AbortController();
    fetch(`/api/vessel/${encodeURIComponent(programId)}`, {headers: {accept: 'application/json'}, signal: controller.signal})
      .then((response) => response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((payload: VesselDetail) => { if (!controller.signal.aborted) setDetail(payload); })
      .catch(() => { if (!controller.signal.aborted) toast.error('Program details could not be loaded.', {duration: Infinity}); });
    return () => controller.abort();
  }, [programId]);

  const startEdit = () => {    if (!detail) return;
    const p = detail.program;
    setForm({
      masterMobile: p.master_mobile ?? '',
      escortMobile: p.escort_mobile ?? '', escortName: p.escort_name ?? '',
      startDate: p.start_date ?? '', startShift: p.start_shift ?? 'D',
      endDate: p.end_date ?? '', endShift: p.end_shift ?? '', notes: p.notes ?? '',
    });
    setEditing(true);
  };

  const save = async () => {
    if (!detail) return;
    setSaving(true);
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/vessel/${encodeURIComponent(detail.program.id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          masterMobile: form.masterMobile.trim() || null,
          escortMobile: form.escortMobile.trim() || undefined,
          escortName: form.escortName.trim() || undefined,
          startDate: form.startDate || undefined,
          startShift: form.startShift || undefined,
          endDate: form.endDate || undefined,
          endShift: form.endShift || undefined,
          notes: form.notes.trim() || null,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setDetail(body as VesselDetail);
      setEditing(false);
      toast.success('Program updated.');
      onUpdated?.();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Update failed.', {duration: Infinity});
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!detail) return;
    if (!window.confirm(`Delete ${detail.program.mother_vessel} → ${detail.program.lighter_vessel}? The row is marked VOIDED, never hard-deleted.`)) return;
    setDeleting(true);
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/vessel/${encodeURIComponent(detail.program.id)}`, {
        method: 'DELETE',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({reason: 'Deleted from vessel sidebar'}),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      toast.success('Program voided.');
      onUpdated?.();
      onClose();
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : 'Delete failed.', {duration: Infinity});
    } finally {
      setDeleting(false);
    }
  };

  const loading = Boolean(programId) && !detail;
  const program = detail?.program;
  const orderSource = detail?.sources?.find((source) => source.source_role === 'primary') ?? detail?.sources?.[0];

  return (
    <DetailSidebar
      open={Boolean(programId)}
      onClose={() => { setEditing(false); onClose(); }}
      title={program ? `${program.mother_vessel} → ${program.lighter_vessel}` : 'Program'}
      description={program ? <span className={`pill ${stateTone(program.state)}`}>{program.state}</span> : undefined}
      footer={program ? (
        editing ? (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
            <Button type="button" size="sm" onClick={() => void save()} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          </>
        ) : (
          <>
            <Button type="button" size="sm" variant="outline" onClick={() => { setEditing(false); onClose(); }}>Close</Button>
            {canCommand ? <Button type="button" size="sm" onClick={startEdit}>Edit</Button> : null}
            {program.escort_mobile && onFilterEscort ? (
              <Button type="button" size="sm" variant="outline"
                onClick={() => { onFilterEscort(String(program.escort_mobile), program.escort_name); onClose(); }}>
                All Programs
              </Button>
            ) : (
              <Button asChild size="sm" variant="outline">
                <Link href={program.escort_mobile ? `/vessel?escort_mobile=${encodeURIComponent(program.escort_mobile)}` : '/vessel'}>All Programs</Link>
              </Button>
            )}
            {canCommand && program.state !== 'VOIDED' ? (
              <Button type="button" size="sm" variant="outline" disabled={deleting} onClick={() => void remove()}>
                {deleting ? 'Deleting…' : 'Delete'}
              </Button>
            ) : null}
          </>
        )
      ) : null}
    >
      {loading && !program ? <p className="muted">Loading program…</p> : null}
      {program ? (
        <div className="grid gap-4">
          <section>
            <h4 className="mb-2 text-sm font-semibold">Program</h4>
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Mother Vessel</dt><dd>{program.mother_vessel}</dd>
              <dt className="text-muted-foreground">Lighter Name</dt><dd>{program.lighter_vessel}</dd>
              <dt className="text-muted-foreground">Master Name</dt>
              <dd>{dash(program.master_name)}</dd>
              <dt className="text-muted-foreground">Master Mobile</dt>
              <dd>{editing ? <Input value={form.masterMobile} onChange={(e) => setForm({...form, masterMobile: e.target.value})} /> : dash(program.master_mobile)}</dd>
              <dt className="text-muted-foreground">Escort Name</dt>
              <dd>{editing ? <Input value={form.escortName} onChange={(e) => setForm({...form, escortName: e.target.value})} /> : cleanEmployeeName(program.escort_name)}</dd>
              <dt className="text-muted-foreground">Escort Mobile</dt>
              <dd>{editing ? <Input value={form.escortMobile} onChange={(e) => setForm({...form, escortMobile: e.target.value})} /> : dash(program.escort_mobile)}</dd>
              <dt className="text-muted-foreground">Event Date</dt>
              <dd>{program.event_at ? new Date(program.event_at).toLocaleDateString('en-GB', {timeZone: 'Asia/Dhaka'}).replaceAll('/', '-') : '—'}</dd>
              <dt className="text-muted-foreground">Start</dt>
              <dd>{editing ? (
                <span className="flex gap-2"><Input type="date" value={form.startDate} onChange={(e) => setForm({...form, startDate: e.target.value})} />
                  <select value={form.startShift} onChange={(e) => setForm({...form, startShift: e.target.value})} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="D">D</option><option value="N">N</option></select></span>
              ) : `${program.start_date} · ${program.start_shift}`}</dd>
              <dt className="text-muted-foreground">End</dt>
              <dd>{editing ? (
                <span className="flex gap-2"><Input type="date" value={form.endDate} onChange={(e) => setForm({...form, endDate: e.target.value})} />
                  <select value={form.endShift} onChange={(e) => setForm({...form, endShift: e.target.value})} className="h-9 rounded-md border bg-background px-2 text-sm"><option value="">—</option><option value="D">D</option><option value="N">N</option></select></span>
              ) : program.end_date ? `${program.end_date} · ${program.end_shift}` : '—'}</dd>
              <dt className="text-muted-foreground">Notes</dt>
              <dd>{editing ? <Textarea rows={2} value={form.notes} onChange={(e) => setForm({...form, notes: e.target.value})} /> : dash(program.notes)}</dd>
            </dl>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Order provenance</h4>
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Timestamp</dt><dd>{when(orderSource?.source_timestamp)}</dd>
              <dt className="text-muted-foreground">Sender</dt><dd>{dash(orderSource?.sender_jid)}</dd>
              <dt className="text-muted-foreground">Chat</dt><dd style={{overflowWrap: 'anywhere'}}>{dash(orderSource?.chat_jid ?? program.source_chat_jid)}</dd>
              <dt className="text-muted-foreground">Source message</dt><dd style={{overflowWrap: 'anywhere'}}>{dash(orderSource?.message_id ?? program.source_message_id)}</dd>
              <dt className="text-muted-foreground">Original text</dt><dd style={{whiteSpace: 'pre-wrap'}}>{dash(orderSource?.text_content)}</dd>
            </dl>
          </section>

          <section>
            <h4 className="mb-2 text-sm font-semibold">Confirmation provenance</h4>
            <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Timestamp</dt><dd>{when(program.confirmation_timestamp)}</dd>
              <dt className="text-muted-foreground">Sender</dt><dd>{dash(program.confirmation_sender_jid)}</dd>
              <dt className="text-muted-foreground">Chat</dt><dd style={{overflowWrap: 'anywhere'}}>{dash(program.confirmation_chat_jid)}</dd>
              <dt className="text-muted-foreground">Account</dt><dd>{dash(program.confirmation_account_id)}</dd>
              <dt className="text-muted-foreground">Message text</dt><dd style={{whiteSpace: 'pre-wrap'}}>{dash(detail?.confirmationEvidence?.text_content)}</dd>
            </dl>
          </section>

          {program.state === 'RELEASED' || program.release_message_id ? (
            <section>
              <h4 className="mb-2 text-sm font-semibold">Release provenance</h4>
              <dl className="grid grid-cols-[140px_1fr] gap-x-3 gap-y-2 text-sm">
                <dt className="text-muted-foreground">Timestamp</dt><dd>{when(program.release_timestamp)}</dd>
                <dt className="text-muted-foreground">Sender</dt><dd>{dash(program.release_sender_jid)}</dd>
                <dt className="text-muted-foreground">Chat</dt><dd style={{overflowWrap: 'anywhere'}}>{dash(program.release_chat_jid)}</dd>
                <dt className="text-muted-foreground">Account</dt><dd>{dash(program.release_account_id)}</dd>
                <dt className="text-muted-foreground">Message text</dt><dd style={{whiteSpace: 'pre-wrap'}}>{dash(detail?.releaseEvidence?.text_content)}</dd>
              </dl>
            </section>
          ) : null}

          <section>
            <h4 className="mb-2 text-sm font-semibold">Recent events</h4>
            <ul className="grid gap-1 text-xs">
              {(detail?.events ?? []).slice(-8).map((event, index) => (
                <li key={`${event.action}-${index}`} className="flex justify-between gap-2 border-b py-1">
                  <span>{event.action}</span><span className="text-muted-foreground">{when(event.created_at)}</span>
                </li>
              ))}
              {!detail?.events?.length ? <li className="text-muted-foreground">No events recorded.</li> : null}
            </ul>
          </section>
          {!canRelease && editing ? <p className="text-xs text-muted-foreground">Release fields require vessel.release.</p> : null}
        </div>
      ) : null}
    </DetailSidebar>
  );
}
