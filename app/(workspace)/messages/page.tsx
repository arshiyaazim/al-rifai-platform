import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listChats, listMessages, messageStats} from '@/lib/standalone/messages';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  account?: string;
  chat?: string;
  direction?: string;
  kind?: string;
  q?: string;
  page?: string;
}>;

function bytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? Math.round(amount) : amount.toFixed(1)} ${units[unit]}`;
}

function mediaHref(account: string, chat: string, message: string) {
  const search = new URLSearchParams({account, chat, message});
  return `/api/media?${search.toString()}`;
}

export default async function MessagesPage({searchParams}: {searchParams: SearchParams}) {
  await pageUser();
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? 1), 1);
  const limit = 50;
  const [stats, conversations, listing] = await Promise.all([
    messageStats(),
    listChats(params.account, params.kind),
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
    for (const [key, value] of Object.entries({
      account: account || undefined,
      chat: params.chat,
      direction: params.direction,
      kind: params.kind,
      q: params.q,
      ...extra,
    })) {
      if (value) search.set(key, value);
    }
    const text = search.toString();
    return text ? `?${text}` : '';
  };
  const pages = Math.max(Math.ceil(listing.total / limit), 1);
  const visibleConversations = conversations.slice(0, 60);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>WhatsApp Inbox</h1>
          <p className="muted">
            Every message captured from both bridge stores, with resolved identities and new-media capture.
            Read-only; nothing here authorizes a business action.
          </p>
        </div>
      </div>

      <section className="card">
        <h3>Sync status</h3>
        <table>
          <thead>
            <tr>
              <th>Account</th><th>Messages</th><th>Chats</th><th>In / Out</th><th>Group</th>
              <th>Checkpoint</th><th>Identities</th><th>Media</th><th>Latest</th><th>Last sync</th><th>Error</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((item) => (
              <tr key={item.account}>
                <td><Link href={query({account: item.account, page: undefined})}>{item.account}</Link></td>
                <td>{item.messages.toLocaleString()}</td>
                <td>{item.chats.toLocaleString()}</td>
                <td>{item.incoming.toLocaleString()} / {item.outgoing.toLocaleString()}</td>
                <td>{item.groups.toLocaleString()}</td>
                <td style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>
                  {item.checkpoint?.toLocaleString() ?? '—'}
                </td>
                <td>{item.identities.toLocaleString()}</td>
                <td>
                  {item.mediaStored.toLocaleString()} stored / {bytes(item.mediaBytes)}
                  {item.mediaFailed ? <span className="pill bad" style={{marginLeft: 6}}>{item.mediaFailed} failed</span> : null}
                </td>
                <td>{when(item.lastAt)}</td>
                <td>{when(item.lastSyncedAt)}</td>
                <td>{item.lastError ? <span className="pill bad">{item.lastError}</span> : <span className="pill ok">clean</span>}</td>
              </tr>
            ))}
            {!stats.length ? <tr><td colSpan={11} className="muted">No messages ingested yet.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="row" style={{justifyContent: 'space-between'}}>
          <h3>Conversations</h3>
          <span className="row">
            <Link href={query({kind: undefined, chat: undefined, page: undefined})}>All</Link>
            <Link href={query({kind: 'DIRECT', chat: undefined, page: undefined})}>Direct</Link>
            <Link href={query({kind: 'GROUP', chat: undefined, page: undefined})}>Groups</Link>
          </span>
        </div>
        <table>
          <thead><tr><th>Conversation</th><th>Kind</th><th>Identity</th><th>Messages</th><th>In / Out</th><th>Media</th><th>Latest</th></tr></thead>
          <tbody>
            {visibleConversations.map((chat) => (
              <tr key={`${chat.account_id}:${chat.chat_jid}`}>
                <td>
                  <Link href={query({chat: chat.chat_jid, page: undefined})}>
                    {chat.display_name ?? chat.chat_jid}
                  </Link>
                  <div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 11}}>{chat.chat_jid}</div>
                </td>
                <td>{chat.kind === 'GROUP' ? 'Group' : 'Direct'}</td>
                <td>
                  {chat.confidence === 'EXACT'
                    ? <span className="pill ok">resolved</span>
                    : chat.confidence === 'VARIANT'
                      ? <span className="pill">partial</span>
                      : <span className="pill bad">unresolved</span>}
                </td>
                <td>{Number(chat.messages).toLocaleString()}</td>
                <td>{Number(chat.incoming).toLocaleString()} / {Number(chat.outgoing).toLocaleString()}</td>
                <td>{Number(chat.media).toLocaleString()}</td>
                <td>{when(chat.last_at)}</td>
              </tr>
            ))}
            {!visibleConversations.length ? <tr><td colSpan={7} className="muted">No conversations captured.</td></tr> : null}
          </tbody>
        </table>
        {conversations.length > visibleConversations.length ? (
          <p className="muted">Showing the {visibleConversations.length} most recent of {conversations.length} conversations.</p>
        ) : null}
      </section>

      <section className="card">
        <form method="get" className="row">
          <input type="hidden" name="account" value={account} />
          <input type="hidden" name="kind" value={params.kind ?? ''} />
          <input name="q" defaultValue={params.q ?? ''} placeholder="Search text, chat, sender or name" />
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
            {listing.items.map((item) => {
              const sender = item.sender_name
                ?? item.group_participant_jid
                ?? item.sender_jid
                ?? '—';
              const senderId = item.group_participant_jid ?? item.sender_jid;
              const chatName = item.chat_name ?? item.chat_label ?? item.chat_jid;
              return (
                <tr key={item.id}>
                  <td style={{whiteSpace: 'nowrap'}}>{when(item.source_timestamp)}</td>
                  <td>{item.account_id}</td>
                  <td>
                    <Link href={query({chat: item.chat_jid, page: undefined})}>{chatName}</Link>
                    <div className="muted" style={{fontSize: 11}}>{item.chat_kind ?? ''}</div>
                  </td>
                  <td><span className={`pill ${item.direction === 'INCOMING' ? '' : 'ok'}`}>{item.direction === 'INCOMING' ? 'IN' : 'OUT'}</span></td>
                  <td style={{maxWidth: 200}}>
                    <div>{sender}</div>
                    {item.sender_name && senderId ? (
                      <div className="muted" style={{fontFamily: 'ui-monospace, monospace', fontSize: 10}}>{senderId}</div>
                    ) : null}
                    {item.sender_confidence === 'UNRESOLVED' ? (
                      <div className="muted" style={{fontSize: 10}}>unresolved identity</div>
                    ) : null}
                  </td>
                  <td style={{maxWidth: 520}}>
                    <div style={{whiteSpace: 'pre-wrap', wordBreak: 'break-word'}}>
                      {item.text_content ?? <span className="muted">[{item.media_type ?? 'no text'}]</span>}
                    </div>
                    {item.media_type && item.media_type !== 'reaction' ? (
                      <div className="muted" style={{fontSize: 11, marginTop: 2}}>
                        {item.media_status === 'STORED' ? (
                          <>
                            <a href={mediaHref(item.account_id, item.chat_jid, item.message_id)} target="_blank" rel="noreferrer">
                              {item.media_type}{item.media_filename ? ` · ${item.media_filename}` : ''}
                            </a>
                            {item.media_byte_length ? ` · ${bytes(Number(item.media_byte_length))}` : ''}
                          </>
                        ) : item.media_status === 'FAILED' ? (
                          <span className="pill bad">media capture failed</span>
                        ) : (
                          <span>media not captured</span>
                        )}
                      </div>
                    ) : null}
                    {item.deleted_at ? <div className="muted">deleted {when(item.deleted_at)}</div> : null}
                  </td>
                </tr>
              );
            })}
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
