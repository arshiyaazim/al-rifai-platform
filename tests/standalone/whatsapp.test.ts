// Adapter test against a MOCK of the WhatsApp MCP relay contract.
// It proves the client speaks the observed protocol (unix socket, token line,
// newline-delimited JSON-RPC tools/call). It does NOT prove a live WhatsApp
// connection: no device is paired and no real bridge is contacted.
import assert from 'node:assert/strict';
import test from 'node:test';
import {createServer} from 'node:net';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {row} from '../../lib/standalone/db.ts';
import {configureAccount, health, syncAccount, processPending} from '../../lib/standalone/whatsapp.ts';

const admin = {id: 'a'.repeat(64), role: 'ADMIN' as const};
const dir = mkdtempSync(join(tmpdir(), 'wa-mock-'));
const socketPath = join(dir, 'mcp.sock');
const tokenFile = join(dir, 'token');
writeFileSync(tokenFile, 'mock-reader-token\n', {mode: 0o600});

const TOKEN = 'mock-reader-token';
const ACCOUNT = `mock-${Date.now().toString(36)}`;
const messagesByChat = {
  '120363000000000001@g.us': [
    {
      status: 'CONTENT',
      envelope: {
        nativeMessageId: `wamid.${ACCOUNT}.order.1`,
        chatJid: '120363000000000001@g.us',
        chatType: 'group',
        direction: 'INCOMING',
        senderJid: '8801711111111@s.whatsapp.net',
        sourceTimestamp: '2026-11-07T10:00:00.000Z',
        payload: {text: 'Mother Vessel: MV Ocean Star\nLighter Vessel: L-77\nMaster mobile: 01911111111\nDestination: Chattogram\n17/11/26(D)', sha256: 'a'.repeat(64)},
      },
    },
  ],
  '8801844836824@s.whatsapp.net': [
    {
      status: 'CONTENT',
      envelope: {
        nativeMessageId: `wamid.${ACCOUNT}.cash.1`,
        chatJid: '8801844836824@s.whatsapp.net',
        chatType: 'direct',
        direction: 'OUTGOING',
        senderJid: '8801880446111@s.whatsapp.net',
        sourceTimestamp: '2026-11-07T11:00:00.000Z',
        payload: {text: 'ID: 01712345678 Rahim Uddin 01812345678(B) 1,250.50/- duty pay', sha256: 'b'.repeat(64)},
      },
    },
  ],
};

const server = createServer((socket) => {
  let authenticated = false;
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let index = buffer.indexOf('\n');
    while (index >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf('\n');
      if (!authenticated) {
        assert.equal(line, TOKEN);
        authenticated = true;
        continue;
      }
      const request = JSON.parse(line);
      const name = request.params?.name;
      const args = request.params?.arguments ?? {};
      let structuredContent = {};
      if (name === 'get_native_account_identity') {
        structuredContent = {accountId: 'mock', jid: '8801880446111@s.whatsapp.net'};
      } else if (name === 'list_native_messages') {
        const records = messagesByChat[args.chat_jid] ?? [];
        structuredContent = {records, nextCursor: null, complete: true};
      }
      socket.write(`${JSON.stringify({jsonrpc: '2.0', id: request.id, result: {structuredContent}})}\n`);
    }
  });
});

test('whatsapp adapter: configure, health, sync, fail-closed routing default', async () => {
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  try {
    await configureAccount(admin, {
      id: ACCOUNT, label: 'Mock relay', socketPath, tokenFile,
      adminJids: ['8801880446111@s.whatsapp.net'], enabled: true,
      chats: [
        {chatJid: '120363000000000001@g.us', label: 'Orders', purpose: 'ORDERS'},
        {chatJid: '8801844836824@s.whatsapp.net', label: 'Cash', purpose: 'CASH'},
      ],
    });

    const status = await health(ACCOUNT);
    assert.equal(status.ok, true);
    assert.equal(status.state, 'CONNECTED');

    const sync = await syncAccount(admin, ACCOUNT);
    assert.equal(sync.stored, 2);
    const staged = await row('SELECT count(*)::int AS n FROM whatsapp_messages WHERE account_id = $1', [ACCOUNT]);
    assert.equal(staged.n, 2);

    // The adapter test covers transport/storage only. Domain routing is covered
    // by the 49 router tests and the 18 cutover tests; here we assert the
    // Live Router's documented fail-closed default with no activation settings.
    await row(
      `INSERT INTO app_settings (key, value) VALUES ('phase3_router_enabled', 'false'::jsonb)
       ON CONFLICT (key) DO UPDATE SET value = 'false'::jsonb, updated_at = now()`,
    );
    const processed = await processPending(admin, 10);
    assert.equal(processed.disabled, true, 'router is disabled by default');
    assert.ok(typeof processed.reason === 'string' && processed.reason.length > 0);
    assert.equal(processed.instructions, 0);
    assert.equal(processed.programs, 0);

    // Re-sync must not duplicate anything.
    const again = await syncAccount(admin, ACCOUNT);
    assert.equal(again.stored, 0);
    const after = await row('SELECT count(*)::int AS n FROM whatsapp_messages WHERE account_id = $1', [ACCOUNT]);
    assert.equal(after.n, 2);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
