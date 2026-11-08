'use client';

import Link from 'next/link';
import {useMemo, useState, type ReactNode} from 'react';
import {ActionForm} from '@/components/standalone/action-form';
import type {CallRow, MessageRow} from '@/lib/standalone/messages';

type Column = {
  key: string;
  label: string;
  group: string;
  defaultVisible?: boolean;
  width?: number;
  value: (row: MessageRow) => ReactNode;
  text: (row: MessageRow) => string;
};

const NOT_AVAILABLE = 'NOT_AVAILABLE';
const dash = (value: unknown) => value === null || value === undefined || value === '' ? '—' : String(value);
const unavailable = (value: unknown) => {
  const text = dash(value);
  return text === '—' || text === NOT_AVAILABLE ? <span className="muted">{text === '—' ? NOT_AVAILABLE : text}</span> : text;
};
const pill = (value: string | null | undefined, tone?: string) => value
  ? <span className={`pill ${tone ?? ''}`}>{value}</span>
  : <span className="muted">{NOT_AVAILABLE}</span>;

function mediaLink(row: MessageRow) {
  const search = new URLSearchParams({account: row.account_id, chat: row.chat_jid, message: row.message_id});
  return `/api/media?${search.toString()}`;
}

const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'ESCORT_CLIENT', 'ESCORT', 'EMPLOYEE', 'SUPPLIER', 'CUSTOMER', 'UNKNOWN'];
const DOMAINS = ['CASH', 'VESSEL', 'SECURITY', 'HR', 'PAYROLL', 'OPERATIONS', 'PERSONAL', 'GENERAL', 'UNKNOWN'];
const REVIEWS = ['UNREVIEWED', 'CONFIRMED', 'CORRECTED', 'REJECTED'];

const columns: Column[] = [
  {key: 'dhaka_time', label: 'Message Time', group: 'Time', defaultVisible: true, width: 190,
    value: (r) => `${r.dhaka_date} ${r.dhaka_time}`, text: (r) => `${r.dhaka_date} ${r.dhaka_time}`},
  {key: 'message_date', label: 'Message Date', group: 'Time', value: (r) => r.dhaka_date, text: (r) => r.dhaka_date},
  {key: 'message_time', label: 'Message Time (clock)', group: 'Time', value: (r) => r.dhaka_time, text: (r) => r.dhaka_time},
  {key: 'source_timestamp', label: 'Message Timestamp (event)', group: 'Time', value: (r) => r.source_timestamp, text: (r) => r.source_timestamp},
  {key: 'created_at', label: 'Ingested At', group: 'Time', value: (r) => r.created_at, text: (r) => r.created_at},
  {key: 'mirrored_at', label: 'Mirrored At', group: 'Time', value: (r) => r.mirrored_at, text: (r) => r.mirrored_at},
  {key: 'account_id', label: 'Account / Bridge', group: 'Identity', defaultVisible: true, width: 110,
    value: (r) => r.account_id, text: (r) => r.account_id},
  {key: 'whatsapp_account_id', label: 'WhatsApp Account ID', group: 'Identity', value: (r) => unavailable(r.whatsapp_account_id), text: (r) => dash(r.whatsapp_account_id)},
  {key: 'message_id', label: 'Message ID', group: 'Identity', value: (r) => r.message_id, text: (r) => r.message_id},
  {key: 'chat_jid', label: 'Chat JID', group: 'Conversation', value: (r) => r.chat_jid, text: (r) => r.chat_jid},
  {key: 'sender_jid', label: 'Sender JID', group: 'Identity', value: (r) => unavailable(r.sender_jid), text: (r) => dash(r.sender_jid)},
  {key: 'direction', label: 'Direction', group: 'Message', defaultVisible: true, value: (r) => pill(r.direction, r.direction === 'INCOMING' ? '' : 'ok'), text: (r) => r.direction},
  {key: 'sender_display_name', label: 'Sender Name', group: 'Names', defaultVisible: true, width: 200,
    value: (r) => unavailable(r.sender_display_name), text: (r) => r.sender_display_name},
  {key: 'sender_saved_name', label: 'Sender Saved Name', group: 'Names', value: (r) => unavailable(r.sender_saved_name), text: (r) => r.sender_saved_name},
  {key: 'my_contact_name', label: 'My Contact Name', group: 'Names', defaultVisible: true, value: (r) => unavailable(r.my_contact_name), text: (r) => r.my_contact_name},
  {key: 'whatsapp_push_name', label: 'WhatsApp Profile / Push Name', group: 'Names', value: (r) => unavailable(r.whatsapp_push_name), text: (r) => r.whatsapp_push_name},
  {key: 'sender_mobile', label: 'Mobile Number', group: 'Identity', defaultVisible: true, value: (r) => unavailable(r.sender_mobile), text: (r) => dash(r.sender_mobile)},
  {key: 'sender_country_code', label: 'Country Code', group: 'Identity', value: (r) => unavailable(r.sender_country_code), text: (r) => r.sender_country_code},
  {key: 'sender_identity_status', label: 'Sender Identity Status', group: 'Identity', value: (r) => pill(r.sender_identity_status, r.sender_identity_status === 'EXACT' ? 'ok' : r.sender_identity_status === 'UNRESOLVED' ? 'bad' : ''), text: (r) => r.sender_identity_status},
  {key: 'identity_role', label: 'Identity Role', group: 'Business', defaultVisible: true, value: (r) => pill(r.identity_role), text: (r) => r.identity_role},
  {key: 'identity_role_source', label: 'Role Source', group: 'Business', value: (r) => r.identity_role_source, text: (r) => r.identity_role_source},
  {key: 'sender_canonical_jid', label: 'Canonical JID', group: 'Identity', value: (r) => unavailable(r.sender_canonical_jid), text: (r) => dash(r.sender_canonical_jid)},
  {key: 'sender_person_key', label: 'Canonical Person ID', group: 'Identity', value: (r) => unavailable(r.sender_person_key), text: (r) => dash(r.sender_person_key)},
  {key: 'pn_jid', label: 'PN JID', group: 'Identity', value: (r) => unavailable(r.pn_jid), text: (r) => dash(r.pn_jid)},
  {key: 'lid_jid', label: 'LID / WhatsApp Identity', group: 'Identity', value: (r) => unavailable(r.lid_jid), text: (r) => dash(r.lid_jid)},
  {key: 'sender_original_jid', label: 'Original Mobile / JID', group: 'Identity', value: (r) => unavailable(r.sender_original_jid), text: (r) => dash(r.sender_original_jid)},
  {key: 'identity_resolution_method', label: 'Identity Resolution Method', group: 'Identity', value: (r) => r.identity_resolution_method, text: (r) => r.identity_resolution_method},
  {key: 'identity_confidence', label: 'Identity Confidence', group: 'Identity', value: (r) => pill(r.identity_confidence, r.identity_confidence === 'EXACT' ? 'ok' : r.identity_confidence === 'UNRESOLVED' ? 'bad' : ''), text: (r) => r.identity_confidence},
  {key: 'identity_verification_status', label: 'Identity Verification', group: 'Identity', value: (r) => r.identity_verification_status, text: (r) => r.identity_verification_status},
  {key: 'group_name', label: 'Group Name', group: 'Conversation', defaultVisible: true, value: (r) => r.group_name ? r.group_name : <span className="muted">—</span>, text: (r) => r.group_name ?? '—'},
  {key: 'chat_name', label: 'Chat Name', group: 'Conversation', value: (r) => r.chat_name, text: (r) => r.chat_name},
  {key: 'chat_type', label: 'Chat Type', group: 'Conversation', value: (r) => r.chat_type, text: (r) => r.chat_type},
  {key: 'chat_identity_status', label: 'Chat Identity Status', group: 'Conversation', value: (r) => pill(r.chat_identity_status, r.chat_identity_status === 'EXACT' ? 'ok' : r.chat_identity_status === 'UNRESOLVED' ? 'bad' : ''), text: (r) => dash(r.chat_identity_status)},
  {key: 'chat_jid_original', label: 'Original Conversation ID', group: 'Conversation', value: (r) => r.chat_jid_original, text: (r) => r.chat_jid_original},
  {key: 'group_participant_identity', label: 'Group Participant Identity', group: 'Conversation', value: (r) => unavailable(r.group_participant_identity), text: (r) => dash(r.group_participant_identity)},
  {key: 'group_participant_jid', label: 'Group Participant JID', group: 'Conversation', value: (r) => unavailable(r.group_participant_jid), text: (r) => dash(r.group_participant_jid)},
  {key: 'message_type', label: 'Message Type', group: 'Message', value: (r) => r.message_type, text: (r) => r.message_type},
  {key: 'text_content', label: 'Message Content', group: 'Message', defaultVisible: true, width: 360,
    value: (r) => r.text_content ? <span style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>{r.text_content}</span> : <span className="muted">[{r.message_type}]</span>, text: (r) => r.text_content ?? ''},
  {key: 'media_filename', label: 'Media Filename', group: 'Media', value: (r) => unavailable(r.media_filename), text: (r) => dash(r.media_filename)},
  {key: 'media_mime_type', label: 'Media MIME Type', group: 'Media', value: (r) => unavailable(r.media_mime_type), text: (r) => dash(r.media_mime_type)},
  {key: 'media_sha256', label: 'Media SHA-256', group: 'Media', value: (r) => unavailable(r.media_sha256), text: (r) => dash(r.media_sha256)},
  {key: 'media_length', label: 'Media Length', group: 'Media', value: (r) => unavailable(r.media_length), text: (r) => dash(r.media_length)},
  {key: 'media_status', label: 'Media Status', group: 'Media', defaultVisible: true, value: (r) => {
      if (r.media_status === 'STORED') return <a className="pill ok" href={mediaLink(r)} target="_blank" rel="noreferrer">STORED</a>;
      if (r.media_status === 'FAILED') return <span className="pill bad">FAILED</span>;
      if (r.media_status === 'SKIPPED') return <span className="pill">SKIPPED</span>;
      if (r.media_status === 'MISSING') return <span className="pill bad">MISSING</span>;
      return <span className="pill">NOT_APPLICABLE</span>;
    }, text: (r) => r.media_status},
  {key: 'media_error', label: 'Media Error', group: 'Media', value: (r) => unavailable(r.media_error), text: (r) => dash(r.media_error)},
  {key: 'quoted_message_id', label: 'Quoted / Replied Message ID', group: 'Message', value: (r) => unavailable(r.quoted_message_id), text: (r) => dash(r.quoted_message_id)},
  {key: 'deleted_at', label: 'Deleted / Revoked', group: 'Message', value: (r) => r.deleted_at ? <span className="pill bad">REVOKED</span> : <span className="muted">NO</span>, text: (r) => r.deleted_at ?? 'NO'},
  {key: 'call_trace_id', label: 'Call Trace ID', group: 'Calls', value: (r) => unavailable(r.call_trace_id), text: (r) => dash(r.call_trace_id)},
  {key: 'call_type', label: 'Call Type', group: 'Calls', value: (r) => r.call_type, text: (r) => r.call_type},
  {key: 'call_direction', label: 'Call Direction', group: 'Calls', value: (r) => r.call_direction, text: (r) => r.call_direction},
  {key: 'call_status', label: 'Call Status', group: 'Calls', value: (r) => r.call_status, text: (r) => r.call_status},
  {key: 'call_event_timestamp', label: 'Call Event Timestamp', group: 'Calls', value: (r) => unavailable(r.call_event_timestamp), text: (r) => dash(r.call_event_timestamp)},
  {key: 'missed_call_trace_id', label: 'Missed Call Trace ID', group: 'Calls', value: (r) => unavailable(r.missed_call_trace_id), text: (r) => dash(r.missed_call_trace_id)},
  {key: 'missed_call_status', label: 'Missed Call Status', group: 'Calls', value: (r) => r.missed_call_status, text: (r) => r.missed_call_status},
  {key: 'related_chat', label: 'Related Chat / Conversation', group: 'Calls', value: (r) => r.related_chat, text: (r) => r.related_chat},
  {key: 'business_domain', label: 'Business Domain', group: 'Business', defaultVisible: true, value: (r) => pill(r.business_domain), text: (r) => r.business_domain},
  {key: 'business_domain_source', label: 'Domain Source', group: 'Business', value: (r) => r.business_domain_source, text: (r) => r.business_domain_source},
  {key: 'message_classification', label: 'Message Classification', group: 'Business', value: (r) => unavailable(r.message_classification), text: (r) => dash(r.message_classification)},
  {key: 'processing_status', label: 'Processing Status', group: 'Business', value: (r) => pill(r.processing_status, r.processing_status === 'COMPLETED' ? 'ok' : r.processing_status === 'FAILED' ? 'bad' : ''), text: (r) => r.processing_status},
  {key: 'review_status', label: 'Review Status', group: 'Business', value: (r) => pill(r.review_status, r.review_status === 'REVIEW_REQUIRED' ? 'warn' : r.review_status === 'PROCESSED' ? 'ok' : ''), text: (r) => r.review_status},
  {key: 'original_source', label: 'Original Source / Provenance', group: 'Provenance', value: (r) => r.original_source, text: (r) => r.original_source},
  {key: 'source_rowid', label: 'Source Row ID', group: 'Provenance', value: (r) => unavailable(r.source_rowid), text: (r) => dash(r.source_rowid)},
  {key: 'import_run_id', label: 'Import Run ID', group: 'Provenance', value: (r) => unavailable(r.import_run_id), text: (r) => dash(r.import_run_id)},
  {key: 'source_sha256', label: 'Source SHA-256', group: 'Provenance', value: (r) => unavailable(r.source_sha256), text: (r) => dash(r.source_sha256)},
];

const defaultVisible = new Set(columns.filter((column) => column.defaultVisible).map((column) => column.key));
const pinned = new Set(['dhaka_time', 'account_id', 'sender_display_name']);

export function MessageIntelligenceTable({
  rows, calls, total, page, pages, params,
}: {
  rows: MessageRow[];
  calls: CallRow[];
  total: number;
  page: number;
  pages: number;
  params: Record<string, string | undefined>;
}) {
  const href = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({...params, ...extra})) {
      if (value) search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  const [visible, setVisible] = useState<Set<string>>(new Set(defaultVisible));
  const [expanded, setExpanded] = useState<string | null>(null);
  const shown = useMemo(() => columns.filter((column) => visible.has(column.key)), [visible]);
  const toggle = (key: string) => setVisible((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });
  const stickyOffsets = new Map<string, number>();
  let offset = 0;
  for (const column of columns) {
    if (pinned.has(column.key)) {
      stickyOffsets.set(column.key, offset);
      offset += column.width ?? 160;
    }
  }

  return (
    <>
      <section className="card">
        <div className="row" style={{justifyContent: 'space-between', alignItems: 'center'}}>
          <h3>Message Intelligence ({total.toLocaleString()})</h3>
          <details>
            <summary>Columns ({shown.length}/{columns.length})</summary>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 4, maxHeight: 320, overflow: 'auto', padding: 8}}>
              {columns.map((column) => (
                <label key={column.key} style={{fontSize: 12}}>
                  <input type="checkbox" checked={visible.has(column.key)} onChange={() => toggle(column.key)} />{' '}
                  {column.label} <span className="muted">({column.group})</span>
                </label>
              ))}
            </div>
            <div className="row" style={{marginTop: 6}}>
              <button type="button" onClick={() => setVisible(new Set(columns.map((column) => column.key)))}>Show all</button>
              <button type="button" onClick={() => setVisible(new Set(defaultVisible))}>Default</button>
            </div>
          </details>
        </div>
        <p className="muted" style={{marginTop: 0}}>
          Original WhatsApp event time is shown in Asia/Dhaka. Ingestion and mirror times are separate columns.
          Call trace is NOT_AVAILABLE per message because bridge calls are a separate event stream; actual calls are shown below for the selected conversation.
        </p>
        <div style={{overflowX: 'auto', maxWidth: '100%', border: '1px solid var(--border, #ddd)', borderRadius: 8}}>
          <table style={{minWidth: 2200, borderCollapse: 'separate', borderSpacing: 0}}>
            <thead>
              <tr>
                {shown.map((column) => {
                  const sticky = pinned.has(column.key);
                  return <th key={column.key} style={{position: 'sticky', top: 0, zIndex: sticky ? 4 : 3, background: 'var(--card, #fff)', whiteSpace: 'nowrap', ...(sticky ? {left: stickyOffsets.get(column.key), width: column.width ?? 160, minWidth: column.width ?? 160} : {})}}>{column.label}</th>;
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <Row key={row.id} row={row} shown={shown} pinned={pinned} offsets={stickyOffsets} expanded={expanded === row.id} onToggle={() => setExpanded(expanded === row.id ? null : row.id)} />
              ))}
              {!rows.length ? <tr><td colSpan={Math.max(shown.length, 1)} className="muted">No messages match.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <div className="row" style={{justifyContent: 'space-between', marginTop: 10}}>
          <span className="muted">{total.toLocaleString()} messages · page {page} of {pages}</span>
          <span className="row">
            {page > 1 ? <Link href={href({page: String(page - 1)})}>Newer</Link> : null}
            {page < pages ? <Link href={href({page: String(page + 1)})}>Older</Link> : null}
          </span>
        </div>
      </section>

      <section className="card">
        <h3>Call trace ({calls.length})</h3>
        <p className="muted">Actual bridge call events for this conversation. Calls have no message_id, so they are not fabricated into message rows.</p>
        {calls.length ? (
          <table>
            <thead><tr><th>Call ID</th><th>Time (Dhaka)</th><th>Direction</th><th>Type</th><th>Status</th><th>Duration</th><th>Chat</th></tr></thead>
            <tbody>
              {calls.map((call) => {
                const at = new Date(call.source_timestamp);
                const display = Number.isFinite(at.getTime())
                  ? new Intl.DateTimeFormat('en-GB', {timeZone: 'Asia/Dhaka', dateStyle: 'medium', timeStyle: 'medium'}).format(at)
                  : NOT_AVAILABLE;
                return <tr key={`${call.call_id}:${call.chat_jid}`}>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{call.call_id}</td>
                  <td>{display}</td>
                  <td>{call.direction}</td>
                  <td>{call.call_type ?? 'NOT_AVAILABLE'}</td>
                  <td>{pill(call.status, call.status === 'missed' || call.status === 'rejected' ? 'bad' : call.status === 'ended' ? 'ok' : '')}</td>
                  <td>{call.duration_sec ?? '—'}</td>
                  <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{call.chat_jid}</td>
                </tr>;
              })}
            </tbody>
          </table>
        ) : <p className="muted">No call events captured for this conversation.</p>}
      </section>
    </>
  );
}

function Row({row, shown, pinned, offsets, expanded, onToggle}: {
  row: MessageRow;
  shown: Column[];
  pinned: Set<string>;
  offsets: Map<string, number>;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr>
        {shown.map((column) => {
          const sticky = pinned.has(column.key);
          return <td key={column.key} style={{verticalAlign: 'top', ...(sticky ? {position: 'sticky', left: offsets.get(column.key), zIndex: 2, background: 'var(--card, #fff)', width: column.width ?? 160, minWidth: column.width ?? 160} : {})}}>
            {column.key === 'dhaka_time' ? <button type="button" className="link-button" onClick={onToggle} title="Show all fields">{expanded ? '▾' : '▸'} {column.value(row)}</button> : column.value(row)}
          </td>;
        })}
      </tr>
      {expanded ? (
        <tr>
          <td colSpan={Math.max(shown.length, 1)} style={{background: 'var(--muted-bg, #f7f7f7)', padding: 14}}>
            <div style={{display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: '6px 18px', fontSize: 12}}>
              {columns.map((column) => (
                <div key={column.key}><strong>{column.label}:</strong> <span style={{wordBreak: 'break-word'}}>{column.value(row)}</span></div>
              ))}
            </div>
            <div className="split" style={{marginTop: 12}}>
              <ActionForm
                title="Identity / domain review"
                endpoint="/api/messages"
                action="classify"
                submitLabel="Save review"
                hidden={{account: row.account_id, chat: row.chat_jid, messageId: row.message_id}}
                fields={[
                  {name: 'identityRole', label: 'Identity role', type: 'select', defaultValue: row.identity_role, options: ROLES.map((value) => ({value, label: value}))},
                  {name: 'businessDomain', label: 'Business domain', type: 'select', defaultValue: row.business_domain, options: DOMAINS.map((value) => ({value, label: value}))},
                  {name: 'reviewStatus', label: 'Review status', type: 'select', defaultValue: row.review_status === 'PENDING' ? 'UNREVIEWED' : row.review_status, options: REVIEWS.map((value) => ({value, label: value}))},
                  {name: 'notes', label: 'Notes', type: 'textarea'},
                ]}
                compact
              />
              <div>
                <h4>Provenance</h4>
                <p className="muted">Source: {row.original_source}; source row {row.source_rowid ?? NOT_AVAILABLE}; import run {row.import_run_id ?? NOT_AVAILABLE}.</p>
                <p className="muted">Event time: {row.source_timestamp}; ingested: {row.created_at}; mirrored: {row.mirrored_at}.</p>
                <p className="muted">Media SHA-256: {row.media_sha256 ?? NOT_AVAILABLE}; length: {row.media_length ?? NOT_AVAILABLE}; status: {row.media_status}.</p>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}
