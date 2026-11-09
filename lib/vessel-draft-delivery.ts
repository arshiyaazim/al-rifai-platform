// AL-RIFA'I — Vessel Draft delivery state machine (pure, no DB, no bridge, no send).
//
// The authorized WA-01 order → DRAFT program → Owner draft stages are already
// live. This module implements ONLY the internal, unarmed preparation of the
// remaining delivery stage:
//
//   draft record → idempotency key → queue → bounded retry → status →
//   (prepared) outbound request
//
// It never calls a WhatsApp transport, never writes to a database, never
// assigns an escort and never confirms a program. The Admin confirmation rule
// is unchanged: only the Admin's outgoing reply in the original order chat is
// applied by applyConfirmation(). A draft delivery is one-way to one Admin JID.
//
// ACTIVATION GATE: nothing here sends. Enabling an actual outbound transport
// requires separate Owner approval of the exact sender, recipient, account,
// chat scope and delivery behavior (see docs/VESSEL_DRAFT_DELIVERY_DESIGN.md).

import {createHash} from 'node:crypto';
import {jidsMatch} from './whatsapp-identity.mjs';

/** Current transport mode. Outbound is not approved and must stay disabled. */
export const VESSEL_DRAFT_DELIVERY_MODE = 'MANUAL_COPY_ONLY' as const;
/** WA-02 is identity-read only and its outbound tables are WA-02-only. */
export const VESSEL_DRAFT_OUTBOUND_ACCOUNT = 'wa-01' as const;

export const MAX_DELIVERY_ATTEMPTS = 3;
export const RETRY_BASE_MS = 60_000;

/**
 * Confirmation rule, deliberately stated next to the delivery code: a delivery
 * never confirms anything. The Admin replies from the existing WhatsApp client
 * in the ORIGINAL order chat; applyConfirmation() then assigns the escort and
 * sets CONFIRMED. Escort fields in the draft must always remain blank.
 */
export const CONFIRMATION_RULE =
  'Admin outgoing reply in the original order chat is the only confirmation; ' +
  'draft delivery is one-way and never assigns an escort or confirms a program.';

export type DeliveryState =
  | 'PREPARED'
  | 'QUEUED'
  | 'SENDING'
  | 'SENT'
  | 'FAILED'
  | 'DELIVERY_UNKNOWN'
  | 'DEAD'
  | 'CANCELLED';

export type DraftDeliveryRecord = {
  /** Stable idempotency key; also the durable record id. */
  id: string;
  programId: string;
  sourceMessageId: string | null;
  accountId: typeof VESSEL_DRAFT_OUTBOUND_ACCOUNT;
  /** Exact Owner-approved Admin JID. Supplied by config, never hardcoded here. */
  recipientJid: string;
  /** Exact Owner draft text; escort fields blank. */
  text: string;
  state: DeliveryState;
  attempts: number;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt: string | null;
  error: string | null;
  deliveryRef: string | null;
};

export type PrepareDraftDeliveryInput = {
  programId: string;
  sourceMessageId?: string | null;
  /** Exact Owner draft text produced by renderOwnerDraftFields(). */
  text: string;
  /** Owner-approved Admin JID (WA-01 account scope). */
  recipientJid: string;
  now?: string;
};

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/**
 * One idempotency key per (program, exact draft text, recipient). Re-sending an
 * unchanged draft is therefore impossible; a changed draft gets a new key and
 * would need a fresh Owner decision, not a silent retry.
 */
export function draftIdempotencyKey(input: {
  programId: string;
  text: string;
  recipientJid: string;
}): string {
  const canonical = [
    input.programId.trim(),
    sha256(input.text),
    input.recipientJid.trim(),
  ].join('\n');
  return `vdd_${sha256(canonical)}`;
}

/** The Owner draft must be the exact ten-line layout with blank escort fields. */
export function isOwnerDraftShape(text: string): boolean {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  if (lines.length < 9) return false;
  if (!/^Mother Vessel:\s*M\.V\.\s+.+/.test(lines[0])) return false;
  if (lines[1].trim() !== 'Importer') return false;
  if (!/^Lighter Vessel:\s*M\.V\.\s+.+/.test(lines[2])) return false;
  if (!/^Master mobile:-\d{5}-\d{6}$/.test(lines[3])) return false;
  if (!/^Destination:/.test(lines[4])) return false;
  if (!/^Escort Name:\s*$/.test(lines[5])) return false;
  if (!/^Escort mobile:\s*$/.test(lines[6])) return false;
  if (!/^\d{2}\/\d{2}\/\d{2}\s+\(\([DN]\)\)$/.test(lines[7])) return false;
  return lines.includes("Al-Rifa'i Integrated Services");
}

/** Build a PREPARED record. Never invents fields; rejects incomplete drafts. */
export function prepareDraftDelivery(input: PrepareDraftDeliveryInput): DraftDeliveryRecord {
  const programId = String(input.programId ?? '').trim();
  const text = String(input.text ?? '');
  const recipientJid = String(input.recipientJid ?? '').trim();
  if (!programId) throw new Error('VESSEL_DRAFT_PROGRAM_REQUIRED');
  if (!recipientJid) throw new Error('VESSEL_DRAFT_RECIPIENT_REQUIRED');
  if (!text.trim() || !isOwnerDraftShape(text)) throw new Error('VESSEL_DRAFT_TEXT_INVALID');
  const now = input.now ?? new Date().toISOString();
  return {
    id: draftIdempotencyKey({programId, text, recipientJid}),
    programId,
    sourceMessageId: input.sourceMessageId ?? null,
    accountId: VESSEL_DRAFT_OUTBOUND_ACCOUNT,
    recipientJid,
    text,
    state: 'PREPARED',
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: null,
    error: null,
    deliveryRef: null,
  };
}

/**
 * Minimal durable-store contract. A real implementation (new WA-01-safe table,
 * Owner-approved migration) can be plugged in later; the in-memory store used
 * by tests satisfies it today. No schema change is required for this module.
 */
export type DraftDeliveryStore = {
  findByIdempotencyKey(key: string): Promise<DraftDeliveryRecord | null> | DraftDeliveryRecord | null;
  insert(record: DraftDeliveryRecord): Promise<void> | void;
  update(record: DraftDeliveryRecord): Promise<void> | void;
};

/** In-memory store for isolated tests and local reasoning. */
export class MemoryDraftDeliveryStore implements DraftDeliveryStore {
  readonly records = new Map<string, DraftDeliveryRecord>();
  findByIdempotencyKey(key: string) {
    return this.records.get(key) ?? null;
  }
  insert(record: DraftDeliveryRecord) {
    this.records.set(record.id, {...record});
  }
  update(record: DraftDeliveryRecord) {
    this.records.set(record.id, {...record});
  }
}

/** Idempotent enqueue: an existing key is never queued twice. */
export async function enqueueDraftDelivery(
  store: DraftDeliveryStore,
  record: DraftDeliveryRecord,
  now = new Date().toISOString(),
): Promise<{record: DraftDeliveryRecord; duplicate: boolean; queued: boolean}> {
  const existing = await store.findByIdempotencyKey(record.id);
  if (existing) return {record: existing, duplicate: true, queued: false};
  if (record.state !== 'PREPARED') throw new Error(`VESSEL_DRAFT_NOT_PREPARED:${record.state}`);
  const queued: DraftDeliveryRecord = {...record, state: 'QUEUED', updatedAt: now};
  await store.insert(queued);
  return {record: queued, duplicate: false, queued: true};
}

export const retryDelayMs = (attempts: number): number =>
  RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1);

export function markSending(record: DraftDeliveryRecord, now = new Date().toISOString()): DraftDeliveryRecord {
  if (record.state !== 'QUEUED') throw new Error(`VESSEL_DRAFT_NOT_QUEUED:${record.state}`);
  return {
    ...record,
    state: 'SENDING',
    attempts: record.attempts + 1,
    updatedAt: now,
    nextAttemptAt: null,
    error: null,
  };
}

export type DeliveryOutcome =
  | {kind: 'sent'; deliveryRef?: string | null}
  | {kind: 'failed'; error: string}
  | {kind: 'unknown'; error: string};

/**
 * Apply one transport outcome. SENT and DELIVERY_UNKNOWN are terminal; a
 * bounded FAILED may be retried explicitly. DELIVERY_UNKNOWN is never retried
 * automatically because the bridge may already have delivered the message.
 */
export function applyDeliveryOutcome(
  record: DraftDeliveryRecord,
  outcome: DeliveryOutcome,
  now = new Date().toISOString(),
): DraftDeliveryRecord {
  if (record.state !== 'SENDING') throw new Error(`VESSEL_DRAFT_NOT_SENDING:${record.state}`);
  if (outcome.kind === 'sent') {
    return {
      ...record, state: 'SENT', updatedAt: now, nextAttemptAt: null,
      error: null, deliveryRef: outcome.deliveryRef ?? null,
    };
  }
  if (outcome.kind === 'unknown') {
    return {
      ...record, state: 'DELIVERY_UNKNOWN', updatedAt: now, nextAttemptAt: null,
      error: outcome.error.slice(0, 300), deliveryRef: null,
    };
  }
  const exhausted = record.attempts >= MAX_DELIVERY_ATTEMPTS;
  return {
    ...record,
    state: exhausted ? 'DEAD' : 'FAILED',
    updatedAt: now,
    nextAttemptAt: exhausted
      ? null
      : new Date(new Date(now).getTime() + retryDelayMs(record.attempts)).toISOString(),
    error: outcome.error.slice(0, 300),
    deliveryRef: null,
  };
}

export function isRetryDue(record: DraftDeliveryRecord, now = new Date().toISOString()): boolean {
  return record.state === 'FAILED'
    && record.attempts < MAX_DELIVERY_ATTEMPTS
    && record.nextAttemptAt !== null
    && new Date(record.nextAttemptAt).getTime() <= new Date(now).getTime();
}

/** Requeue only an eligible, due FAILED record. Never duplicates a send. */
export function requeueDelivery(record: DraftDeliveryRecord, now = new Date().toISOString()): DraftDeliveryRecord {
  if (!isRetryDue(record, now)) throw new Error('VESSEL_DRAFT_RETRY_NOT_DUE');
  return {...record, state: 'QUEUED', updatedAt: now, nextAttemptAt: null};
}

// ---------------------------------------------------------------------------
// Outbound gate — two kill switches plus explicit Owner-approved identities.
// ---------------------------------------------------------------------------

export type DeliveryGateConfig = {
  envEnabled: boolean;
  dbEnabled: boolean;
  ownerApprovedSender: string | null;
  ownerApprovedRecipient: string | null;
  transportConfigured: boolean;
  /**
   * Owner-approved business conversation JIDs for WA-01
   * (`app_settings.phase3_business_chats:wa-01`). A delivery may only go to one
   * of these exact conversations. The recipient is the original order-giving
   * conversation resolved by `resolveDraftRecipient()`, never an Admin fallback.
   */
  authorizedRecipientJids?: string[];
};

/** Read the env-side gate. No transport is opened and no secret is exposed. */
export function deliveryGateFromEnv(env: Record<string, string | undefined> = process.env): DeliveryGateConfig {
  return {
    envEnabled: env.ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED === '1',
    dbEnabled: false, // DB kill switch must be read by the runtime, never assumed
    ownerApprovedSender: env.ALRIFAI_VESSEL_DRAFT_SENDER_JID?.trim() || null,
    ownerApprovedRecipient: env.ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID?.trim() || null,
    transportConfigured: false, // socket/token existence checked by the runtime
    authorizedRecipientJids: [],
  };
}

/**
 * True when a recipient is one of the Owner-approved business conversations and
 * matches the optional explicit pin. Groups are valid here: the original order
 * may have come from an approved group.
 */
export function isApprovedDraftRecipient(
  recipientJid: string,
  config: DeliveryGateConfig,
): boolean {
  const recipient = String(recipientJid ?? '').trim();
  if (!recipient) return false;
  const allowed = config.authorizedRecipientJids ?? [];
  if (!allowed.some((jid) => jidsMatch(jid, recipient))) return false;
  if (config.ownerApprovedRecipient) {
    return jidsMatch(config.ownerApprovedRecipient, recipient);
  }
  return true;
}

export type DeliveryGate = {
  enabled: boolean;
  reasons: string[];
  mode: typeof VESSEL_DRAFT_DELIVERY_MODE | 'OUTBOUND_APPROVED';
};

export function deliveryGate(config: DeliveryGateConfig): DeliveryGate {
  const reasons: string[] = [];
  if (!config.envEnabled) reasons.push('VESSEL_DRAFT_OUTBOUND_ENV_DISABLED');
  if (!config.dbEnabled) reasons.push('VESSEL_DRAFT_OUTBOUND_DB_DISABLED');
  if (!config.ownerApprovedSender) reasons.push('VESSEL_DRAFT_SENDER_NOT_APPROVED');
  if (
    !config.ownerApprovedRecipient
    && !(config.authorizedRecipientJids ?? []).length
  ) reasons.push('VESSEL_DRAFT_RECIPIENT_NOT_APPROVED');
  if (!config.transportConfigured) reasons.push('VESSEL_DRAFT_TRANSPORT_NOT_CONFIGURED');
  return {
    enabled: reasons.length === 0,
    reasons,
    mode: reasons.length === 0 ? 'OUTBOUND_APPROVED' : VESSEL_DRAFT_DELIVERY_MODE,
  };
}

export type OutboundRequest = {
  accountId: typeof VESSEL_DRAFT_OUTBOUND_ACCOUNT;
  recipientJid: string;
  text: string;
  idempotencyKey: string;
};

/**
 * Prepare (never execute) the smallest possible outbound request. The runtime
 * would pass this to a single narrow `send_message` bridge call; this function
 * only returns data and never invokes a transport.
 */
export function buildOutboundRequest(
  record: DraftDeliveryRecord,
  gate: DeliveryGate,
  config: DeliveryGateConfig,
): {allowed: false; reasons: string[]} | {allowed: true; request: OutboundRequest} {
  if (!gate.enabled) return {allowed: false, reasons: gate.reasons};
  if (record.state === 'SENT' || record.state === 'DELIVERY_UNKNOWN') {
    return {allowed: false, reasons: ['VESSEL_DRAFT_DELIVERY_TERMINAL']};
  }
  if (record.state !== 'QUEUED' && record.state !== 'SENDING') {
    return {allowed: false, reasons: [`VESSEL_DRAFT_NOT_SENDABLE:${record.state}`]};
  }
  if (!isApprovedDraftRecipient(record.recipientJid, config)) {
    return {allowed: false, reasons: ['VESSEL_DRAFT_RECIPIENT_MISMATCH']};
  }
  return {
    allowed: true,
    request: {
      accountId: VESSEL_DRAFT_OUTBOUND_ACCOUNT,
      recipientJid: record.recipientJid,
      text: record.text,
      idempotencyKey: record.id,
    },
  };
}

/** Display projection for the Admin workspace. Never reports a send as done. */
export function deliveryViewModel(record: DraftDeliveryRecord, gate: DeliveryGate) {
  return {
    mode: gate.mode,
    state: record.state,
    draftKey: record.id,
    attempts: record.attempts,
    sent: record.state === 'SENT',
    notSentReason: gate.enabled ? null : gate.reasons[0] ?? 'OUTBOUND_NOT_APPROVED',
    confirmationRule: CONFIRMATION_RULE,
    escortFieldsBlank: /^Escort Name:\s*$/m.test(record.text) && /^Escort mobile:\s*$/m.test(record.text),
  };
}
