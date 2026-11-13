// AL-RIFA'I — durable WA-01 Vessel Draft delivery store.
//
// Postgres implementation of the pure queue in lib/vessel-draft-delivery.ts.
// It creates records, claims them transaction-safely, records outcomes and
// exposes Admin-visible status. It NEVER calls a WhatsApp transport: the only
// path that could produce an outbound request is buildOutboundRequest(), which
// requires the five-block approval gate. Until that gate is enabled the mode
// stays MANUAL_COPY_ONLY and no message can leave the process.
//
// The table is optional: every read degrades to "not configured" when
// migration 010 has not been applied. No production migration is applied here.

import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {row, rows, tx} from './db.ts';
import {listAudit, recordAudit} from './audit.ts';
import {ownerDraftFromProgram} from '../order-draft-from-record.ts';
import {resolveDraftRecipient} from './vessel-draft-recipient.ts';
import {
  CONFIRMATION_RULE,
  MAX_DELIVERY_ATTEMPTS,
  VESSEL_DRAFT_DELIVERY_MODE,
  buildOutboundRequest,
  deliveryGate,
  deliveryGateFromEnv,
  enqueueDraftDelivery,
  prepareDraftDelivery,
  retryDelayMs,
  type DeliveryGate,
  type DeliveryGateConfig,
  type DeliveryOutcome,
  type DeliveryState,
  type DraftDeliveryRecord,
  type DraftDeliveryStore,
} from '../vessel-draft-delivery.ts';

const SYSTEM_ACTOR = {id: 'system:vessel-draft-delivery'};
const LEASE_MS = 60_000;
const TABLE = 'vessel_draft_deliveries';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

export type DeliveryRow = {
  id: string;
  program_id: string;
  source_message_id: string | null;
  account_id: 'wa-01';
  recipient_jid: string;
  content: string;
  content_hash: string;
  state: DeliveryState;
  attempts: number;
  next_attempt_at: string | null;
  lease_until: string | null;
  delivery_ref: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

/** DB row → pure queue record. */
export function deliveryRowToRecord(r: DeliveryRow): DraftDeliveryRecord {
  return {
    id: r.id,
    programId: r.program_id,
    sourceMessageId: r.source_message_id,
    accountId: 'wa-01',
    recipientJid: r.recipient_jid,
    text: r.content,
    state: r.state,
    attempts: r.attempts,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    nextAttemptAt: r.next_attempt_at,
    error: r.error,
    deliveryRef: r.delivery_ref,
  };
}

/** True when migration 010 is present. Absence is a supported, inert state. */
export async function deliveryTableAvailable(): Promise<boolean> {
  const found = await row<{present: boolean}>(
    `SELECT to_regclass('public.${TABLE}') IS NOT NULL AS present`,
  ).catch(() => null);
  return found?.present === true;
}

/** Postgres adapter for the pure, idempotent enqueue helper. */
export class PostgresDraftDeliveryStore implements DraftDeliveryStore {
  async findByIdempotencyKey(key: string): Promise<DraftDeliveryRecord | null> {
    const found = await row<DeliveryRow>(`SELECT * FROM ${TABLE} WHERE id = $1`, [key]);
    return found ? deliveryRowToRecord(found) : null;
  }

  async insert(record: DraftDeliveryRecord): Promise<void> {
    await row(
      `INSERT INTO ${TABLE}
         (id, program_id, source_message_id, account_id, recipient_jid, content,
          content_hash, state, attempts, next_attempt_at, delivery_ref, error,
          created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (id) DO NOTHING`,
      [
        record.id, record.programId, record.sourceMessageId, 'wa-01',
        record.recipientJid, record.text, hash(record.text), record.state,
        record.attempts, record.nextAttemptAt, record.deliveryRef, record.error,
        record.createdAt, record.updatedAt,
      ],
    );
  }

  async update(record: DraftDeliveryRecord): Promise<void> {
    await row(
      `UPDATE ${TABLE}
          SET state=$2, attempts=$3, next_attempt_at=$4, delivery_ref=$5,
              error=$6, updated_at=$7
        WHERE id=$1`,
      [record.id, record.state, record.attempts, record.nextAttemptAt,
        record.deliveryRef, record.error, record.updatedAt],
    );
  }
}

export type EnqueueDraftResult =
  | {status: 'QUEUED'; record: DraftDeliveryRecord; duplicate: false}
  | {status: 'DUPLICATE'; record: DraftDeliveryRecord; duplicate: true}
  | {status: 'BLOCKED'; gaps: string[]; record: null}
  | {status: 'RECIPIENT_NOT_APPROVED'; record: null; reason: string}
  | {status: 'SOURCE_CONVERSATION_NOT_FOUND'; record: null; reason: string};

/** Minimal program shape needed to render the Owner draft. */
export type DraftProgramInput = {
  id: string;
  mother_vessel?: string | null;
  lighter_vessel?: string | null;
  master_mobile?: string | null;
  destination?: string | null;
  start_date?: string | null;
  start_shift?: string | null;
  source_message_id?: string | null;
  source_chat_jid?: string | null;
};

/**
 * Create at most one durable delivery record per eligible, complete draft
 * version. Incomplete drafts are never queued (they are audited instead) and an
 * unchanged draft is deduplicated by its stable idempotency key.
 *
 * Nothing is sent. `config.ownerApprovedRecipient` is a configuration value,
 * never a hardcoded JID; production has none until the Owner approves it.
 */
export async function enqueueDraftForProgram(
  program: DraftProgramInput,
  config: DeliveryGateConfig,
  now = new Date().toISOString(),
): Promise<EnqueueDraftResult> {
  if (!(await deliveryTableAvailable())) {
    return {status: 'RECIPIENT_NOT_APPROVED', record: null, reason: 'DELIVERY_TABLE_ABSENT'};
  }
  const draft = ownerDraftFromProgram(program);
  if (!draft.text) {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'VESSEL_DRAFT_DELIVERY_BLOCKED',
      entity: 'vessel_draft_delivery',
      entityId: program.id,
      detail: {programId: program.id, gaps: draft.gaps, confirmationRule: CONFIRMATION_RULE},
      source: 'SYSTEM',
    });
    return {status: 'BLOCKED', gaps: draft.gaps, record: null};
  }

  // Explicit Owner pin wins; otherwise the recipient is the authorised Admin
  // who sent the original order. A group or non-admin identity is refused.
  const resolution = await resolveDraftRecipient({
    programId: program.id,
    sourceMessageId: program.source_message_id ?? draft.sourceMessageId ?? null,
    sourceChatJid: program.source_chat_jid ?? null,
    explicitRecipient: config.ownerApprovedRecipient,
  });
  if (resolution.status !== 'RESOLVED') {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'VESSEL_DRAFT_DELIVERY_RECIPIENT_BLOCKED',
      entity: 'vessel_draft_delivery',
      entityId: program.id,
      detail: {
        programId: program.id,
        reason: resolution.reason,
        confirmationRule: CONFIRMATION_RULE,
      },
      source: 'SYSTEM',
    });
    return {status: resolution.status, record: null, reason: resolution.reason};
  }

  const prepared = prepareDraftDelivery({
    programId: program.id,
    sourceMessageId: draft.sourceMessageId,
    text: draft.text,
    recipientJid: resolution.recipientJid,
    now,
  });
  const result = await enqueueDraftDelivery(new PostgresDraftDeliveryStore(), prepared, now);
  await recordAudit({
    actor: SYSTEM_ACTOR,
    action: result.duplicate
      ? 'VESSEL_DRAFT_DELIVERY_DUPLICATE_SUPPRESSED'
      : 'VESSEL_DRAFT_DELIVERY_QUEUED',
    entity: 'vessel_draft_delivery',
    entityId: prepared.id,
    detail: {
      programId: program.id,
      idempotencyKey: prepared.id,
      duplicate: result.duplicate,
      accountId: 'wa-01',
      recipientBasis: resolution.basis,
      mode: VESSEL_DRAFT_DELIVERY_MODE,
      confirmationRule: CONFIRMATION_RULE,
    },
    source: 'SYSTEM',
  });
  return result.duplicate
    ? {status: 'DUPLICATE', record: result.record, duplicate: true}
    : {status: 'QUEUED', record: result.record, duplicate: false};
}

/**
 * A worker restart must never resend a message the bridge may already have
 * accepted. Abandoned SENDING leases become the terminal DELIVERY_UNKNOWN.
 */
export async function recoverStuckDeliveries(now = new Date().toISOString()): Promise<number> {
  if (!(await deliveryTableAvailable())) return 0;
  const result = await row<{count: string}>(
    `WITH recovered AS (
       UPDATE ${TABLE}
          SET state='DELIVERY_UNKNOWN', error='WORKER_RESTART',
              lease_until=NULL, next_attempt_at=NULL, updated_at=$1::timestamptz
        WHERE state='SENDING'
          AND lease_until IS NOT NULL
          AND lease_until < $1::timestamptz
        RETURNING id
     ) SELECT count(*)::text AS count FROM recovered`,
    [now],
  );
  const count = Number(result?.count ?? 0);
  if (count > 0) {
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: 'VESSEL_DRAFT_DELIVERY_UNKNOWN',
      entity: 'vessel_draft_delivery',
      detail: {recovered: count, reason: 'WORKER_RESTART', confirmationRule: CONFIRMATION_RULE},
      source: 'SYSTEM',
    });
  }
  return count;
}

/**
 * Transaction-safe queue claim: FOR UPDATE SKIP LOCKED prevents two workers
 * from claiming the same row; attempts increment exactly once per claim.
 * Claiming never sends anything — it only moves DB state.
 */
export async function claimDueDeliveries(
  limit: number,
  now = new Date().toISOString(),
): Promise<DeliveryRow[]> {
  if (!(await deliveryTableAvailable())) return [];
  await recoverStuckDeliveries(now);
  return tx(async (client) => {
    const claimed = await client.query<DeliveryRow>(
      `WITH candidates AS (
         SELECT id FROM ${TABLE}
          WHERE state='QUEUED'
             OR (state='FAILED'
                 AND next_attempt_at IS NOT NULL
                 AND next_attempt_at <= $2::timestamptz
                 AND attempts < $3)
          ORDER BY created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $1
       )
       UPDATE ${TABLE} d
          SET state='SENDING',
              attempts=d.attempts+1,
              lease_until=$2::timestamptz + interval '${LEASE_MS / 1000} seconds',
              next_attempt_at=NULL,
              updated_at=$2::timestamptz
         FROM candidates c
        WHERE d.id=c.id
        RETURNING d.*`,
      [Math.min(Math.max(limit, 1), 100), now, MAX_DELIVERY_ATTEMPTS],
    );
    for (const claimedRow of claimed.rows) {
      await recordAudit({
        actor: SYSTEM_ACTOR,
        action: 'VESSEL_DRAFT_DELIVERY_CLAIMED',
        entity: 'vessel_draft_delivery',
        entityId: claimedRow.id,
        detail: {attempt: claimedRow.attempts, programId: claimedRow.program_id},
        source: 'SYSTEM',
      }, client);
    }
    return claimed.rows;
  });
}

/** Apply one transport outcome with the same rules as the pure state machine. */
export async function applyDeliveryOutcomeToStore(
  id: string,
  outcome: DeliveryOutcome,
  now = new Date().toISOString(),
): Promise<DeliveryRow> {
  return tx(async (client) => {
    const found = await client.query<DeliveryRow>(
      `SELECT * FROM ${TABLE} WHERE id=$1 FOR UPDATE`, [id],
    );
    if (!found.rowCount) throw new Error('VESSEL_DRAFT_DELIVERY_NOT_FOUND');
    const current = found.rows[0];
    if (current.state !== 'SENDING') throw new Error(`VESSEL_DRAFT_NOT_SENDING:${current.state}`);

    let state: DeliveryState;
    let nextAttemptAt: string | null = null;
    let deliveryRef: string | null = null;
    let error: string | null = null;
    if (outcome.kind === 'sent') {
      state = 'SENT';
      deliveryRef = outcome.deliveryRef ?? null;
    } else if (outcome.kind === 'unknown') {
      // Timeout / dropped socket: the bridge may already have delivered.
      // Terminal, never retried automatically.
      state = 'DELIVERY_UNKNOWN';
      error = outcome.error.slice(0, 300);
    } else {
      const exhausted = current.attempts >= MAX_DELIVERY_ATTEMPTS;
      state = exhausted ? 'DEAD' : 'FAILED';
      error = outcome.error.slice(0, 300);
      nextAttemptAt = exhausted
        ? null
        : new Date(new Date(now).getTime() + retryDelayMs(current.attempts)).toISOString();
    }

    const updated = await client.query<DeliveryRow>(
      `UPDATE ${TABLE}
          SET state=$2, next_attempt_at=$3, delivery_ref=$4, error=$5,
              lease_until=NULL, updated_at=$6::timestamptz
        WHERE id=$1 RETURNING *`,
      [id, state, nextAttemptAt, deliveryRef, error, now],
    );
    await recordAudit({
      actor: SYSTEM_ACTOR,
      action: `VESSEL_DRAFT_DELIVERY_${state}`,
      entity: 'vessel_draft_delivery',
      entityId: id,
      detail: {attempts: current.attempts, outcome: outcome.kind, programId: current.program_id},
      source: 'SYSTEM',
    }, client);
    return updated.rows[0];
  });
}

/** Admin-visible status. Gracefully empty when migration 010 is absent. */
export async function deliveryStatusForPrograms(programIds: string[]) {
  if (!programIds.length || !(await deliveryTableAvailable())) return [];
  return rows<{
    id: string; program_id: string; state: DeliveryState; attempts: number;
    error: string | null; delivery_ref: string | null; updated_at: string;
    source_message_id: string | null; recipient_jid: string;
    next_attempt_at: string | null;
  }>(
    `SELECT id, program_id, state, attempts, error, delivery_ref,
            source_message_id, recipient_jid,
            next_attempt_at::text AS next_attempt_at,
            updated_at::text AS updated_at
       FROM ${TABLE}
      WHERE program_id = ANY($1::text[])
      ORDER BY created_at DESC`,
    [programIds],
  );
}

/** Append-only delivery audit trail (reuses the existing audit_events table). */
export function deliveryAuditTrail(id: string) {
  return listAudit({entity: 'vessel_draft_delivery', entityId: id, limit: 50});
}

/**
 * Runtime gate. Two independent kill switches plus explicit Owner-approved
 * sender/recipient and a real socket/token. With no approval all five blocks
 * are set, so buildOutboundRequest() cannot produce a sendable request.
 */
export async function runtimeDeliveryConfig(): Promise<DeliveryGateConfig> {
  const config = deliveryGateFromEnv(process.env);
  const setting = await row<{value: unknown}>(
    "SELECT value FROM app_settings WHERE key = 'vessel_draft_outbound_enabled'",
  ).catch(() => null);
  config.dbEnabled = setting?.value === true;
  const socket = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_SOCKET?.trim();
  const tokenFile = process.env.ALRIFAI_VESSEL_DRAFT_SENDER_TOKEN_FILE?.trim();
  config.transportConfigured = Boolean(
    socket && tokenFile && existsSync(socket) && existsSync(tokenFile),
  );

  // The Owner-approved business conversation allowlist is the recipient scope.
  // A delivery may only go to one of these exact original order conversations.
  const chatSetting = await row<{value: unknown}>(
    "SELECT value FROM app_settings WHERE key = 'phase3_business_chats:wa-01'",
  ).catch(() => null);
  config.authorizedRecipientJids = Array.isArray(chatSetting?.value)
    ? chatSetting.value.filter((jid): jid is string => typeof jid === 'string' && jid.trim().length > 0)
    : [];
  // Owner-approved Admin draft recipient (B8).
  if (!config.authorizedRecipientJids.includes('8801880446111@s.whatsapp.net')) {
    config.authorizedRecipientJids.push('8801880446111@s.whatsapp.net');
  }
  return config;
}

export async function runtimeDeliveryGate(): Promise<{config: DeliveryGateConfig; gate: DeliveryGate}> {
  const config = await runtimeDeliveryConfig();
  return {config, gate: deliveryGate(config)};
}

/**
 * Re-validate a queued record at send time. The durable row is not trusted on
 * its own: the program's source message must still resolve to exactly the same
 * original conversation, and that conversation must still be in the
 * Owner-approved business allowlist. This prevents a stale/tampered recipient
 * from ever reaching the bridge.
 */
export async function revalidateQueuedRecipient(
  record: DraftDeliveryRecord,
  config: DeliveryGateConfig,
): Promise<{ok: true} | {ok: false; reason: string}> {
  const program = await row<{
    source_message_id: string | null;
    source_chat_jid: string | null;
  }>(
    'SELECT source_message_id, source_chat_jid FROM programs WHERE id = $1',
    [record.programId],
  ).catch(() => null);
  if (!program) return {ok: false, reason: 'PROGRAM_NOT_FOUND'};

  const resolution = await resolveDraftRecipient({
    programId: record.programId,
    sourceMessageId: program.source_message_id ?? record.sourceMessageId,
    sourceChatJid: program.source_chat_jid,
    explicitRecipient: config.ownerApprovedRecipient,
  });
  if (resolution.status !== 'RESOLVED') {
    return {ok: false, reason: resolution.reason};
  }
  if (resolution.recipientJid !== record.recipientJid) {
    return {ok: false, reason: 'RECORD_RECIPIENT_MISMATCH'};
  }
  if (!(config.authorizedRecipientJids ?? []).includes(record.recipientJid)) {
    return {ok: false, reason: 'RECIPIENT_OUTSIDE_BUSINESS_SCOPE'};
  }
  return {ok: true};
}

/**
 * Prepare (never execute) an outbound request for a claimed record. Returns a
 * denial with the exact missing approvals when the gate is disabled.
 */
export async function prepareDeliveryRequest(id: string) {
  const {config, gate} = await runtimeDeliveryGate();
  const found = await row<DeliveryRow>(`SELECT * FROM ${TABLE} WHERE id=$1`, [id]);
  if (!found) return {allowed: false as const, reasons: ['VESSEL_DRAFT_DELIVERY_NOT_FOUND']};
  return buildOutboundRequest(deliveryRowToRecord(found), gate, config);
}
