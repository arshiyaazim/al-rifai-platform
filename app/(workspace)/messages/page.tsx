import Link from 'next/link';
import {pageUser, when} from '@/lib/standalone/session';
import {listCalls, listChats, listMessages, messageStats} from '@/lib/standalone/messages';
import {MessageIntelligenceTable} from '@/components/standalone/message-intelligence-table';
import {RealtimeRefresher} from '@/components/standalone/realtime-refresher';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{
  account?: string;
  chat?: string;
  direction?: string;
  kind?: string;
  q?: string;
  role?: string;
  domain?: string;
  identity?: string;
  mediaStatus?: string;
  messageType?: string;
  reviewStatus?: string;
  sourceRole?: string;
  sort?: string;
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

const ROLES = ['OWNER', 'ADMIN', 'ACCOUNTANT', 'ESCORT_CLIENT', 'ESCORT', 'EMPLOYEE', 'SUPPLIER', 'CUSTOMER', 'UNKNOWN'];
const DOMAINS = ['CASH', 'VESSEL', 'SECURITY', 'HR', 'PAYROLL', 'OPERATIONS', 'PERSONAL', 'GENERAL', 'UNKNOWN'];
const IDENTITIES = ['EXACT', 'VARIANT', 'AMBIGUOUS', 'UNRESOLVED'];
const MEDIA = ['NOT_APPLICABLE', 'MISSING', 'STORED', 'FAILED', 'SKIPPED'];
const TYPES = ['text', 'image', 'audio', 'video', 'document', 'sticker', 'reaction'];
const SOURCE_ROLES = ['ORDER_INTAKE', 'CASH_ONLY', 'SUPPORT_ONLY', 'RELEASE_ONLY', 'OTHER_APPROVED', 'REVIEW_REQUIRED'];
const REVIEWS = ['PENDING', 'PROCESSING', 'PROCESSED', 'REVIEW_REQUIRED', 'UNREVIEWED', 'CONFIRMED', 'CORRECTED', 'REJECTED'];
const SORTS = [
  ['time_desc', 'Newest event first'],
  ['time_asc', 'Oldest event first'],
  ['sender', 'Sender name'],
  ['domain', 'Business domain'],
  ['role', 'Identity role'],
] as const;

export default async function MessagesPage({searchParams}: {searchParams: SearchParams}) {
  await pageUser();
  const params = await searchParams;
  const page = Math.max(Number(params.page ?? 1), 1);
  const limit = 50;
  const [stats, conversations, listing, calls] = await Promise.all([
    messageStats(),
    listChats(params.account, params.kind),
    listMessages({
      account: params.account,
      chat: params.chat,
      direction: params.direction,
      kind: params.kind,
      q: params.q,
      role: params.role,
      domain: params.domain,
      identity: params.identity,
      mediaStatus: params.mediaStatus,
      messageType: params.messageType,
      reviewStatus: params.reviewStatus,
      sourceRole: params.sourceRole,
      sort: params.sort,
      limit,
      offset: (page - 1) * limit,
    }),
    listCalls(params.account, params.chat, 100),
  ]);

  const query = (extra: Record<string, string | undefined>) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries({
      account: params.account,
      chat: params.chat,
      direction: params.direction,
      kind: params.kind,
      q: params.q,
      role: params.role,
      domain: params.domain,
      identity: params.identity,
      mediaStatus: params.mediaStatus,
      messageType: params.messageType,
      reviewStatus: params.reviewStatus,
      sourceRole: params.sourceRole,
      sort: params.sort,
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
          <h1>WhatsApp Message Intelligence</h1>
          <p className="muted">
            Every message captured from both bridge stores, with original event time, identity, contact,
            conversation, media, call trace and business classification. Read-only; nothing here authorizes a business action.
          </p>
        </div>
        <div className="row-actions">
          <RealtimeRefresher domain="MESSAGE" label="Live messages" />
        </div>
      </div>

      <section className="card">
        <h3>Sync status</h3>
        <table>
          <thead>
            <tr>
              <th>Account</th><th>Messages</th><th>Chats</th><th>In / Out</th><th>Group</th>
              <th>Checkpoint</th><th>Identities</th><th>Media</th><th>Calls</th><th>Latest</th><th>Last sync</th><th>Error</th>
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
                <td>{item.calls.toLocaleString()} / {item.missedCalls.toLocaleString()} missed</td>
                <td>{when(item.lastAt)}</td>
                <td>{when(item.lastSyncedAt)}</td>
                <td>{item.lastError ? <span className="pill bad">{item.lastError}</span> : <span className="pill ok">clean</span>}</td>
              </tr>
            ))}
            {!stats.length ? <tr><td colSpan={12} className="muted">No messages ingested yet.</td></tr> : null}
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

      <form method="get" className="card form compact">
        {params.chat ? <input type="hidden" name="chat" value={params.chat} /> : null}
        <div className="grid">
          <label><span>Search</span><input name="q" defaultValue={params.q ?? ''} placeholder="Text, message ID, chat, JID or name" /></label>
          <label><span>Account</span>
            <select name="account" defaultValue={params.account ?? ''}>
              <option value="">Both bridges</option>
              <option value="wa-01">WA-01</option>
              <option value="wa-02">WA-02</option>
            </select>
          </label>
          <label><span>Chat type</span>
            <select name="kind" defaultValue={params.kind ?? ''}>
              <option value="">All</option><option value="DIRECT">Direct</option><option value="GROUP">Group</option>
            </select>
          </label>
          <label><span>Direction</span>
            <select name="direction" defaultValue={params.direction ?? ''}>
              <option value="">Both</option><option value="INCOMING">Incoming</option><option value="OUTGOING">Outgoing</option>
            </select>
          </label>
          <label><span>Identity role</span>
            <select name="role" defaultValue={params.role ?? ''}>
              <option value="">All roles</option>{ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Business domain</span>
            <select name="domain" defaultValue={params.domain ?? ''}>
              <option value="">All domains</option>{DOMAINS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Identity confidence</span>
            <select name="identity" defaultValue={params.identity ?? ''}>
              <option value="">All</option>{IDENTITIES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Media status</span>
            <select name="mediaStatus" defaultValue={params.mediaStatus ?? ''}>
              <option value="">All</option>{MEDIA.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Message type</span>
            <select name="messageType" defaultValue={params.messageType ?? ''}>
              <option value="">All</option>{TYPES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Source role</span>
            <select name="sourceRole" defaultValue={params.sourceRole ?? ''}>
              <option value="">All source roles</option>
              {SOURCE_ROLES.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Review status</span>
            <select name="reviewStatus" defaultValue={params.reviewStatus ?? ''}>
              <option value="">All</option>{REVIEWS.map((value) => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <label><span>Sort</span>
            <select name="sort" defaultValue={params.sort ?? 'time_desc'}>
              {SORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <button type="submit">Apply filters</button>
          <Link href="/messages">Reset</Link>
        </div>
      </form>

      <MessageIntelligenceTable
        rows={listing.items}
        calls={calls}
        total={listing.total}
        page={page}
        pages={pages}
        params={params}
      />
    </>
  );
}
