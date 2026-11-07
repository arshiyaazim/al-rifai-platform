import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listChats} from '@/lib/standalone/messages';

export const dynamic = 'force-dynamic';

export default async function ConversationsPage({searchParams}: {searchParams: Promise<{account?: string; kind?: string}>}) {
  await pageUser();
  const params = await searchParams;
  const chats = await listChats(params.account, params.kind);
  return (
    <>
      <div className="page-head"><div><h1>Conversations</h1><p className="muted">WhatsApp chats with message counts and last activity.</p></div><div className="row-actions"><Link href="/message-mirror">Message mirror →</Link></div></div>
      <form method="get" className="card form compact" style={{marginBottom: 18}}><div className="grid">
        <label><span>Account</span><select name="account" defaultValue={params.account ?? ''}><option value="">All</option><option value="wa-01">WA-01</option><option value="wa-02">WA-02</option></select></label>
        <label><span>Kind</span><select name="kind" defaultValue={params.kind ?? ''}><option value="">All</option><option value="DIRECT">Direct</option><option value="GROUP">Group</option></select></label>
      </div><button type="submit">Filter</button></form>
      <section className="card"><h3>Chats ({chats.length})</h3><table><thead><tr><th>Account</th><th>Chat</th><th>Kind</th><th>Messages</th><th>In / Out</th><th>Last</th></tr></thead><tbody>
        {chats.map((chat) => <tr key={`${chat.account_id}-${chat.chat_jid}`}><td>{chat.account_id}</td><td><Link href={`/messages?account=${encodeURIComponent(chat.account_id)}&chat=${encodeURIComponent(chat.chat_jid)}`}>{chat.display_name ?? chat.chat_jid}</Link><div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{chat.chat_jid}</div></td><td>{chat.kind}</td><td>{chat.messages}</td><td>{chat.incoming} / {chat.outgoing}</td><td>{chat.last_at ? when(chat.last_at) : '—'}</td></tr>)}
        {!chats.length ? <tr><td colSpan={6} className="muted">No chats.</td></tr> : null}
      </tbody></table></section>
    </>
  );
}
