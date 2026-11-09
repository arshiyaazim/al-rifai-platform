'use client';

import Link from 'next/link';
import {useRouter} from 'next/navigation';
import {useEffect, useMemo, useRef, useState} from 'react';
import {MoreHorizontal, Search, X} from 'lucide-react';
import {toast} from 'sonner';
import {AppToaster} from '@/components/standalone/app-toaster';
import {VesselDetailSidebar} from '@/components/standalone/vessel-detail-sidebar';
import {Button} from '@/components/ui/button';
import {Input} from '@/components/ui/input';
import {cleanEmployeeName} from '@/lib/display-name';

export type DraftInlineRow = {
  id: string;
  mother_vessel: string;
  lighter_vessel: string;
  master_mobile?: string | null;
  start_date: string;
  start_shift: string;
  created_at?: string | null;
  source_chat_jid?: string | null;
  escort_name?: string | null;
  escort_mobile?: string | null;
  state: string;
};

type Escort = {mobile: string; name: string};

async function csrfToken(): Promise<string> {
  const response = await fetch('/api/auth/session', {credentials: 'same-origin', cache: 'no-store'});
  if (!response.ok) throw new Error('SESSION_EXPIRED');
  const body = await response.json() as {csrf?: string};
  if (!body.csrf) throw new Error('SESSION_EXPIRED');
  return body.csrf;
}

function dhaka(value: string | null | undefined) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', dateStyle: 'short', timeStyle: 'short',
  }).format(new Date(value));
}

/**
 * Compact inline Escort assignment for the DRAFT table. The full detail
 * sidebar remains available from the row action for all other edits.
 */
export function DraftInlineAssign({
  drafts, escorts, duplicates, canCommand = true,
}: {
  drafts: DraftInlineRow[];
  escorts: Escort[];
  duplicates: Record<string, Array<{id: string; start_date: string}>>;
  canCommand?: boolean;
}) {
  const router = useRouter();
  const [assigned, setAssigned] = useState<Record<string, {name: string; mobile: string}>>({});
  const [editingId, setEditingId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Escort | null>(null);
  const [saving, setSaving] = useState<string | null>(null);
  const [selectedProgram, setSelectedProgram] = useState<string | null>(null);
  const popover = useRef<HTMLDivElement>(null);

  const rows = drafts.map((row) => {
    const local = assigned[row.id];
    return local ? {...row, escort_name: local.name, escort_mobile: local.mobile, state: 'ASSIGNED'} : row;
  });

  useEffect(() => {
    if (!editingId) return;
    const onPointer = (event: PointerEvent) => {
      if (popover.current && !popover.current.contains(event.target as Node)) {
        setEditingId(null);
        setPicked(null);
        setQuery('');
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setEditingId(null);
        setPicked(null);
        setQuery('');
      }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [editingId]);

  const matches = useMemo(() => {
    const text = query.trim().toLowerCase();
    const list = text
      ? escorts.filter((escort) => escort.name.toLowerCase().includes(text) || escort.mobile.includes(text))
      : escorts;
    return list.slice(0, 12);
  }, [escorts, query]);

  const start = (row: DraftInlineRow) => {
    setEditingId(row.id);
    setPicked(null);
    setQuery('');
  };

  const confirm = async (row: DraftInlineRow) => {
    if (!picked) return;
    setSaving(row.id);
    try {
      const token = await csrfToken();
      const response = await fetch(`/api/vessel/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: {'Content-Type': 'application/json', 'X-CSRF-Token': token},
        body: JSON.stringify({
          escortMobile: picked.mobile,
          escortName: picked.name,
          startDate: row.start_date,
          startShift: row.start_shift,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
      setAssigned((current) => ({...current, [row.id]: {name: picked.name, mobile: picked.mobile}}));
      toast.success(`Escort assigned to ${row.lighter_vessel}.`);
      setEditingId(null);
      setPicked(null);
      setQuery('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Escort assignment failed.', {duration: Infinity});
    } finally {
      setSaving(null);
    }
  };

  return (
    <>
      <AppToaster />
      <div style={{overflowX: 'auto'}}>
        <table>
          <thead><tr><th>Mother</th><th>Lighter</th><th>Master</th><th>Start</th><th>Order timestamp</th><th>Client chat</th><th>Duplicates</th><th>Escort</th><th>Open</th></tr></thead>
          <tbody>
            {rows.map((row) => {
              const rowDuplicates = duplicates[row.id] ?? [];
              const assigned = Boolean(row.escort_mobile);
              return (
                <tr key={row.id}>
                  <td>{row.mother_vessel}</td>
                  <td>{row.lighter_vessel}</td>
                  <td>{row.master_mobile ?? '—'}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{row.start_date} · {row.start_shift}</td>
                  <td style={{whiteSpace: 'nowrap'}}>{dhaka(row.created_at)}</td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{row.source_chat_jid ?? '—'}</td>
                  <td>{rowDuplicates.length ? rowDuplicates.map((candidate) => (
                    <div key={candidate.id}><Link href={`/vessel/${encodeURIComponent(candidate.id)}`}>{candidate.start_date}</Link></div>
                  )) : <span className="muted">none</span>}</td>
                  <td className="draft-inline-cell">
                    {editingId === row.id ? (
                      <div className="inline-assign" ref={popover}>
                        {picked ? (
                          <div className="inline-assign__picked">
                            <span>{picked.name} · {picked.mobile}</span>
                            <Button type="button" size="sm" onClick={() => void confirm(row)} disabled={saving === row.id}>
                              {saving === row.id ? 'Saving…' : 'Confirm'}
                            </Button>
                            <Button type="button" size="icon-sm" variant="ghost" aria-label="Change escort" onClick={() => setPicked(null)}>
                              <X className="size-4" />
                            </Button>
                          </div>
                        ) : (
                          <>
                            <div className="inline-assign__search">
                              <Search className="size-3.5" aria-hidden="true" />
                              <Input
                                autoFocus
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder="Type escort name or mobile"
                                aria-label={`Assign escort to ${row.lighter_vessel}`}
                              />
                            </div>
                            <div className="inline-assign__list" role="listbox">
                              {matches.map((escort) => (
                                <button type="button" key={escort.mobile} role="option" aria-selected="false" onClick={() => setPicked(escort)}>
                                  <span>{escort.name}</span><small>{escort.mobile}</small>
                                </button>
                              ))}
                              {!matches.length ? <p className="muted">No active escort matches.</p> : null}
                            </div>
                          </>
                        )}
                      </div>
                    ) : assigned ? (
                      <span className="inline-assign__assigned">
                        {cleanEmployeeName(row.escort_name)}<small>{row.escort_mobile}</small>
                        {canCommand ? <button type="button" className="link-button" onClick={() => start(row)}>change</button> : null}
                      </span>
                    ) : canCommand ? (
                      <button type="button" className="inline-assign__add" onClick={() => start(row)}>+ Assign</button>
                    ) : <span className="muted">—</span>}
                  </td>
                  <td>
                    <div className="row" style={{gap: 4}}>
                      <Link href={`/vessel/${encodeURIComponent(row.id)}`}>Open →</Link>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Details for ${row.lighter_vessel}`} onClick={() => setSelectedProgram(row.id)}>
                        <MoreHorizontal className="size-4" />
                      </Button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!rows.length ? <tr><td colSpan={9} className="muted">No DRAFT programs.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <VesselDetailSidebar
        key={selectedProgram ?? 'none'}
        programId={selectedProgram}
        onClose={() => setSelectedProgram(null)}
        onUpdated={() => router.refresh()}
        canCommand={canCommand}
        canRelease={false}
      />
    </>
  );
}
