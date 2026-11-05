import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listMessages, messageStats} from '@/lib/standalone/messages';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{account?: string; chat?: string; direction?: string; q?: string; page?: string}>;

export default async function MessagesPage({searchParams}: {searchParams: SearchParams}) {
  await pageUser();
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? 1), 1);
  const limit = 50;
  const [stats, listing] = await Promise.all([
    messageStats(),
    listMessages({
      account: params.account,
      chat: params.chat,
      direction: params.direction,
      q: params.q,
      limit,
      offset: (page - 1) * limit,
    }),
  ]);

  const account = params.account ?? '';
  const query = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({account: account || undefined, chat: params.chat, direction: params.direction, q: params.q, ...extra})) {
      if (value) search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  const pages = Math.max(Math.ceil(listing.total / limit), 1);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>WhatsApp Inbox</h1>
          <p className="muted">Every message captured from both bridge stores. Read-only.</p>
        </div>
      </div>

      <section className="card">
        <h3>Sync status</h3>
        <table>
          <thead><tr><th>Account</th><th>Messages</th><th>Chats</th><th>In / Out</th><th>Group</th><th>Latest</th><th>Last sync</th><th>Error</th></tr></thead>
          <tbody>
            {stats.map((item) => (
              <tr key={item.account}>
                <td><Link href={query({account: item.account, page: undefined})}>{item.account}</Link></td>
                <td>{item.messages.toLocaleString()}</td>
                <td>{item.chats.toLocaleString()}</td>
                <td>{item.incoming.toLocaleString()} / {item.outgoing.toLocaleString()}</td>
                <td>{item.groups.toLocaleString()}</td>
                <td>{when(item.lastAt)}</td>
                <td>{when(item.lastSyncedAt)}</td>
                <td>{item.lastError ? <span className="pill bad">{item.lastError}</span> : <span className="pill ok">clean</span>}</td>
              </tr>
            ))}
            {!stats.length ? <tr><td colSpan={8} className="muted">No messages ingested yet.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="card">
        <form method="get" className="row">
          <input type="hidden" name="account" value={account} />
          <input name="q" defaultValue={params.q ?? ''} placeholder="Search text, chat or sender" />
          <select name="direction" defaultValue={params.direction ?? ''}>
            <option value="">Both directions</option>
            <option value="INCOMING">Incoming</option>
            <option value="OUTGOING">Outgoing</option>
          </select>
          <button type="submit">Filter</button>
          <Link href="/messages">Reset</Link>
        </form>

        <table>
          <thead><tr><th>When</th><th>Account</th><th>Chat</th><th>Dir</th><th>Sender</th><th>Message</th></tr></thead>
          <tbody>
            {listing.items.map((item) => (
              <tr key={item.id}>
                <td style={{whiteSpace: 'nowrap'}}>{when(item.source_timestamp)}</td>
                <td>{item.account_id}</td>
                <td>
                  <Link href={query({chat: item.chat_jid, page: undefined})}>{item.chat_label ?? item.chat_jid}</Link>
                  <div className="muted" style={{fontSize: 11}}>{item.chat_kind ?? ''}</div>
                </td>
                <td><span className={`pill ${item.direction === 'INCOMING' ? '' : 'ok'}`}>{item.direction === 'INCOMING' ? 'IN' : 'OUT'}</span></td>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                  {item.group_participant_jid ?? item.sender_jid ?? '—'}
                </td>
                <td style={{maxWidth: 520}}>
                  <div style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>
                    {item.text_content ?? <span className="muted">[{item.media_type ?? 'no text'}]</span>}
                  </div>
                  {item.deleted_at ? <div className="muted">deleted {when(item.deleted_at)}</div> : null}
                </td>
              </tr>
            ))}
            {!listing.items.length ? <tr><td colSpan={6} className="muted">No messages match.</td></tr> : null}
          </tbody>
        </table>

        <div className="row" style={{justifyContent: 'space-between'}}>
          <span className="muted">{listing.total.toLocaleString()} messages · page {page} of {pages}</span>
          <span className="row">
            {page > 1 ? <Link href={query({page: String(page - 1)})}>Newer</Link> : null}
            {page < pages ? <Link href={query({page: String(page + 1)})}>Older</Link> : null}
          </span>
        </div>
      </section>
    </>
  );
}
