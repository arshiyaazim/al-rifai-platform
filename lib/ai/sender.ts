// WA-02 controlled outbound sender.
//
// Lifecycle: DRAFT -> PREVIEW -> APPROVED -> QUEUED -> SENDING -> SENT/FAILED/
// DELIVERY_UNKNOWN. Every transition is persisted before the bridge call and
// every attempt is recorded in `ai_outbound_attempts`.
//
// Safety rules enforced here:
//   * two independent kill switches (environment + database setting);
//   * Admin capability required for queue/send/retry;
//   * one idempotency key per draft; a SENT message can never be sent again;
//   * a transport timeout or dropped connection is DELIVERY_UNKNOWN and is
//     never retried automatically;
//   * a bridge-reported failure is FAILED and may be retried explicitly;
//   * bridge acceptance is not delivery: the state is BRIDGE_ACCEPTED.

import {row, rows, tx, DomainError, type Actor} from '../standalone/db.ts';
import {newId, recordAudit} from '../standalone/audit.ts';
import {assertCapability} from '../standalone/authz.ts';
import {existsSync} from 'node:fs';
import {callSocketTool} from '../standalone/whatsapp.ts';

const SENDER_SOCKET = () => (process.env.AI_WA02_SENDER_SOCKET ?? '/run/whatsapp-wa-02/mcp.sock').trim();
const SENDER_TOKEN = () => (process.env.AI_WA02_SENDER_TOKEN_FILE ?? '/run/secrets/wa-02-ai-sender.token').trim();
const senderConfigured = () => Boolean(SENDER_SOCKET() && SENDER_TOKEN() && existsSync(SENDER_SOCKET()) && existsSync(SENDER_TOKEN()));

export type OutboundConfig = {
  enabled: boolean;
  envEnabled: boolean;
  dbEnabled: boolean;
  accountId: string;
  senderConfigured: boolean;
  reason: string | null;
};

/** Read both kill switches without exposing configuration values. */
export async function outboundConfiguration(): Promise<OutboundConfig> {
  const envEnabled = process.env.AI_OUTBOUND_ENABLED === '1';
  const setting = await row<{value: unknown}>(
    "SELECT value FROM app_settings WHERE key = 'ai_outbound_enabled'",
  );
  const dbEnabled = setting?.value === true;
  const enabled = envEnabled && dbEnabled;
  return {
    enabled,
    envEnabled,
    dbEnabled,
    accountId: 'wa-02',
    senderConfigured: senderConfigured(),
    reason: enabled ? null : !envEnabled ? 'AI_OUTBOUND_ENV_DISABLED' : 'AI_OUTBOUND_DB_DISABLED',
  };
}

async function requireSender(actor: Actor) {
  assertCapability(actor, 'ai.send');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const config = await outboundConfiguration();
  if (!config.enabled) throw new DomainError(config.reason ?? 'AI_OUTBOUND_DISABLED', 409);
  if (!config.senderConfigured) throw new DomainError('AI_SENDER_SOCKET_NOT_CONFIGURED', 409);
  return config;
}

/** APPROVED -> QUEUED. No message leaves the process here. */
export async function queueOutbound(actor: Actor, id: string) {
  await requireSender(actor);
  return tx(async (client) => {
    const found = await client.query<{state: string; idempotency_key: string}>(
      'SELECT state, idempotency_key FROM ai_outbound_messages WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!found.rowCount) throw new DomainError('AI_DRAFT_NOT_FOUND', 404);
    const current = found.rows[0];
    if (current.state === 'QUEUED' || current.state === 'SENDING') return {id, state: current.state, sent: false};
    if (current.state === 'SENT') throw new DomainError('AI_ALREADY_SENT', 409);
    if (current.state === 'DELIVERY_UNKNOWN') throw new DomainError('AI_DELIVERY_AMBIGUOUS', 409);
    if (current.state !== 'APPROVED') throw new DomainError('AI_DRAFT_NOT_APPROVED', 409);
    await client.query(
      `UPDATE ai_outbound_messages SET state='QUEUED', queued_at=now(), updated_at=now() WHERE id=$1`,
      [id],
    );
    await recordAudit({actor, action: 'AI_OUTBOUND_QUEUED', entity: 'ai_outbound', entityId: id}, client);
    return {id, state: 'QUEUED', sent: false};
  });
}

type SendOutcome =
  | {kind: 'sent'; detail: string}
  | {kind: 'failed'; detail: string}
  | {kind: 'unknown'; detail: string};

async function deliver(recipientJid: string, content: string): Promise<SendOutcome> {
  const config = await outboundConfiguration();
  if (!config.enabled) return {kind: 'failed', detail: config.reason ?? 'AI_OUTBOUND_DISABLED'};
  try {
    const result = await callSocketTool(SENDER_SOCKET(), SENDER_TOKEN(), 'send_message', {
      recipient: recipientJid,
      message: content,
    });
    if (result.success === true) {
      const detail = typeof result.message === 'string' ? result.message.slice(0, 300) : 'BRIDGE_ACCEPTED';
      return {kind: 'sent', detail};
    }
    const detail = typeof result.message === 'string' ? result.message.slice(0, 300) : 'BRIDGE_REJECTED';
    return {kind: 'failed', detail};
  } catch (error) {
    // Timeout, dropped socket or protocol error: the bridge may or may not have
    // accepted the message. Never guess and never resend automatically.
    const code = error instanceof Error ? error.message : 'BRIDGE_UNKNOWN_ERROR';
    return {kind: 'unknown', detail: code.slice(0, 300)};
  }
}

/**
 * QUEUED -> SENDING -> terminal. The row lock is released before the network
 * call; a crash mid-send is recovered as DELIVERY_UNKNOWN, never as a retry.
 */
export async function sendOutbound(actor: Actor, id: string) {
  const config = await requireSender(actor);
  const claim = await tx(async (client) => {
    const found = await client.query<{
      state: string; attempts: number; recipient_jid: string; content: string; idempotency_key: string;
    }>(
      `SELECT state, attempts, recipient_jid, content, idempotency_key
         FROM ai_outbound_messages WHERE id = $1 FOR UPDATE`,
      [id],
    );
    if (!found.rowCount) throw new DomainError('AI_DRAFT_NOT_FOUND', 404);
    const current = found.rows[0];
    if (current.state === 'SENT') throw new DomainError('AI_ALREADY_SENT', 409);
    if (current.state === 'SENDING' || current.state === 'DELIVERY_UNKNOWN') {
      throw new DomainError('AI_DELIVERY_AMBIGUOUS', 409);
    }
    if (current.state !== 'QUEUED') throw new DomainError('AI_DRAFT_NOT_QUEUED', 409);
    const attemptNo = Number(current.attempts) + 1;
    await client.query(
      `UPDATE ai_outbound_messages
          SET state='SENDING', attempts=$2, send_started_at=now(), error=NULL, updated_at=now()
        WHERE id=$1`,
      [id, attemptNo],
    );
    await client.query(
      `INSERT INTO ai_outbound_attempts (id, outbound_id, attempt_no, state, request_ref)
       VALUES ($1,$2,$3,'SENDING',$4)`,
      [newId('aot'), id, attemptNo, current.idempotency_key],
    );
    return {attemptNo, recipientJid: current.recipient_jid, content: current.content};
  });

  const outcome = await deliver(claim.recipientJid, claim.content);
  const state = outcome.kind === 'sent' ? 'SENT' : outcome.kind === 'failed' ? 'FAILED' : 'DELIVERY_UNKNOWN';
  const deliveryState = outcome.kind === 'sent' ? 'BRIDGE_ACCEPTED' : null;

  await tx(async (client) => {
    await client.query(
      `UPDATE ai_outbound_messages
          SET state=$3::text, attempts=$2, sent_at=CASE WHEN $3::text='SENT' THEN now() ELSE sent_at END,
              delivery_state=COALESCE($4::text, delivery_state),
              delivery_ref=CASE WHEN $3::text='SENT' THEN $5::text ELSE delivery_ref END,
              error=CASE WHEN $3::text='SENT' THEN NULL ELSE $5::text END,
              updated_at=now()
        WHERE id=$1 AND state='SENDING'`,
      [id, claim.attemptNo, state, deliveryState, outcome.detail],
    );
    await client.query(
      `UPDATE ai_outbound_attempts
          SET state=$3::text, response=$4::jsonb,
              error=CASE WHEN $3::text='SENT' THEN NULL ELSE $5::text END, finished_at=now()
        WHERE outbound_id=$1 AND attempt_no=$2`,
      [id, claim.attemptNo, state, JSON.stringify({detail: outcome.detail}), outcome.detail],
    );
  });

  await recordAudit({
    actor,
    action: state === 'SENT' ? 'AI_OUTBOUND_SENT' : state === 'FAILED' ? 'AI_OUTBOUND_FAILED' : 'AI_OUTBOUND_DELIVERY_UNKNOWN',
    entity: 'ai_outbound',
    entityId: id,
    detail: {attempt: claim.attemptNo, account: config.accountId, ambiguous: state === 'DELIVERY_UNKNOWN'},
  });

  return {
    id,
    state,
    attempt: claim.attemptNo,
    // Bridge acceptance is explicitly not a delivery confirmation.
    delivery: deliveryState,
    detail: outcome.detail,
  };
}

/** Explicit retry for a bridge-reported failure only. */
export async function retryOutbound(actor: Actor, id: string) {
  await requireSender(actor);
  return tx(async (client) => {
    const found = await client.query<{state: string}>(
      'SELECT state FROM ai_outbound_messages WHERE id=$1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('AI_DRAFT_NOT_FOUND', 404);
    if (found.rows[0].state === 'DELIVERY_UNKNOWN') throw new DomainError('AI_DELIVERY_AMBIGUOUS_REQUIRES_REVIEW', 409);
    if (found.rows[0].state !== 'FAILED') throw new DomainError('AI_DRAFT_NOT_FAILED', 409);
    await client.query(
      "UPDATE ai_outbound_messages SET state='QUEUED', error=NULL, updated_at=now() WHERE id=$1", [id],
    );
    await recordAudit({actor, action: 'AI_OUTBOUND_REQUEUED', entity: 'ai_outbound', entityId: id}, client);
    return {id, state: 'QUEUED'};
  });
}

/**
 * A SENDING row older than the cutoff means the process died or the bridge
 * never answered. It becomes DELIVERY_UNKNOWN and is never resent.
 */
export async function recoverStaleOutbound(minutes = 10) {
  const bounded = Math.min(Math.max(Number(minutes) || 10, 1), 1440);
  const stale = await rows<{id: string; attempts: number}>(
    `SELECT id, attempts FROM ai_outbound_messages
      WHERE state='SENDING' AND send_started_at < now() - ($1 || ' minutes')::interval`,
    [String(bounded)],
  );
  for (const entry of stale) {
    await tx(async (client) => {
      await client.query(
        `UPDATE ai_outbound_messages
            SET state='DELIVERY_UNKNOWN', error='AI_SEND_ABANDONED', updated_at=now()
          WHERE id=$1 AND state='SENDING'`,
        [entry.id],
      );
      await client.query(
        `UPDATE ai_outbound_attempts
            SET state='DELIVERY_UNKNOWN', error='AI_SEND_ABANDONED', finished_at=now()
          WHERE outbound_id=$1 AND attempt_no=$2 AND state='SENDING'`,
        [entry.id, entry.attempts],
      );
    });
  }
  return {recovered: stale.length};
}

export async function outboundStatus(id: string) {
  return row(
    `SELECT id, conversation_id, account_id, chat_jid, recipient_jid, state, source_ref,
            approval_by, approved_at, queued_at, send_started_at, sent_at, delivery_state,
            delivery_ref, attempts, error, created_at, updated_at
       FROM ai_outbound_messages WHERE id=$1`,
    [id],
  );
}
