// Live reader for WA-01 native message pages.
//
// The bridge's historical tools (list_messages / list_archive_messages /
// list_stored_messages) are no longer exposed. The only message reader that
// remains is `list_native_messages`, which:
//   * requires limit <= 10,
//   * with cursor = null returns an ACTIVATION page (a boundary cursor and no
//     records — it deliberately does not replay history),
//   * with a cursor returns CONTENT records after that cursor.
//
// History for the seven approved conversations therefore comes from the
// approved staging backfill, and this reader continues the stream from the
// activation boundary. Both paths write through the same downstream code, so a
// message can never be published twice.

export type NativeEnvelope = {
  version: string;
  provider: string;
  accountId: string;
  nativeMessageId: string;
  chatJid: string;
  chatType: 'direct' | 'group';
  senderJid: string;
  senderPhone: string | null;
  senderLid: string | null;
  direction: 'INCOMING' | 'OUTGOING';
  sourceTimestamp: string;
  observedAt: string;
  eventType: string;
  payload: { text: string; sha256: string; reference?: unknown };
  quotedMessageId: string | null;
  forwarded: boolean | null;
  media: Array<Record<string, unknown>>;
  groupDisplayName: string | null;
  membershipEvidence: Record<string, unknown> | null;
};

export type NativeLiveRecord = {
  sequence: string;
  messageId: string | null;
  chatJid: string;
  senderJid: string | null;
  sourceTime: string | null;
  observedAt: string;
  kind: string;
  status: string;
  reason: string | null;
  semanticHash: string | null;
  envelope: NativeEnvelope | null;
};

export type NativeLivePage = {
  chatJid: string;
  previousCursor: string | null;
  nextCursor: string;
  boundarySequence: string;
  complete: boolean;
  records: NativeLiveRecord[];
};

export type NativeToolCaller = {
  callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
};

export const NATIVE_PAGE_LIMIT = 10;
const DEFAULT_TIMEOUT_MS = 20_000;

const cursorPattern = /^n1:[0-9a-f-]{36}:[0-9a-f]{24}:[0-9]+:[0-9]+$/;
const hex = /^[a-f0-9]{64}$/;

export class NativeReadError extends Error {
  readonly code: string;
  constructor(code: string) {
    super(code);
    this.name = 'NativeReadError';
    this.code = code;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length ? value : null;
}

function parsePage(raw: Record<string, unknown>, account: string, chatJid: string, cursor: string | null): NativeLivePage {
  if (raw.version !== 'native-live-message-page-v1') throw new NativeReadError('NATIVE_PAGE_VERSION_INVALID');
  if (raw.accountId !== account) throw new NativeReadError('NATIVE_PAGE_ACCOUNT_MISMATCH');
  if (raw.chatJid !== chatJid) throw new NativeReadError('NATIVE_PAGE_CHAT_MISMATCH');
  if ((raw.previousCursor ?? null) !== cursor) throw new NativeReadError('NATIVE_PAGE_CURSOR_MISMATCH');
  const nextCursor = str(raw.nextCursor);
  if (!nextCursor || !cursorPattern.test(nextCursor)) throw new NativeReadError('NATIVE_CURSOR_INVALID');
  if (typeof raw.complete !== 'boolean') throw new NativeReadError('NATIVE_PAGE_COMPLETION_INVALID');
  const boundarySequence = typeof raw.boundarySequence === 'string' ? raw.boundarySequence : null;
  if (boundarySequence !== null && !/^(0|[1-9][0-9]{0,18})$/.test(boundarySequence)) {
    throw new NativeReadError('NATIVE_BOUNDARY_INVALID');
  }
  const list = raw.records;
  if (!Array.isArray(list) || list.length > NATIVE_PAGE_LIMIT) throw new NativeReadError('NATIVE_PAGE_RECORD_COUNT_INVALID');

  let last = -1;
  const records: NativeLiveRecord[] = [];
  for (const entry of list) {
    const record = entry as Record<string, unknown>;
    const sequence = str(record.sequence);
    if (!sequence || !/^(0|[1-9][0-9]{0,18})$/.test(sequence)) throw new NativeReadError('NATIVE_SEQUENCE_INVALID');
    const value = Number(sequence);
    if (value <= last) throw new NativeReadError('NATIVE_SEQUENCE_ORDER_INVALID');
    last = value;
    if (record.chatJid !== chatJid) throw new NativeReadError('NATIVE_RECORD_CHAT_MISMATCH');
    const status = str(record.status);
    if (!status) throw new NativeReadError('NATIVE_RECORD_STATUS_INVALID');
    const envelope = record.envelope as NativeEnvelope | null | undefined;
    if (status === 'CONTENT') {
      if (!envelope || typeof envelope !== 'object') throw new NativeReadError('NATIVE_CONTENT_WITHOUT_ENVELOPE');
      if (envelope.accountId !== account || envelope.chatJid !== chatJid) throw new NativeReadError('NATIVE_ENVELOPE_SCOPE_MISMATCH');
      if (typeof envelope.nativeMessageId !== 'string' || !envelope.nativeMessageId.length) throw new NativeReadError('NATIVE_ENVELOPE_ID_INVALID');
      if (envelope.direction !== 'INCOMING' && envelope.direction !== 'OUTGOING') throw new NativeReadError('NATIVE_ENVELOPE_DIRECTION_INVALID');
      if (typeof envelope.sourceTimestamp !== 'string' || !Number.isFinite(Date.parse(envelope.sourceTimestamp))) {
        throw new NativeReadError('NATIVE_ENVELOPE_TIME_INVALID');
      }
      if (!envelope.payload || typeof envelope.payload.text !== 'string') throw new NativeReadError('NATIVE_ENVELOPE_PAYLOAD_INVALID');
    } else if (envelope) {
      throw new NativeReadError('NATIVE_NON_CONTENT_WITH_ENVELOPE');
    }
    const semanticHash = str(record.semanticHash);
    records.push({
      sequence,
      messageId: str(record.messageId),
      chatJid,
      senderJid: str(record.senderJid),
      sourceTime: str(record.sourceTime),
      observedAt: String(record.observedAt ?? ''),
      kind: String(record.kind ?? ''),
      status,
      reason: str(record.reason),
      semanticHash: semanticHash && hex.test(semanticHash) ? semanticHash : null,
      envelope: envelope ?? null,
    });
  }
  return { chatJid, previousCursor: cursor, nextCursor, boundarySequence: boundarySequence ?? '0', complete: raw.complete, records };
}

export class NativeLiveReader {
  private readonly client: NativeToolCaller;
  private readonly timeoutMs: number;
  constructor(client: NativeToolCaller, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.client = client;
    this.timeoutMs = timeoutMs;
  }

  private async call(account: string, chatJid: string, cursor: string | null, limit = NATIVE_PAGE_LIMIT): Promise<NativeLivePage> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new NativeReadError('NATIVE_READ_TIMEOUT')), this.timeoutMs);
    });
    try {
      const raw = await Promise.race([
        this.client.callTool('list_native_messages', { chat_jid: chatJid, cursor, limit }),
        deadline,
      ]);
      return parsePage(raw, account, chatJid, cursor);
    } catch (error) {
      if (error instanceof NativeReadError) throw error;
      // The bridge reports a denied chat as a generic tool failure; keep the
      // distinction visible for operators without leaking message content.
      const message = error instanceof Error ? error.message : '';
      // An explicit code from the bridge/broker is authoritative; a transport
      // denial means this reader may not call the tool at all.
      if (/^[A-Z][A-Z0-9_]{3,80}$/.test(message)) {
        throw new NativeReadError(message === 'BROKER_READ_DENIED' ? 'NATIVE_TOOL_NOT_PERMITTED' : message);
      }
      throw new NativeReadError(/denied|scope|forbidden|unauthor/i.test(message) ? 'NATIVE_CONTENT_SCOPE_DENIED' : 'NATIVE_READER_UNAVAILABLE');
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Activation page: obtains a boundary cursor without replaying history. */
  activate(account: string, chatJid: string): Promise<NativeLivePage> {
    return this.call(account, chatJid, null);
  }

  page(account: string, chatJid: string, cursor: string): Promise<NativeLivePage> {
    return this.call(account, chatJid, cursor);
  }
}

export type NativeQueryable = {
  query(sql: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
};

/** Reads or activates the durable per-chat cursor. */
export async function ensureNativeCursor(
  db: NativeQueryable,
  account: string,
  chatJid: string,
  reader: NativeLiveReader,
): Promise<string> {
  const existing = await db.query(
    'SELECT cursor FROM public.whatsapp_native_sync_state WHERE account_id=$1 AND chat_jid=$2',
    [account, chatJid],
  );
  const cursor = existing.rows[0]?.cursor;
  if (typeof cursor === 'string' && cursorPattern.test(cursor)) return cursor;
  const page = await reader.activate(account, chatJid);
  await db.query(
    `INSERT INTO public.whatsapp_native_sync_state
       (account_id,chat_jid,cursor,last_sequence,last_observed_at,last_error,activated_at,updated_at)
     VALUES ($1,$2,$3,$4,now(),NULL,now(),now())
     ON CONFLICT (account_id,chat_jid) DO UPDATE SET
       cursor=EXCLUDED.cursor,last_sequence=EXCLUDED.last_sequence,
       last_observed_at=now(),last_error=NULL,activated_at=now(),updated_at=now()`,
    [account, chatJid, page.nextCursor, Number(page.boundarySequence)],
  );
  return page.nextCursor;
}

export async function recordNativeError(db: NativeQueryable, account: string, chatJid: string, code: string): Promise<void> {
  await db
    .query(
      `INSERT INTO public.whatsapp_native_sync_state (account_id,chat_jid,last_error,last_observed_at,updated_at)
       VALUES ($1,$2,$3,now(),now())
       ON CONFLICT (account_id,chat_jid) DO UPDATE SET last_error=EXCLUDED.last_error,last_observed_at=now(),updated_at=now()`,
      [account, chatJid, code.slice(0, 200)],
    )
    .catch(() => undefined);
}

export async function advanceNativeCursor(
  db: NativeQueryable,
  account: string,
  chatJid: string,
  page: NativeLivePage,
): Promise<void> {
  const last = page.records.length ? Number(page.records[page.records.length - 1].sequence) : null;
  await db.query(
    `UPDATE public.whatsapp_native_sync_state
        SET cursor=$3,last_sequence=COALESCE($4,last_sequence),last_observed_at=now(),last_error=NULL,updated_at=now()
      WHERE account_id=$1 AND chat_jid=$2`,
    [account, chatJid, page.nextCursor, last],
  );
}
