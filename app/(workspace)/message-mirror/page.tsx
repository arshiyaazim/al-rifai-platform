import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listMessages} from '@/lib/standalone/messages';

export const dynamic = 'force-dynamic';

export default async function MessageMirrorPage({searchParams}: {searchParams: Promise<{account?: string; direction?: string; q?: string}>}) {
  await pageUser();
  const params = await searchParams;
  const listing = await listMessages({account: params.account, direction: params.direction, q: params.q, limit: 100});
  return (
    <>
      <div className="page-head"><div><h1>Message Mirror</h1><p className="muted">Read-only ingested WhatsApp messages with sender and chat identity.</p></div><div className="row-actions"><Link href="/messages">Inbox →</Link><Link href="/conversations">Conversations →</Link></div></div>
      <form method="get" className="card form compact" style={{marginBottom: 18}}><div className="grid">
        <label><span>Search</span><input name="q" defaultValue={params.q ?? ''} placeholder="Text, sender, chat or message ID" /></label>
        <label><span>Account</span><select name="account" defaultValue={params.account ?? ''}><option value="">All</option><option value="wa-01">WA-01</option><option value="wa-02">WA-02</option></select></label>
        <label><span>Direction</span><select name="direction" defaultValue={params.direction ?? ''}><option value="">All</option><option value="INCOMING">Incoming</option><option value="OUTGOING">Outgoing</option></select></label>
      </div><button type="submit">Search</button></form>
      <section className="card"><h3>Messages ({listing.total})</h3><table><thead><tr><th>Time</th><th>Account</th><th>Chat</th><th>Sender</th><th>Dir</th><th>Message</th><th /></tr></thead><tbody>
        {listing.items.map((message) => <tr key={message.id}><td style={{whiteSpace: 'nowrap'}}>{when(message.source_timestamp)}</td><td>{message.account_id}</td><td style={{maxWidth: 220}}>{message.chat_name ?? message.chat_jid}<div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{message.chat_jid}</div></td><td>{message.sender_name ?? message.sender_jid ?? '—'}</td><td>{message.direction}</td><td style={{maxWidth: 420}}>{String(message.text_content ?? '').slice(0, 240)}</td><td><Link href={`/messages?account=${encodeURIComponent(message.account_id)}&chat=${encodeURIComponent(message.chat_jid)}`}>Open</Link></td></tr>)}
        {!listing.items.length ? <tr><td colSpan={7} className="muted">No matching messages.</td></tr> : null}
      </tbody></table></section>
    </>
  );
}
