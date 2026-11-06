// WA-02 outbound sender integration tests against a mock MCP bridge socket.
// No real WhatsApp session, network or recipient is involved.
import assert from 'node:assert/strict';
import test, {after, before} from 'node:test';
import net from 'node:net';
import {mkdtempSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {row, rows} from '../../lib/standalone/db.ts';
import {resetBusinessState} from './reset.mjs';
import {approveOutbound, createOutboundDraft} from '../../lib/ai/store.ts';
import {
  outboundConfiguration, queueOutbound, recoverStaleOutbound, retryOutbound, sendOutbound,
} from '../../lib/ai/sender.ts';

const admin = {id: '7'.repeat(64), role: 'ADMIN'};
const user = {id: '8'.repeat(64), role: 'USER'};

const servers = [];

function mockBridge(mode) {
  const dir = mkdtempSync('/tmp/opencode/wa02-send-');
  const socketPath = join(dir, 'mcp.sock');
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, 'test-token\n', {mode: 0o600});
  const state = {calls: 0};
  const server = net.createServer((socket) => {
    let buffer = '';
    let authed = false;
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf('\n');
        if (!line) continue;
        if (!authed) { authed = true; continue; }
        const message = JSON.parse(line);
        state.calls += 1;
        if (mode.value === 'drop') { socket.destroy(); return; }
        const structured = mode.value === 'fail'
          ? {success: false, message: 'bridge rejected the message'}
          : {success: true, message: 'Message sent successfully'};
        socket.write(`${JSON.stringify({jsonrpc: '2.0', id: message.id, result: {structuredContent: structured}})}\n`);
      }
    });
    socket.on('error', () => undefined);
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(socketPath, () => resolve({
      socketPath, tokenFile, calls: () => state.calls,
    }));
  });
}

async function configureSender(socketPath, tokenFile) {
  process.env.AI_WA02_SENDER_SOCKET = socketPath;
  process.env.AI_WA02_SENDER_TOKEN_FILE = tokenFile;
  await row(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('ai_outbound_enabled','true'::jsonb,now())
     ON CONFLICT (key) DO UPDATE SET value='true'::jsonb, updated_at=now()`,
  );
}

async function freshDraft(content) {
  return createOutboundDraft({
    conversationId: null,
    accountId: 'wa-02',
    chatJid: '8801700000123@s.whatsapp.net',
    recipientJid: '8801700000123@s.whatsapp.net',
    content,
  });
}

before(async () => {
  await resetBusinessState('alrifai-sender-test-reset');
  await row("UPDATE app_settings SET value='false'::jsonb WHERE key='ai_outbound_enabled'");
  process.env.AI_OUTBOUND_ENABLED = '1';
});

after(async () => {
  delete process.env.AI_OUTBOUND_ENABLED;
  delete process.env.AI_AUTO_REPLY_ENABLED;
  delete process.env.AI_WA02_SENDER_SOCKET;
  delete process.env.AI_WA02_SENDER_TOKEN_FILE;
  for (const server of servers) await new Promise((resolve) => server.close(() => resolve()));
});

test('both kill switches are required before a draft can be queued', async () => {
  const bridge = await mockBridge({value: 'ok'});
  await configureSender(bridge.socketPath, bridge.tokenFile);
  const draft = await freshDraft('kill switch test');
  await approveOutbound(admin, draft.id);

  process.env.AI_OUTBOUND_ENABLED = '0';
  await assert.rejects(() => queueOutbound(admin, draft.id), /AI_OUTBOUND_ENV_DISABLED/);
  process.env.AI_OUTBOUND_ENABLED = '1';
  await row("UPDATE app_settings SET value='false'::jsonb WHERE key='ai_outbound_enabled'");
  await assert.rejects(() => queueOutbound(admin, draft.id), /AI_OUTBOUND_DB_DISABLED/);
  await row("UPDATE app_settings SET value='true'::jsonb WHERE key='ai_outbound_enabled'");
  const config = await outboundConfiguration();
  assert.equal(config.enabled, true);
});

test('a general user cannot queue or send', async () => {
  const bridge = await mockBridge({value: 'ok'});
  await configureSender(bridge.socketPath, bridge.tokenFile);
  const draft = await freshDraft('role test');
  await approveOutbound(admin, draft.id);
  await assert.rejects(() => queueOutbound(user, draft.id), /CAPABILITY_REQUIRED/);
});

test('a bridge-accepted message is SENT once with durable attempt evidence', async () => {
  const bridge = await mockBridge({value: 'ok'});
  await configureSender(bridge.socketPath, bridge.tokenFile);
  const draft = await freshDraft('approved outbound test');
  await approveOutbound(admin, draft.id);
  await queueOutbound(admin, draft.id);
  const sent = await sendOutbound(admin, draft.id);
  assert.equal(sent.state, 'SENT');
  assert.equal(sent.delivery, 'BRIDGE_ACCEPTED');
  assert.equal(bridge.calls(), 1);

  const stored = await row('SELECT state, attempts, delivery_state, sent_at FROM ai_outbound_messages WHERE id=$1', [draft.id]);
  assert.equal(stored.state, 'SENT');
  assert.equal(Number(stored.attempts), 1);
  assert.equal(stored.delivery_state, 'BRIDGE_ACCEPTED');
  assert.ok(stored.sent_at);

  const attempts = await rows('SELECT state, attempt_no FROM ai_outbound_attempts WHERE outbound_id=$1', [draft.id]);
  assert.equal(attempts.length, 1);
  assert.equal(attempts[0].state, 'SENT');

  await assert.rejects(() => sendOutbound(admin, draft.id), /AI_ALREADY_SENT/);
  assert.equal(bridge.calls(), 1, 'no second bridge call after SENT');
});

test('a bridge-reported failure is FAILED and can be retried explicitly', async () => {
  const mode = {value: 'fail'};
  const bridge = await mockBridge(mode);
  await configureSender(bridge.socketPath, bridge.tokenFile);
  const draft = await freshDraft('retry test');
  await approveOutbound(admin, draft.id);
  await queueOutbound(admin, draft.id);

  const failed = await sendOutbound(admin, draft.id);
  assert.equal(failed.state, 'FAILED');
  const stored = await row('SELECT state, error FROM ai_outbound_messages WHERE id=$1', [draft.id]);
  assert.equal(stored.state, 'FAILED');
  assert.match(String(stored.error), /rejected/);

  const requeued = await retryOutbound(admin, draft.id);
  assert.equal(requeued.state, 'QUEUED');
  mode.value = 'ok';
  const retried = await sendOutbound(admin, draft.id);
  assert.equal(retried.state, 'SENT');
  assert.equal(retried.attempt, 2);
  assert.equal(bridge.calls(), 2);
});

test('a dropped bridge connection is DELIVERY_UNKNOWN and is never auto-resent', async () => {
  const bridge = await mockBridge({value: 'drop'});
  await configureSender(bridge.socketPath, bridge.tokenFile);
  const draft = await freshDraft('ambiguous delivery test');
  await approveOutbound(admin, draft.id);
  await queueOutbound(admin, draft.id);

  const result = await sendOutbound(admin, draft.id);
  assert.equal(result.state, 'DELIVERY_UNKNOWN');
  assert.equal(result.delivery, null);
  await assert.rejects(() => sendOutbound(admin, draft.id), /AI_DELIVERY_AMBIGUOUS/);
  await assert.rejects(() => retryOutbound(admin, draft.id), /AI_DELIVERY_AMBIGUOUS_REQUIRES_REVIEW/);
  assert.equal(bridge.calls(), 1);

  const stored = await row('SELECT state, attempts FROM ai_outbound_messages WHERE id=$1', [draft.id]);
  assert.equal(stored.state, 'DELIVERY_UNKNOWN');
  assert.equal(Number(stored.attempts), 1);
});

test('a stale SENDING row is recovered as DELIVERY_UNKNOWN, not retried', async () => {
  const draft = await freshDraft('stale send test');
  await row(
    `UPDATE ai_outbound_messages SET state='SENDING', attempts=1,
            send_started_at=now() - interval '30 minutes' WHERE id=$1`,
    [draft.id],
  );
  await row(
    `INSERT INTO ai_outbound_attempts (id, outbound_id, attempt_no, state)
     VALUES ($1,$2,1,'SENDING')`,
    [`aot-stale-${draft.id}`.slice(0, 100), draft.id],
  );
  const result = await recoverStaleOutbound(10);
  assert.ok(result.recovered >= 1);
  const stored = await row('SELECT state, error FROM ai_outbound_messages WHERE id=$1', [draft.id]);
  assert.equal(stored.state, 'DELIVERY_UNKNOWN');
  assert.equal(stored.error, 'AI_SEND_ABANDONED');
  const attempt = await row('SELECT state FROM ai_outbound_attempts WHERE outbound_id=$1', [draft.id]);
  assert.equal(attempt.state, 'DELIVERY_UNKNOWN');
});
