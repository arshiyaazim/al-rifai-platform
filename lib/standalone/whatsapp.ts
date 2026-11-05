import {createConnection, type Socket} from 'node:net';
import {readFileSync} from 'node:fs';
import {rows, row, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId} from './audit.ts';
import {assignEscort, createProgram} from './programs.ts';

/**
 * Adapter for the external WhatsApp MCP relay.
 *
 * Contract (observed in the existing bridge, not invented here):
 *   - unix domain socket
 *   - the first line written after connect is the reader token
 *   - newline-delimited JSON-RPC 2.0
 *   - tools are invoked with `tools/call` and return `result.structuredContent`
 *
 * The application never pairs a device, never stores a session and never opens a
 * chat that is not configured as authorized for this installation.
 */

type JsonObject = Record<string, unknown>;

class McpClient {
  private socket: Socket;
  private buffer = '';
  private nextId = 1;
  private pending = new Map<number, {resolve: (v: JsonObject) => void; reject: (e: Error) => void; timer: NodeJS.Timeout}>();
  private ready: Promise<void>;

  constructor(socketPath: string, tokenFile: string) {
    const token = readFileSync(tokenFile, 'utf8').trim();
    if (!token) throw new DomainError('WHATSAPP_TOKEN_EMPTY');
    this.socket = createConnection({path: socketPath});
    this.socket.setTimeout(20_000);
    this.ready = new Promise((resolve, reject) => {
      this.socket.once('connect', () => this.socket.write(`${token}\n`, (error) => (error ? reject(new Error('WHATSAPP_AUTH_WRITE_FAILED')) : resolve())));
      this.socket.once('error', (error) => reject(new Error(`WHATSAPP_CONNECT_FAILED:${error.message}`)));
    });
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    this.socket.on('error', () => this.failAll(new Error('WHATSAPP_CONNECTION_FAILED')));
    this.socket.on('close', () => this.failAll(new Error('WHATSAPP_CONNECTION_CLOSED')));
    this.socket.on('timeout', () => {
      this.failAll(new Error('WHATSAPP_TIMEOUT'));
      this.socket.destroy();
    });
  }

  private onData(chunk: Buffer) {
    this.buffer += chunk.toString('utf8');
    if (this.buffer.length > 1_000_000) {
      this.failAll(new Error('WHATSAPP_RESPONSE_TOO_LARGE'));
      this.socket.destroy();
      return;
    }
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line) this.onLine(line);
      index = this.buffer.indexOf('\n');
    }
  }

  private onLine(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      this.failAll(new Error('WHATSAPP_PROTOCOL_INVALID'));
      return;
    }
    const id = message.id;
    if (typeof id !== 'number') return;
    const waiter = this.pending.get(id);
    if (!waiter) return;
    this.pending.delete(id);
    clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error('WHATSAPP_TOOL_ERROR'));
    else waiter.resolve((message.result ?? {}) as JsonObject);
  }

  private failAll(error: Error) {
    for (const waiter of this.pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.pending.clear();
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    return this.ready.then(() => new Promise<JsonObject>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('WHATSAPP_TIMEOUT'));
      }, 20_000);
      this.pending.set(id, {resolve, reject, timer});
      this.socket.write(`${JSON.stringify({jsonrpc: '2.0', id, method, params})}\n`);
    }));
  }

  async callTool(name: string, args: JsonObject): Promise<JsonObject> {
    const result = await this.request('tools/call', {name, arguments: args});
    const structured = result.structuredContent;
    if (structured && typeof structured === 'object') return structured as JsonObject;
    const content = result.content;
    if (Array.isArray(content) && content[0] && typeof content[0] === 'object' && 'text' in content[0]) {
      const text = String((content[0] as {text?: string}).text ?? '');
      try {
        return JSON.parse(text) as JsonObject;
      } catch {
        return {text};
      }
    }
    return result;
  }

  close() {
    this.socket.destroy();
  }
}

export type WhatsAppAccount = {
  id: string;
  label: string;
  enabled: boolean;
  transport: string;
  socket_path: string | null;
  token_file: string | null;
  account_jid: string | null;
  admin_jids: string[];
};

export async function listAccounts(): Promise<WhatsAppAccount[]> {
  return rows<WhatsAppAccount>('SELECT * FROM whatsapp_accounts ORDER BY label');
}

export async function listChats(accountId: string) {
  return rows('SELECT * FROM whatsapp_chats WHERE account_id = $1 ORDER BY chat_jid', [accountId]);
}

export async function configureAccount(actor: Actor, input: {
  id: string; label: string; socketPath?: string | null; tokenFile?: string | null;
  accountJid?: string | null; adminJids?: string[]; enabled?: boolean;
  chats?: Array<{chatJid: string; label?: string | null; purpose?: string}>;
}) {
  if (!/^[A-Za-z0-9._:-]{1,60}$/.test(input.id)) throw new DomainError('INVALID_ACCOUNT_ID');
  if (input.enabled && (!input.socketPath || !input.tokenFile)) throw new DomainError('SOCKET_AND_TOKEN_REQUIRED');
  return rows(
    `INSERT INTO whatsapp_accounts (id, label, enabled, socket_path, token_file, account_jid, admin_jids)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)
     ON CONFLICT (id) DO UPDATE
       SET label = EXCLUDED.label, enabled = EXCLUDED.enabled, socket_path = EXCLUDED.socket_path,
           token_file = EXCLUDED.token_file, account_jid = EXCLUDED.account_jid,
           admin_jids = EXCLUDED.admin_jids, updated_at = now()
     RETURNING *`,
    [input.id, input.label, input.enabled ?? false, input.socketPath ?? null, input.tokenFile ?? null,
      input.accountJid ?? null, JSON.stringify(input.adminJids ?? [])],
  ).then(async (account) => {
    for (const chat of input.chats ?? []) {
      await row(
        `INSERT INTO whatsapp_chats (account_id, chat_jid, label, purpose)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (account_id, chat_jid) DO UPDATE
           SET label = EXCLUDED.label, purpose = EXCLUDED.purpose`,
        [input.id, chat.chatJid, chat.label ?? null, chat.purpose ?? 'BOTH'],
      );
    }
    await recordAudit({actor, action: 'WHATSAPP_CONFIGURED', entity: 'whatsapp_account', entityId: input.id});
    return account;
  });
}

function clientFor(account: WhatsAppAccount) {
  if (!account.enabled) throw new DomainError('WHATSAPP_DISABLED', 409);
  if (!account.socket_path || !account.token_file) throw new DomainError('WHATSAPP_NOT_CONFIGURED', 409);
  return new McpClient(account.socket_path, account.token_file);
}

export async function health(accountId: string) {
  const account = await row<WhatsAppAccount>('SELECT * FROM whatsapp_accounts WHERE id = $1', [accountId]);
  if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
  if (!account.enabled || !account.socket_path || !account.token_file) {
    return {ok: false, state: 'NOT_CONFIGURED' as const};
  }
  let client: McpClient | undefined;
  try {
    client = clientFor(account);
    const identity = await client.callTool('get_native_account_identity', {});
    return {ok: true, state: 'CONNECTED' as const, identity};
  } catch (error) {
    return {ok: false, state: 'UNREACHABLE' as const, error: (error as Error).message};
  } finally {
    client?.close();
  }
}

type NativeRecord = {
  status?: string;
  envelope?: JsonObject;
} & JsonObject;

function envelopeOf(record: NativeRecord): JsonObject | null {
  const envelope = record.envelope ?? record;
  if (!envelope || typeof envelope !== 'object') return null;
  if (typeof envelope.nativeMessageId !== 'string' || typeof envelope.chatJid !== 'string') return null;
  return envelope;
}

export async function syncAccount(actor: Actor, accountId: string, maxPages = 20) {
  const account = await row<WhatsAppAccount>('SELECT * FROM whatsapp_accounts WHERE id = $1', [accountId]);
  if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
  const chats = await rows<{chat_jid: string; purpose: string}>(
    'SELECT chat_jid, purpose FROM whatsapp_chats WHERE account_id = $1 AND authorized = true',
    [accountId],
  );
  const client = clientFor(account);
  let stored = 0;
  let pages = 0;
  try {
    for (const chat of chats) {
      const cursorRow = await row<{cursor: string | null}>(
        'SELECT cursor FROM whatsapp_cursors WHERE account_id = $1 AND chat_jid = $2',
        [accountId, chat.chat_jid],
      );
      let cursor = cursorRow?.cursor ?? null;
      for (let page = 0; page < maxPages; page += 1) {
        const response = await client.callTool('list_native_messages', {chat_jid: chat.chat_jid, cursor, limit: 10});
        const records = (Array.isArray(response.records) ? response.records : []) as NativeRecord[];
        for (const record of records) {
          if (record.status && record.status !== 'CONTENT') continue;
          const envelope = envelopeOf(record);
          if (!envelope) continue;
          const inserted = await row(
            `INSERT INTO whatsapp_messages
               (account_id, chat_jid, message_id, direction, sender_jid, source_timestamp, text_content, content_hash)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
             ON CONFLICT (account_id, message_id) DO NOTHING RETURNING id`,
            [
              accountId,
              String(envelope.chatJid),
              String(envelope.nativeMessageId),
              String(envelope.direction) === 'OUTGOING' ? 'OUTGOING' : 'INCOMING',
              typeof envelope.senderJid === 'string' ? envelope.senderJid : null,
              String(envelope.sourceTimestamp),
              typeof (envelope.payload as JsonObject | undefined)?.text === 'string'
                ? String((envelope.payload as JsonObject).text)
                : null,
              typeof (envelope.payload as JsonObject | undefined)?.sha256 === 'string'
                ? String((envelope.payload as JsonObject).sha256)
                : stableId('h', [envelope.nativeMessageId]),
            ],
          );
          if (inserted) stored += 1;
        }
        pages += 1;
        const next = typeof response.nextCursor === 'string' ? response.nextCursor : null;
        if (!next || next === cursor) break;
        cursor = next;
      }
      await row(
        `INSERT INTO whatsapp_cursors (account_id, chat_jid, cursor, last_error)
         VALUES ($1,$2,$3,NULL)
         ON CONFLICT (account_id, chat_jid) DO UPDATE SET cursor = EXCLUDED.cursor, last_error = NULL, updated_at = now()`,
        [accountId, chat.chat_jid, cursor],
      );
    }
    await recordAudit({actor, action: 'WHATSAPP_SYNCED', entity: 'whatsapp_account', entityId: accountId,
      detail: {stored, pages}});
    return {stored, pages};
  } catch (error) {
    await row(
      `INSERT INTO whatsapp_cursors (account_id, chat_jid, cursor, last_error)
       VALUES ($1,'*',NULL,$2)
       ON CONFLICT (account_id, chat_jid) DO UPDATE SET last_error = EXCLUDED.last_error, updated_at = now()`,
      [accountId, (error as Error).message.slice(0, 500)],
    ).catch(() => undefined);
    throw error;
  } finally {
    client.close();
  }
}

/**
 * Process staged messages through the SAME domain services the web UI uses.
 * Nothing here writes business rows directly.
 */
export async function processPending(actor: Actor, limit = 100) {
  const {parsePaymentBlocks} = await import('../history-extraction.mjs');
  const {parseEscortOrder} = await import('../escort-intake-candidate.mjs');
  const {orderDraftDateAndShift} = await import('../shift-boundary.ts');

  const messages = await rows<{
    id: string; account_id: string; chat_jid: string; message_id: string; direction: string;
    sender_jid: string | null; source_timestamp: string; text_content: string | null;
  }>(
    `SELECT id::text, account_id, chat_jid, message_id, direction, sender_jid, to_char(source_timestamp AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS source_timestamp, text_content
       FROM whatsapp_messages WHERE processed_at IS NULL ORDER BY id LIMIT $1`,
    [limit],
  );

  const result = {processed: 0, instructions: 0, programs: 0, confirmations: 0, ignored: 0, errors: 0};
  for (const message of messages) {
    let classification = 'IGNORED';
    try {
      const account = await row<WhatsAppAccount>('SELECT * FROM whatsapp_accounts WHERE id = $1', [message.account_id]);
      const chat = await row<{purpose: string}>(
        'SELECT purpose FROM whatsapp_chats WHERE account_id = $1 AND chat_jid = $2 AND authorized = true',
        [message.account_id, message.chat_jid],
      );
      const text = message.text_content ?? '';
      const isAdmin = !!account && account.admin_jids.includes(message.sender_jid ?? '');

      if (!chat || !text) {
        classification = 'IGNORED';
      } else if (message.direction === 'OUTGOING' && isAdmin && (chat.purpose === 'CASH' || chat.purpose === 'BOTH')) {
        const blocks = parsePaymentBlocks(text) as Array<{blockKey: string; fields: Record<string, string>; reasons: string[]}>;
        let created = 0;
        for (const block of blocks) {
          if (block.reasons.length) continue;
          const fields = block.fields;
          const inserted = await row(
            `INSERT INTO cash_instructions
               (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose,
                source_channel, source_message_id, source_block_key, source_hash, state, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'WHATSAPP',$8,$9,$10,'REVIEW','whatsapp')
             ON CONFLICT DO NOTHING RETURNING id`,
            [
              stableId('ins', [message.account_id, message.message_id, block.blockKey]),
              fields.employeeMobile ?? null,
              fields.employeeName,
              fields.payoutMobile ?? null,
              fields.method,
              Number(fields.amountMinor),
              fields.purpose ?? null,
              message.message_id,
              block.blockKey,
              stableId('h', [message.account_id, message.message_id, block.blockKey]),
            ],
          );
          if (inserted) created += 1;
        }
        classification = created ? `CASH:${created}` : 'CASH:0';
        result.instructions += created;
      } else if (message.direction === 'INCOMING' && (chat.purpose === 'ORDERS' || chat.purpose === 'BOTH')) {
        const messageInstant = message.source_timestamp;
        const blocks = parseEscortOrder(text, {messageDate: messageInstant.slice(0, 10)}) as Array<
          {motherVessel?: string; lighterVessel?: string; masterMobile?: string; destination?: string;
           assignmentDate?: string | null; shift?: string | null; reasons?: string[];
           fields?: Record<string, string | null | undefined>}
        >;
        let created = 0;
        const derived = orderDraftDateAndShift(messageInstant);
        for (const block of blocks ?? []) {
          const fields = (block.fields ?? block) as Record<string, string | null | undefined>;
          const motherVessel = fields.motherVessel ?? null;
          const lighterVessel = fields.lighterVessel ?? null;
          if (!motherVessel || !lighterVessel) continue;
          try {
            await createProgram(actor, {
              motherVessel,
              lighterVessel,
              masterMobile: (block.masterMobile as string | undefined) ?? fields.masterMobile ?? null,
              destination: fields.destination ?? null,
              startDate: block.assignmentDate ?? derived?.date ?? '',
              startShift: (block.shift as 'D' | 'N' | null) ?? derived?.shift ?? 'D',
              notes: block.assignmentDate ? null : 'START_DATE_DERIVED_FROM_MESSAGE_TIMESTAMP',
            }, {channel: 'WHATSAPP', messageId: message.message_id, chatJid: message.chat_jid});
            created += 1;
          } catch (error) {
            if ((error as Error).message.startsWith('DUPLICATE_PROGRAM')) continue;
            throw error;
          }
        }
        classification = created ? `ORDER_DRAFT:${created}` : 'ORDER_DRAFT:0';
        result.programs += created;
      } else if (message.direction === 'OUTGOING' && isAdmin && (chat.purpose === 'ORDERS' || chat.purpose === 'BOTH')) {
        classification = await applyConfirmation(actor, message, text);
        if (classification.startsWith('CONFIRMED')) result.confirmations += 1;
      }

      await row('UPDATE whatsapp_messages SET processed_at = now(), classification = $2 WHERE id = $1', [
        message.id, classification.slice(0, 120),
      ]);
      result.processed += 1;
    } catch (error) {
      result.errors += 1;
      await row('UPDATE whatsapp_messages SET processed_at = now(), classification = $2 WHERE id = $1', [
        message.id, `ERROR:${(error as Error).message.slice(0, 90)}`,
      ]);
    }
  }
  await recordAudit({actor, action: 'WHATSAPP_PROCESSED', entity: 'whatsapp', detail: result, source: 'SYSTEM'});
  return result;
}

/**
 * A verified administrator's outgoing reply that completes an existing draft is
 * the confirmation. It must match exactly one draft in the same chat; anything
 * else stays unresolved.
 */
async function applyConfirmation(actor: Actor, message: {message_id: string; chat_jid: string}, text: string) {
  const {parseEscortOrder} = await import('../escort-intake-candidate.mjs');
  const blocks = parseEscortOrder(text, {messageDate: new Date().toISOString().slice(0, 10)}) as Array<{
    motherVessel?: string; lighterVessel?: string; fields?: Record<string, string>;
    assignmentDate?: string | null; shift?: string | null;
  } & Record<string, unknown>>;
  const block = (blocks ?? []).find((candidate) => candidate.fields?.escortName || candidate.fields?.escortMobile);
  if (!block?.motherVessel || !block?.lighterVessel) return 'CONFIRMATION_NO_ASSIGNMENT';
  const candidates = await rows<{id: string; state: string}>(
    `SELECT id, state FROM programs
      WHERE source_chat_jid = $1 AND lower(btrim(mother_vessel)) = lower(btrim($2))
        AND lower(btrim(lighter_vessel)) = lower(btrim($3)) AND state IN ('DRAFT','CONFIRMED')
      ORDER BY created_at DESC LIMIT 2`,
    [message.chat_jid, block.motherVessel, block.lighterVessel],
  );
  if (candidates.length !== 1) return candidates.length ? 'CONFIRMATION_AMBIGUOUS' : 'CONFIRMATION_UNMATCHED';
  const fields = block.fields ?? {};
  const employee = fields.escortMobile ?? fields.employeeMobile;
  if (!employee) return 'CONFIRMATION_NO_EMPLOYEE';
  await assignEscort(actor, candidates[0].id, {
    employeeMobile: employee,
    employeeName: fields.escortName ?? employee,
    startDate: block.assignmentDate ?? undefined,
    startShift: block.shift ?? undefined,
  });
  await row(
    `UPDATE programs SET confirmation_message_id = $2, state = 'CONFIRMED' WHERE id = $1`,
    [candidates[0].id, message.message_id],
  );
  await recordAudit({actor, action: 'PROGRAM_CONFIRMED', entity: 'program', entityId: candidates[0].id,
    source: 'WHATSAPP', sourceRef: message.message_id});
  return 'CONFIRMED';
}

export async function integrationStatus() {
  const accounts = await rows(
    `SELECT a.id, a.label, a.enabled, a.account_jid, a.socket_path, a.token_file,
            (SELECT count(*)::text FROM whatsapp_chats c WHERE c.account_id = a.id AND c.authorized) AS chats,
            (SELECT count(*)::text FROM whatsapp_messages m WHERE m.account_id = a.id AND m.processed_at IS NULL) AS pending
       FROM whatsapp_accounts a ORDER BY a.label`,
  );
  const cursors = await rows('SELECT account_id, chat_jid, last_error, updated_at FROM whatsapp_cursors WHERE last_error IS NOT NULL');
  return {accounts, cursors};
}
