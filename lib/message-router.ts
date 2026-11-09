// AL-RIFA'I — Phase 3: shared message router (Increments 1–4).
//
// Single canonical processing entry point for staged WhatsApp messages.
// Both the background worker (processPending) and the ADMIN API (?action=route)
// route through routePendingMessages(), so there is exactly one code path that
// can create Cash instructions or Vessel programs from WhatsApp messages.
//
// Processing model (crash-safe):
//   1. CLAIM: atomically mark a batch of messages PROCESSING (FOR UPDATE SKIP LOCKED).
//      Short transaction, no external calls, row locks released immediately.
//   2. PROCESS: run domain handlers (cash/vessel/confirmation). Each business
//      service manages its own transaction. No row locks held across calls.
//   3. COMPLETE: mark each message COMPLETED or FAILED with retry tracking.
//      A message is never marked COMPLETED before its business action is
//      durably committed by the domain service.
//
// Idempotency:
//   - Cash: idempotent by (source_message_id, source_block_key) via
//     cash_instructions_source_identity unique index.
//   - Vessel: createProgram() generates a deterministic programId and checks
//     potentialDuplicates internally; exact duplicates throw DUPLICATE_PROGRAM.
//     Multi-message correlation tracked via program_source_messages.
//   - Review: review_items.one_pending unique index on (domain, target_ref)
//     WHERE state = 'PENDING' prevents duplicate pending items.
//
// Cash: Admin (WA-01) OUTGOING payment instructions are auto-POSTED by the
// Owner-approved Cash exception. Vessel and other domains keep their existing
// authorization flows. No outbound WhatsApp sender exists.
// WA-02 is raw-ingestion/identity-only; no business processing from WA-02.

import {row, rows, tx, type Actor} from './standalone/db.ts';
import {newId, stableId, recordAudit} from './standalone/audit.ts';
import {autoPostInstruction} from './standalone/finance.ts';
import {createProgram, potentialDuplicates, releaseProgram} from './standalone/programs.ts';
import {submitForReview} from './standalone/review.ts';
import {classifyDomain, type ClassificationResult, type Domain} from './message-classifier.ts';
import {jidsMatch} from './whatsapp-identity.mjs';
import {isAuthorizedCashConversation, isAuthorizedEscortClientConversation} from './authorized-contacts.ts';
import {RULE_VERSION} from './business-rules.mjs';
import {vesselKey} from './vessel-match.ts';
import {approvedGroupRole, resolveSourceRole, type SourceRole} from './source-roles.ts';
import {featureConfig, isFeatureEnabled} from './feature-flags.ts';
import {computeConfirmationScore} from './pipelines/vessel/fuzzy-match.ts';
import type {WhatsAppAccount} from './standalone/whatsapp.ts';

const ORDER_INTAKE_JIDS = new Set([
  '8801670535255@s.whatsapp.net',
  '166082241384593@lid',
  '8801836743754@s.whatsapp.net',
  '8801757622300@s.whatsapp.net',
]);

export type RouterResult = {
  processed: number;
  instructions: number;
  programs: number;
  confirmations: number;
  releases: number;
  reviewItems: number;
  ignored: number;
  errors: number;
  disabled?: boolean;
  reason?: string | null;
  byMessage: Array<{
    messageId: string;
    classification: string;
    domain: Domain;
    action: string;
  }>;
};

export type MessageToProcess = {
  id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  direction: string;
  sender_jid: string | null;
  source_timestamp: string;
  text_content: string | null;
  processing_status: string;
  retry_count: number;
  last_error: string | null;
};

/**
 * Review category for router-generated review items.
 */
export type ReviewCategory =
  | 'UNKNOWN_IDENTITY'
  | 'AMBIGUOUS_DOMAIN'
  | 'INCOMPLETE_CASH_INSTRUCTION'
  | 'CASH_DUPLICATE_CANDIDATE'
  | 'INCOMPLETE_VESSEL_ORDER'
  | 'VESSEL_DUPLICATE_CANDIDATE'
  | 'AMBIGUOUS_VESSEL_CONFIRMATION'
  | 'UNMATCHED_VESSEL_ASSIGNMENT'
  | 'EXTRACTION_FAILED'
  | 'PROCESSING_ERROR';

// ── Live Router activation / cutover configuration ──────────────────────
// Automated router writes are attributed to a stable system identity. The
// invoking human is recorded on the batch audit row. This is what allows the
// sole human Administrator to review and approve router-created Cash items
// without violating the "reviewer is not submitter" rule.
const SYSTEM_ACTOR: Actor = {id: 'system:whatsapp-router', role: 'ADMIN'};

const ROUTER_ENABLED_KEY = 'phase3_router_enabled';
const cutoverKey = (accountId: string) => `phase3_cutover_rowid:${accountId}`;
const businessChatsKey = (accountId: string) => `phase3_business_chats:${accountId}`;

type RouterConfig = {
  enabled: boolean;
  reason: string | null;
  watermarks: Map<string, bigint>;
  businessChats: Map<string, Set<string>>;
};

function parseWatermark(value: unknown): bigint | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === 'string' && /^[0-9]+$/.test(value.trim())) {
    try {
      return BigInt(value.trim());
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * The Live Router is default-disabled. It requires all of:
 *   phase3_router_enabled = true
 *   phase3_cutover_rowid:<account> = an explicit non-negative integer
 *   phase3_business_chats:<account> = an explicit array of chat JIDs (empty is
 *     valid for an identity-only account such as WA-02)
 * for every account present in whatsapp_sync_state. Missing or invalid values
 * fail closed; zero is only accepted when written explicitly. The watermark is
 * never advanced automatically.
 */
async function loadRouterConfig(): Promise<RouterConfig> {
  const disabled = (reason: string): RouterConfig => ({
    enabled: false,
    reason,
    watermarks: new Map(),
    businessChats: new Map(),
  });

  const settings = await rows<{key: string; value: unknown}>(
    `SELECT key, value FROM app_settings
      WHERE key = $1 OR key LIKE 'phase3_cutover_rowid:%' OR key LIKE 'phase3_business_chats:%'`,
    [ROUTER_ENABLED_KEY],
  );
  const byKey = new Map(settings.map((setting) => [setting.key, setting.value]));
  if (byKey.get(ROUTER_ENABLED_KEY) !== true) return disabled('ROUTER_DISABLED');

  const accounts = await rows<{account_id: string}>(
    'SELECT account_id FROM whatsapp_sync_state ORDER BY account_id',
  );
  if (!accounts.length) return disabled('ROUTER_NO_ACCOUNTS');

  const watermarks = new Map<string, bigint>();
  const businessChats = new Map<string, Set<string>>();
  for (const {account_id: accountId} of accounts) {
    const watermark = parseWatermark(byKey.get(cutoverKey(accountId)));
    if (watermark === null) return disabled(`CUTOVER_WATERMARK_MISSING:${accountId}`);
    const chats = byKey.get(businessChatsKey(accountId));
    // An explicit empty array is valid for identity-only accounts (WA-02): it
    // means no business chat is ever claimed. Missing or non-array is invalid.
    if (!Array.isArray(chats) || !chats.every((chat) => typeof chat === 'string' && chat.trim() !== '')) {
      return disabled(`BUSINESS_CHATS_INVALID:${accountId}`);
    }
    watermarks.set(accountId, watermark);
    businessChats.set(accountId, new Set(chats as string[]));
  }
  return {enabled: true, reason: null, watermarks, businessChats};
}

/**
 * Claim a batch of messages for processing. Marks them PROCESSING atomically
 * so a concurrent worker or restart will not pick up the same messages.
 *
 * Eligible messages:
 *   - processing_status = 'PENDING' (never claimed)
 *   - processing_status = 'FAILED' AND retry_count < 10 AND
 *     last_processed_at older than 10 minutes (retry after backoff)
 *   - processing_status = 'PROCESSING' AND last_processed_at older than
 *     30 minutes (stale: worker crashed mid-processing)
 *
 * Row locks are held only for the duration of this short transaction.
 */
async function claimMessages(
  limit: number,
): Promise<MessageToProcess[]> {
  return tx(async (client) => {
    const claimed = await client.query<MessageToProcess>(
      `SELECT m.id::text, m.account_id, m.chat_jid, m.message_id::text, m.direction,
              m.sender_jid, to_char(m.source_timestamp AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_timestamp, m.text_content,
              m.processing_status, m.retry_count, m.last_error
         FROM whatsapp_messages m
        WHERE (
          (m.processing_status = 'PENDING'
           AND (m.last_processed_at IS NULL
                OR m.last_processed_at < now() - interval '1 minute'))
          OR (m.processing_status = 'FAILED' AND m.retry_count < 10
              AND (m.last_processed_at IS NULL
                   OR m.last_processed_at < now() - interval '10 minutes'))
          OR (m.processing_status = 'PROCESSING'
              AND m.last_processed_at < now() - interval '30 minutes')
        )
          -- Live Router eligibility: only messages above the account's own
          -- immutable cutover watermark. Historical rows stay untouched.
          AND m.source_rowid IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM app_settings s
             WHERE s.key = 'phase3_cutover_rowid:' || m.account_id
               AND jsonb_typeof(s.value) = 'number'
               AND m.source_rowid > (s.value #>> '{}')::bigint
          )
          -- Capture authorization is not business authorization. Only chats
          -- explicitly allowlisted for business processing are claimed.
          AND EXISTS (
            SELECT 1 FROM app_settings b
             WHERE b.key = 'phase3_business_chats:' || m.account_id
               AND jsonb_typeof(b.value) = 'array'
               AND b.value ? m.chat_jid
          )
        ORDER BY m.id
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    if (claimed.rowCount === 0) return [];

    await client.query(
      `UPDATE whatsapp_messages
            SET processing_status = 'PROCESSING',
                last_processed_at = now()
          WHERE id = ANY($1::bigint[])`,
      [claimed.rows.map((r) => BigInt(r.id))],
    );
    return claimed.rows;
  });
}

/**
 * Mark a single message as processing outcome. Called after the business
 * action is durably committed. Never marks COMPLETED before business writes.
 */
async function markOutcome(
  client: Pick<import('pg').PoolClient, 'query'>,
  messageId: string,
  status: 'COMPLETED' | 'FAILED',
  classification: string,
  error: string | null,
  incrementRetry: boolean,
): Promise<void> {
  const retryClause = incrementRetry
    ? 'retry_count = retry_count + 1,'
    : 'retry_count = retry_count,';
  await client.query(
    `UPDATE whatsapp_messages
          SET processing_status = $2,
              classification = $3,
              last_error = $4,
              last_processed_at = now(),
              ${retryClause}
              processed_at = now()
        WHERE id = $1`,
    [messageId, status, classification.slice(0, 120), error ?? null],
  );
}

type ChatPolicy = {
  authorized: boolean;
  purpose: string | null;
  label: string | null;
  sourceRole: SourceRole | null;
};

/**
 * Read the conversation policy. Authorization still comes from
 * `whatsapp_chats.authorized`; the business role comes from the explicit
 * `source_role` column, the configured release-group setting, the approved
 * three-group map, or (for direct chats only) the operator-configured purpose.
 * Anything else fails closed as REVIEW_REQUIRED. The pure resolution rule is
 * shared with the read models in `lib/source-roles.ts`.
 */
async function loadChatPolicy(accountId: string, chatJid: string): Promise<ChatPolicy> {
  const chat = await row<{purpose: string | null; authorized: boolean; label: string | null; source_role: SourceRole | null}>(
    `SELECT purpose, authorized, label, source_role
       FROM whatsapp_chats
      WHERE account_id = $1 AND chat_jid = $2`,
    [accountId, chatJid],
  );
  if (!chat || !chat.authorized) {
    return {authorized: false, purpose: chat?.purpose ?? null, label: chat?.label ?? null, sourceRole: null};
  }
  const purpose = chat.purpose ?? 'BOTH';
  const releaseConfigured = chatJid.endsWith('@g.us')
    ? await isConfiguredReleaseGroup(accountId, chatJid)
    : false;
  const sourceRole = resolveSourceRole({
    chatJid,
    purpose,
    storedRole: chat.source_role,
    releaseConfigured,
  });
  return {authorized: true, purpose, label: chat.label ?? null, sourceRole};
}

/**
 * Check whether a chat is authorized for the given domain and direction.
 * Uses whatsapp_chats.authorized + purpose (existing contract).
 */
async function isChatAuthorized(
  accountId: string,
  chatJid: string,
): Promise<{authorized: boolean; purpose: string | null; sourceRole: SourceRole | null}> {
  const policy = await loadChatPolicy(accountId, chatJid);
  return {authorized: policy.authorized, purpose: policy.purpose, sourceRole: policy.sourceRole};
}

/**
 * Vessel authorization: only WA-01 account may create vessel business records.
 * WA-02 is rejected with a configuration-gap classification.
 */
async function isVesselAuthorized(
  accountId: string,
): Promise<{authorized: boolean; reason: string | null}> {
  if (accountId !== 'wa-01') {
    return {authorized: false, reason: 'VESSEL_WA02_NOT_AUTHORIZED'};
  }
  return {authorized: true, reason: null};
}

/**
 * Group participant authorization: verifies that a sender in a group chat is
 * an approved participant for that exact group. Falls back to chat-level
 * authorization for direct chats.
 */
async function isGroupParticipantAuthorized(
  accountId: string,
  chatJid: string,
  senderJid: string | null,
): Promise<{authorized: boolean; reason: string | null}> {
  // Direct chats: participant is the sender
  if (!chatJid.endsWith('@g.us')) {
    return {authorized: true, reason: null};
  }

  // Group chats: check approved participant whitelist
  const tableExists = await row<{exists: boolean}>(
    `SELECT to_regclass('public.escort_client_group_authorizations') IS NOT NULL AS exists`,
  );
  if (!tableExists?.exists) {
    // Table not yet deployed — fail closed with configuration gap
    return {
      authorized: false,
      reason: 'GROUP_AUTHORIZATION_TABLE_MISSING',
    };
  }

  const auth = await rows<{participant_jid: string}>(
    `SELECT participant_jid
           FROM escort_client_group_authorizations
          WHERE account_id = $1
            AND group_jid = $2
            AND active = true`,
    [accountId, chatJid],
  );

  // Compare normalized identity forms. The bridge stores bare sender IDs while
  // legacy authorization rows used full PN/LID JIDs; exact string comparison
  // would fail closed for every approved participant.
  const matched = auth.some((entry) => jidsMatch(entry.participant_jid, senderJid));
  if (!matched) {
    return {authorized: false, reason: 'GROUP_PARTICIPANT_NOT_AUTHORIZED'};
  }

  return {authorized: true, reason: null};
}

/**
 * Record a source-message reference for a vessel program. Supports multi-message
 * correlation: one program can have multiple contributing messages.
 */
async function recordProgramSource(
  programId: string,
  accountId: string,
  chatJid: string,
  messageId: string,
  sourceRole: 'primary' | 'contributor' = 'contributor',
): Promise<void> {
  const id = stableId('psm', [programId, accountId, chatJid, messageId]);
  await row(
    `INSERT INTO program_source_messages
       (id, program_id, account_id, chat_jid, message_id, source_role)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (program_id, account_id, chat_jid, message_id) DO NOTHING`,
    [id, programId, accountId, chatJid, messageId, sourceRole],
  );
}

/**
 * Find a recently created vessel program in the same chat that could be the
 * correlation target for a multi-message order. Matches on mother vessel and
 * master mobile, within the same chat, created recently.
 */
async function findCorrelatedProgram(
  accountId: string,
  chatJid: string,
  motherVessel: string,
  masterMobile: string | null,
): Promise<{id: string; mother_vessel: string; lighter_vessel: string} | null> {
  const candidate = await row<{id: string; mother_vessel: string; lighter_vessel: string}>(
    `SELECT p.id, p.mother_vessel, p.lighter_vessel
       FROM programs p
      WHERE p.source_channel = 'WHATSAPP'
        AND p.source_chat_jid = $2
        AND lower(btrim(p.mother_vessel)) = lower(btrim($1))
        AND ($3::text IS NULL OR p.master_mobile = $3)
        AND p.created_at > now() - interval '24 hours'
        AND p.state IN ('DRAFT','ASSIGNED','CONFIRMED')
      ORDER BY p.created_at DESC
      LIMIT 1`,
    [motherVessel, chatJid, masterMobile ?? null],
  );
  return candidate;
}

/**
 * Submit a review item with deduplication. Uses the existing
 * review_items.one_pending unique index to prevent duplicate pending items
 * for the same (domain, target_ref). Returns false if already pending.
 */
async function submitReviewItem(
  actor: Actor,
  domain: 'CASH' | 'PROGRAM',
  action: 'CREATE' | 'UPDATE' | 'DELETE',
  targetRef: string | null,
  category: ReviewCategory,
  payload: Record<string, unknown>,
): Promise<{submitted: boolean; itemId: string | null}> {
  // CASH domain is rejected by submitForReview() — use cash_submissions instead
  if (domain === 'CASH') {
    const canonical = JSON.stringify(payload);
    const id = newId('sub');
    try {
      await row(
        `INSERT INTO cash_submissions
           (id, payload, payload_hash, submitted_by, state,
            source_message_id, source_chat_jid, source_account_id, category)
         VALUES ($1,$2::jsonb,$3,$4,'PENDING_REVIEW',$5,$6,$7,$8) RETURNING id`,
        [id, canonical, stableId('h', [canonical]), actor.id,
          targetRef,
          typeof payload.sourceChatJid === 'string' ? payload.sourceChatJid : null,
          typeof payload.sourceAccountId === 'string' ? payload.sourceAccountId : null,
          category],
      );
      await recordAudit({
        actor,
        action: 'CASH_SUBMISSION_FROM_WHATSAPP',
        entity: 'cash_submission',
        entityId: id,
        detail: {sourceMessageId: targetRef, category, source: 'WHATSAPP'},
        sourceRef: targetRef,
      });
      return {submitted: true, itemId: id};
    } catch {
      // Duplicate payload_hash — already submitted
      return {submitted: false, itemId: null};
    }
  }

  // PROGRAM domain via submitForReview()
  try {
    const created = await submitForReview(actor, {
      domain,
      action,
      targetRef,
      payload: {category, ...payload},
    });
    return {submitted: true, itemId: created.id};
  } catch (err) {
    if ((err as Error).message === 'PENDING_REVIEW_EXISTS') {
      return {submitted: false, itemId: null};
    }
    throw err;
  }
}

/**
 * Parse a message for cash and auto-POST every clean payment block.
 *
 * Owner-approved Cash exception: a verified Admin (WA-01) OUTGOING payment
 * instruction in the Accountant direct chat is financially confirmed when sent.
 * It creates POSTED + posting + ledger in one transaction. Incomplete blocks
 * still go to cash_submissions PENDING_REVIEW.
 */
async function handleCash(
  actor: Actor,
  message: MessageToProcess,
  text: string,
): Promise<{created: boolean; instructionsCreated: number; reviewSubmitted: boolean; reasons: string[]}> {
  const {parsePaymentBlocks} = await import('./history-extraction.mjs');
  const blocks = parsePaymentBlocks(text) as Array<{
    blockKey: string;
    blockOrder: number;
    fields: Record<string, string>;
    reasons: string[];
  }>;

  const clean = (blocks ?? []).filter((b) => b.reasons.length === 0);
  const incomplete = (blocks ?? []).filter((b) => b.reasons.length > 0);
  let instructionsCreated = 0;
  let reviewSubmitted = false;
  const reasons: string[] = [];

  for (const block of clean) {
    const fields = block.fields;
    const amountMinor = Number(fields.amountMinor);
    if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
      reasons.push('AMOUNT_INVALID_OR_MISSING');
      continue;
    }
    if (!fields.method) {
      reasons.push('PAYMENT_METHOD_UNRESOLVED');
      continue;
    }
    if (!fields.employeeMobile || !fields.employeeName) {
      reasons.push('EMPLOYEE_IDENTITY_UNRESOLVED');
      continue;
    }
    const existing = await row(
      'SELECT 1 AS present FROM cash_instructions WHERE source_message_id = $1 AND source_block_key = $2',
      [message.message_id, block.blockKey],
    );
    if (existing) continue;
    const created = await autoPostInstruction(actor, {
      employeeMobile: fields.employeeMobile ?? null,
      employeeName: fields.employeeName ?? '',
      payoutMobile: fields.payoutMobile ?? fields.employeeMobile ?? null,
      method: fields.method,
      amountMinor,
      purpose: fields.purpose ?? null,
      accountId: 'acc-cash',
      sourceChannel: 'WHATSAPP',
      sourceMessageId: message.message_id,
      sourceBlockKey: block.blockKey,
      sourceHash: stableId('h', [message.account_id, message.message_id, block.blockKey]),
    }, {
      eventAt: message.source_timestamp,
      sourceMessageId: message.message_id,
      sourceBlockKey: block.blockKey,
      sourceHash: stableId('h', [message.account_id, message.message_id, block.blockKey]),
      auditAction: 'CASH:AUTO_POSTED',
      auditSource: 'WHATSAPP',
      whatsAppVerified: true,
    });
    if (created) instructionsCreated += 1;
  }

  // Any ambiguous/incomplete block is preserved for Office review. It never
  // becomes a Business Paid Event until a human corrects and approves it.
  if (incomplete.length) {
    reasons.push(...incomplete.flatMap((b) => b.reasons));
    const first = incomplete[0];
    const submitted = await submitReviewItem(actor, 'CASH', 'CREATE', message.message_id,
      'INCOMPLETE_CASH_INSTRUCTION', {
        sourceMessageId: message.message_id,
        sourceChatJid: message.chat_jid,
        sourceAccountId: message.account_id,
        sourceTimestamp: message.source_timestamp,
        senderJid: message.sender_jid,
        rawText: text,
        fields: first.fields,
        blockKey: first.blockKey,
        parseReasons: [...new Set(reasons)],
        blocks: incomplete.map((b) => ({blockKey: b.blockKey, fields: b.fields, reasons: b.reasons})),
        parser: 'parsePaymentBlocks',
        parserVersion: 'history-extraction-v3',
        needsReviewerCorrection: true,
      });
    reviewSubmitted = submitted.submitted;
  }

  if (!clean.length && !incomplete.length) {
    // No payment block at all: preserve the raw message for review.
    const submitted = await submitReviewItem(actor, 'CASH', 'CREATE', message.message_id,
      'EXTRACTION_FAILED', {
        sourceMessageId: message.message_id,
        sourceChatJid: message.chat_jid,
        sourceAccountId: message.account_id,
        sourceTimestamp: message.source_timestamp,
        senderJid: message.sender_jid,
        rawText: text,
        parseReasons: ['NO_PARSEABLE_BLOCK'],
        parser: 'parsePaymentBlocks',
        parserVersion: 'history-extraction-v3',
        needsReviewerCorrection: true,
      });
    reviewSubmitted = submitted.submitted;
    reasons.push('NO_PARSEABLE_BLOCK');
  }

  return {created: instructionsCreated > 0, instructionsCreated, reviewSubmitted,
    reasons: [...new Set(reasons)]};
}

/**
 * Release groups are recognised only by an explicit approved source:
 *   - the configured `phase3_release_groups:<account>` setting, or
 *   - the approved group JID constant, or
 *   - an explicit `whatsapp_chats.source_role = 'RELEASE_ONLY'`.
 * A display-name keyword is never used: a group called "Release Slip" is not
 * authorization.
 */
async function isConfiguredReleaseGroup(accountId: string, chatJid: string): Promise<boolean> {
  const setting = await row<{value: unknown}>(
    "SELECT value FROM app_settings WHERE key = 'phase3_release_groups:' || $1",
    [accountId],
  );
  if (Array.isArray(setting?.value) && setting.value.includes(chatJid)) return true;
  return approvedGroupRole(chatJid)?.role === 'RELEASE_ONLY';
}

/**
 * Read-only candidate matching for unstructured release evidence. Nothing is
 * updated here: the router only records which programs the evidence could
 * refer to so a reviewer can decide. Strongest available identity wins.
 */
async function matchUnstructuredReleaseCandidates(fields: {
  motherVessel: string | null;
  lighterVessel: string | null;
  escortMobile: string | null;
}): Promise<{ids: string[]; matchedBy: string[]}> {
  const clauses: string[] = [];
  const values: string[] = [];
  const matchedBy: string[] = [];
  if (fields.escortMobile && /^01[3-9][0-9]{8}$/.test(fields.escortMobile)) {
    values.push(`+88${fields.escortMobile}`);
    clauses.push(`escort_mobile = $${values.length}`);
    matchedBy.push('ESCORT_MOBILE');
  } else if (fields.lighterVessel) {
    values.push(fields.lighterVessel);
    clauses.push(`lower(btrim(lighter_vessel)) = lower(btrim($${values.length}))`);
    matchedBy.push('LIGHTER_VESSEL');
  } else if (fields.motherVessel) {
    values.push(fields.motherVessel);
    clauses.push(`lower(btrim(mother_vessel)) = lower(btrim($${values.length}))`);
    matchedBy.push('MOTHER_VESSEL');
  }
  if (!clauses.length) return {ids: [], matchedBy: []};
  const candidates = await rows<{id: string}>(
    `SELECT id FROM programs
      WHERE state NOT IN ('VOIDED','COMPLETED')
        AND (${clauses.join(' OR ')})
      ORDER BY start_date DESC
      LIMIT 10`,
    values,
  );
  return {ids: candidates.map((candidate) => candidate.id), matchedBy};
}

/**
 * Apply a structured Escort Release Slip to exactly one matching program.
 * Ambiguous or incomplete slips are sent to review and never release a program.
 */
async function handleReleaseSlip(
  actor: Actor,
  message: MessageToProcess,
  text: string,
  blocks: Array<{blockKey: string; fields: Record<string, string | number | null>; reasons: string[]}>,
): Promise<{created: boolean; reviewSubmitted: boolean; reasons: string[]; programsCreated?: number; releases?: number; idempotent?: number; blocked?: boolean}> {
  let released = 0;
  let idempotent = 0;
  let reviewSubmitted = false;
  const reasons: string[] = [];
  for (const block of blocks) {
    const fields = block.fields as {
      motherVessel: string | null; lighterVessel: string | null; escortMobile: string | null;
      startDate: string | null; startShift: 'D' | 'N' | null; endDate: string | null;
      endShift: 'D' | 'N' | null; totalDays: number | null; foodBillMinor: number | null;
    };
    const escortMobile = fields.escortMobile ? `+88${fields.escortMobile}` : null;
    if (block.reasons.length || !escortMobile || !fields.endDate || !fields.endShift) {
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'INCOMPLETE_VESSEL_ORDER', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields,
          reasons: block.reasons.length ? block.reasons : ['ESCORT_MOBILE_UNRESOLVED', 'RELEASE_DATE_UNRESOLVED'],
          releaseCategory: 'RELEASE_INCOMPLETE',
          parser: 'release-slip', ruleVersion: RULE_VERSION,
        });
      if (submitted.submitted) reviewSubmitted = true;
      reasons.push(...(block.reasons.length ? block.reasons : ['RELEASE_INCOMPLETE']));
      continue;
    }
    // Strong match: the existing program for this Escort with the released
    // Lighter/Mother on or before the release date. A completed program is
    // included so an already-finished duty is reported, never silently matched.
    // Vessel comparison uses the shared normalized key, so "M.V. Release",
    // "MV Release" and "Release" are the same vessel.
    const candidateRows = await rows<{
      id: string; state: string; start_date: string; end_date: string | null;
      end_shift: string | null; release_message_id: string | null;
      mother_vessel: string; lighter_vessel: string;
    }>(
      `SELECT id, state, start_date::text AS start_date, end_date::text AS end_date,
              end_shift, release_message_id, mother_vessel, lighter_vessel
         FROM programs
        WHERE escort_mobile = $1
          AND state <> 'VOIDED'
          AND start_date <= $2
          AND ($3::date IS NULL OR start_date = $3)
        ORDER BY start_date DESC`,
      [escortMobile, fields.endDate, fields.startDate ?? null],
    );
    const candidates = candidateRows.filter((candidate) =>
      (!fields.lighterVessel || vesselKey(candidate.lighter_vessel) === vesselKey(fields.lighterVessel))
      && (!fields.motherVessel || vesselKey(candidate.mother_vessel) === vesselKey(fields.motherVessel)));
    if (candidates.length !== 1) {
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'UNMATCHED_VESSEL_ASSIGNMENT', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields,
          candidates: candidates.map((candidate) => candidate.id),
          releaseCategory: candidates.length ? 'RELEASE_AMBIGUOUS' : 'RELEASE_PROGRAM_NOT_MATCHED',
          parser: 'release-slip', ruleVersion: RULE_VERSION,
        });
      if (submitted.submitted) reviewSubmitted = true;
      reasons.push(candidates.length ? 'RELEASE_AMBIGUOUS' : 'RELEASE_PROGRAM_NOT_MATCHED');
      continue;
    }
    const candidate = candidates[0];
    if (candidate.state === 'COMPLETED') {
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'UNMATCHED_VESSEL_ASSIGNMENT', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields,
          programId: candidate.id,
          releaseCategory: 'RELEASE_PROGRAM_ALREADY_COMPLETED',
          parser: 'release-slip', ruleVersion: RULE_VERSION,
        });
      if (submitted.submitted) reviewSubmitted = true;
      reasons.push('RELEASE_PROGRAM_ALREADY_COMPLETED');
      continue;
    }
    if (candidate.state === 'RELEASED') {
      const sameValues = candidate.end_date === fields.endDate && candidate.end_shift === fields.endShift;
      if (sameValues) {
        // Replayed release: record the source evidence once and change nothing.
        await recordProgramSource(candidate.id, message.account_id, message.chat_jid, message.message_id, 'contributor');
        idempotent += 1;
        reasons.push('RELEASE_ALREADY_APPLIED');
        continue;
      }
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'UNMATCHED_VESSEL_ASSIGNMENT', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields,
          programId: candidate.id,
          existingEndDate: candidate.end_date,
          existingEndShift: candidate.end_shift,
          releaseCategory: 'RELEASE_CONFLICT_EXISTING_RELEASE',
          parser: 'release-slip', ruleVersion: RULE_VERSION,
        });
      if (submitted.submitted) reviewSubmitted = true;
      reasons.push('RELEASE_CONFLICT_EXISTING_RELEASE');
      continue;
    }
    try {
      await releaseProgram(actor, candidate.id, {
        endDate: fields.endDate,
        endShift: fields.endShift,
        note: `WhatsApp release slip ${message.message_id}`,
        release: {
          messageId: message.message_id,
          chatJid: message.chat_jid,
          senderJid: message.sender_jid,
          accountId: message.account_id,
          timestamp: message.source_timestamp,
        },
      });
      await recordProgramSource(candidate.id, message.account_id, message.chat_jid, message.message_id, 'contributor');
      released += 1;
    } catch (error) {
      const code = (error as Error).message.split(':')[0];
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'PROCESSING_ERROR', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields,
          programId: candidate.id,
          error: code,
          releaseCategory: 'RELEASE_APPLY_FAILED',
          parser: 'release-slip', ruleVersion: RULE_VERSION,
        });
      if (submitted.submitted) reviewSubmitted = true;
      reasons.push(`RELEASE_APPLY_FAILED:${code}`);
    }
  }
  return {created: false, reviewSubmitted, reasons, programsCreated: 0, releases: released, idempotent};
}

/**
 * Bounded, source-bound multi-message order merge.
 *
 * A client sometimes sends the Mother/Lighter in one message and the Master
 * Mobile in the next. An incomplete block may merge with a PENDING
 * INCOMPLETE_VESSEL_ORDER review item only when all of these hold:
 *   - same account and the same authorised client conversation;
 *   - created within the last 30 minutes;
 *   - shares the same Lighter Vessel or the same Mother Vessel;
 *   - never contradicts an already-present field.
 * The earlier review item is withdrawn after the merged Draft is committed.
 * Nothing is merged across conversations, accounts, clients or vessel families.
 */
async function findMergeableIncompleteOrder(
  accountId: string,
  chatJid: string,
  messageId: string,
  fields: {motherVessel: string | null; lighterVessel: string | null; masterMobile: string | null;
    destination: string | null; assignmentDate: string | null; shift: string | null},
): Promise<{reviewId: string; priorMessageId: string | null; fields: typeof fields} | null> {
  const items = await rows<{id: string; target_ref: string | null; payload: Record<string, unknown>}>(
    `SELECT id, target_ref, payload
       FROM review_items
      WHERE domain = 'PROGRAM'
        AND state = 'PENDING'
        AND category = 'INCOMPLETE_VESSEL_ORDER'
        AND coalesce(target_ref, '') <> $3
        AND payload->>'sourceChatJid' = $2
        AND payload->>'sourceAccountId' = $1
        AND created_at > now() - interval '30 minutes'
      ORDER BY created_at DESC
      LIMIT 20`,
    [accountId, chatJid, messageId],
  );
  for (const item of items) {
    const prior = (item.payload.fields ?? {}) as Record<string, unknown>;
    const priorFields = {
      motherVessel: typeof prior.motherVessel === 'string' ? prior.motherVessel : null,
      lighterVessel: typeof prior.lighterVessel === 'string' ? prior.lighterVessel : null,
      masterMobile: typeof prior.masterMobile === 'string' ? prior.masterMobile : null,
      destination: typeof prior.destination === 'string' ? prior.destination : null,
      assignmentDate: typeof prior.assignmentDate === 'string' ? prior.assignmentDate : null,
      shift: typeof prior.shift === 'string' ? prior.shift : null,
    };
    const sameLighter = Boolean(fields.lighterVessel && priorFields.lighterVessel
      && vesselKey(fields.lighterVessel) === vesselKey(priorFields.lighterVessel));
    const sameMother = Boolean(fields.motherVessel && priorFields.motherVessel
      && vesselKey(fields.motherVessel) === vesselKey(priorFields.motherVessel));
    // A Lighter is the strongest anchor: when both fragments name one they must
    // be the same Lighter. The Mother is only an anchor when one side omits the
    // Lighter entirely (e.g. a Mother+Masters fragment).
    if (fields.lighterVessel && priorFields.lighterVessel) {
      if (!sameLighter) continue;
    } else if (!sameMother) {
      continue;
    }
    const merged = {...fields};
    let conflict = false;
    for (const key of ['motherVessel', 'lighterVessel', 'masterMobile', 'destination', 'assignmentDate', 'shift'] as const) {
      const current = merged[key];
      const incoming = priorFields[key];
      if (current && incoming && current !== incoming) {
        if (key === 'shift' || key === 'masterMobile' || key === 'motherVessel' || key === 'lighterVessel') conflict = true;
        continue;
      }
      if (!current && incoming) merged[key] = incoming;
    }
    if (conflict) continue;
    return {reviewId: item.id, priorMessageId: item.target_ref, fields: merged};
  }
  return null;
}

/**
 * Parse a message for vessel order and optionally create program(s) in DRAFT.
 * Supports multiple lighter vessels per message and multi-message correlation.
 * Reuses createProgram() (verified business rule: DRAFT state only).
 * Duplicates and missing fields go to Review Queue (PROGRAM domain).
 *
 * Source enforcement (added 2026-11-08):
 *   - ORDER_INTAKE: verified DIRECT Escort Client conversation only; incoming.
 *   - RELEASE_ONLY: the approved release group only; release processing only.
 *   - SUPPORT_ONLY / OTHER_APPROVED / REVIEW_REQUIRED / CASH_ONLY: never an
 *     order or release source. Order-shaped text is context, not a Draft.
 */
async function handleVessel(
  actor: Actor,
  message: MessageToProcess,
  text: string,
  sourceRole: SourceRole | null,
): Promise<{created: boolean; reviewSubmitted: boolean; reasons: string[]; programsCreated?: number; releases?: number; idempotent?: number; blocked?: boolean}> {
  // Vessel authorization: WA-01 only
  const vesselAuth = await isVesselAuthorized(message.account_id);
  if (!vesselAuth.authorized) {
    return {created: false, reviewSubmitted: false, reasons: [vesselAuth.reason as string]};
  }

  const {parseReleaseSlips, parseUnstructuredRelease} = await import('./release-slip.ts');

  // ── Release Information Group: release-only processing ────────────────────
  if (sourceRole === 'RELEASE_ONLY') {
    if (message.direction !== 'INCOMING') {
      return {created: false, reviewSubmitted: false, reasons: ['RELEASE_GROUP_OUTGOING_CONTEXT'], blocked: true};
    }
    const groupAuth = await isGroupParticipantAuthorized(
      message.account_id,
      message.chat_jid,
      message.sender_jid,
    );
    if (!groupAuth.authorized) {
      return {created: false, reviewSubmitted: false, reasons: [groupAuth.reason as string], blocked: true};
    }
    const releaseBlocks = parseReleaseSlips(text);
    if (!releaseBlocks.length) {
      // Unstructured release-group traffic (cancellation, replacement, food
      // bill, empty message) is evidence, not an instruction. Extract fields,
      // match candidate programs read-only and keep the item pending for a
      // human reviewer. It never releases or voids a program.
      const evidence = parseUnstructuredRelease(text);
      const candidates = await matchUnstructuredReleaseCandidates(evidence.fields);
      const releaseCategory = evidence.kind === 'EMPTY'
        ? 'RELEASE_EMPTY_MESSAGE'
        : evidence.kind === 'TRANSFER'
          ? 'RELEASE_TRANSFER_CANDIDATE'
          : evidence.kind === 'CANCELLATION'
            ? 'RELEASE_CANCELLATION_CANDIDATE'
            : evidence.kind === 'REPLACEMENT'
              ? 'RELEASE_REPLACEMENT_CANDIDATE'
              : evidence.kind === 'FOOD_BILL'
                ? 'RELEASE_FOOD_BILL_CANDIDATE'
                : 'RELEASE_UNSTRUCTURED';
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'UPDATE', message.message_id,
        'EXTRACTION_FAILED', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          reasons: evidence.reasons.length ? evidence.reasons : ['NO_STRUCTURED_RELEASE_BLOCK'],
          extractedFields: evidence.fields,
          evidenceKinds: evidence.kinds,
          matchedTokens: evidence.matchedTokens,
          candidateProgramIds: candidates.ids,
          candidateMatchedBy: candidates.matchedBy,
          releaseCategory,
          parser: 'release-evidence', ruleVersion: RULE_VERSION,
        });
      return {
        created: false,
        reviewSubmitted: submitted.submitted,
        reasons: [releaseCategory],
        programsCreated: 0,
        releases: 0,
        blocked: true,
      };
    }
    return handleReleaseSlip(actor, message, text, releaseBlocks);
  }

  // A release slip arriving anywhere other than the Release Information Group
  // is never applied. This prevents an order/support conversation from
  // releasing an unrelated program.
  if (parseReleaseSlips(text).length) {
    return {created: false, reviewSubmitted: false, reasons: ['RELEASE_SOURCE_NOT_AUTHORIZED'], blocked: true};
  }

  // ── Non-order sources ─────────────────────────────────────────────────────
  if (sourceRole === 'SUPPORT_ONLY') {
    return {created: false, reviewSubmitted: false, reasons: ['SUPPORT_GROUP_ORDER_BLOCKED'], blocked: true};
  }
  if (sourceRole === 'OTHER_APPROVED') {
    return {created: false, reviewSubmitted: false, reasons: ['OTHER_APPROVED_GROUP_CONTEXT_ONLY'], blocked: true};
  }
  if (sourceRole === 'REVIEW_REQUIRED' || sourceRole === null) {
    return {created: false, reviewSubmitted: false, reasons: ['SOURCE_ROLE_REVIEW_REQUIRED'], blocked: true};
  }
  if (sourceRole !== 'ORDER_INTAKE') {
    return {created: false, reviewSubmitted: false, reasons: ['CHAT_NOT_ORDER_INTAKE'], blocked: true};
  }
  if (message.chat_jid.endsWith('@g.us')) {
    return {created: false, reviewSubmitted: false, reasons: ['GROUP_ORDER_INTAKE_BLOCKED'], blocked: true};
  }
  if (message.direction !== 'INCOMING') {
    return {created: false, reviewSubmitted: false, reasons: ['ORDER_REQUIRES_INCOMING'], blocked: true};
  }

  // Verified Escort Client identity: registry when configured, otherwise the
  // EXACT canonical PN link in identity_aliases. Display names never authorize.
  const clientAuth = await isAuthorizedEscortClientConversation(
    message.account_id,
    message.chat_jid,
    message.sender_jid,
  );
  if (!clientAuth.authorized) {
    return {created: false, reviewSubmitted: false, reasons: [clientAuth.reason ?? 'ESCORT_CLIENT_NOT_AUTHORIZED'], blocked: true};
  }

  const {parseEscortOrder} = await import('./escort-intake-candidate.mjs');
  const {orderIntakeDateAndShift, orderIntakeShift} = await import('./order-intake-shift.ts');

  const blocks = parseEscortOrder(text, {
    messageDate: message.source_timestamp.slice(0, 10),
  }) as Array<{
    motherVessel?: string;
    lighterVessel?: string;
    masterMobile?: string | null;
    destination?: string | null;
    assignmentDate?: string | null;
    shift?: string | null;
    reasons?: string[];
    fields?: Record<string, string | null | undefined>;
  }>;

  // No parseable vessel blocks: submit to Review Queue
  if ((blocks ?? []).length === 0) {
    await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
      'EXTRACTION_FAILED', {
        sourceMessageId: message.message_id,
        sourceChatJid: message.chat_jid,
        sourceAccountId: message.account_id,
        sourceTimestamp: message.source_timestamp,
        senderJid: message.sender_jid,
        rawText: text,
        parseReasons: ['NO_PARSEABLE_ORDER_BLOCK'],
        parser: 'parseEscortOrder',
        parserVersion: 'escort-intake-candidate-v2',
      });
    return {created: false, reviewSubmitted: true, reasons: ['NO_PARSEABLE_ORDER_BLOCK']};
  }

  const derived = orderIntakeDateAndShift(message.source_timestamp, text);
  let created = 0;
  let reviewSubmitted = false;
  const allReasons: string[] = [];

  for (const block of blocks) {
    const fields = (block.fields ?? block) as Record<string, string | null | undefined>;
    const blockReasons = block.reasons ?? [];

    // Skip blocks with parse errors — they go to review individually
    if (blockReasons.length > 0) {
      allReasons.push(...blockReasons);
      continue;
    }

    const motherVesselRaw = fields.motherVessel ?? null;
    const lighterVesselRaw = fields.lighterVessel ?? null;
    const masterMobileRaw = (block.masterMobile as string | undefined) ?? fields.masterMobile ?? null;

    // Bounded multi-message merge inside this same verified client conversation.
    let effectiveMother = motherVesselRaw;
    let effectiveLighter = lighterVesselRaw;
    let effectiveMaster = masterMobileRaw;
    let mergedReviewId: string | null = null;
    let mergedPriorMessageId: string | null = null;
    if (!effectiveMother || !effectiveLighter || !effectiveMaster) {
      const merge = await findMergeableIncompleteOrder(message.account_id, message.chat_jid, message.message_id, {
        motherVessel: motherVesselRaw,
        lighterVessel: lighterVesselRaw,
        masterMobile: masterMobileRaw,
        destination: fields.destination ?? null,
        assignmentDate: fields.assignmentDate ?? null,
        shift: fields.shift ?? null,
      });
      if (merge) {
        effectiveMother = merge.fields.motherVessel;
        effectiveLighter = merge.fields.lighterVessel;
        effectiveMaster = merge.fields.masterMobile;
        if (!fields.destination && merge.fields.destination) fields.destination = merge.fields.destination;
        if (!fields.assignmentDate && merge.fields.assignmentDate) fields.assignmentDate = merge.fields.assignmentDate;
        if (!fields.shift && merge.fields.shift) fields.shift = merge.fields.shift;
        mergedReviewId = merge.reviewId;
        mergedPriorMessageId = merge.priorMessageId;
      }
    }

    // Minimum order requirements: Mother Vessel + Lighter Vessel + Master Mobile
    if (!effectiveMother || !effectiveLighter || !effectiveMaster) {
      const missing: string[] = [];
      if (!effectiveMother) missing.push('MISSING_MOTHER_VESSEL');
      if (!effectiveLighter) missing.push('MISSING_LIGHTER_VESSEL');
      if (!effectiveMaster) missing.push('MISSING_MASTER_MOBILE');
      // Submit to Review Queue with what we have — do not discard
      const missingSubmitted = await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
        'INCOMPLETE_VESSEL_ORDER', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields: {motherVessel: effectiveMother, lighterVessel: effectiveLighter, masterMobile: effectiveMaster,
            destination: fields.destination ?? null,
            assignmentDate: fields.assignmentDate ?? null,
            shift: fields.shift ?? null},
          missingFields: missing,
          parser: 'parseEscortOrder',
          parserVersion: 'escort-intake-candidate-v2',
        });
      if (missingSubmitted.submitted) reviewSubmitted = true;
      allReasons.push(...missing);
      continue;
    }

    // At this point all three are non-null strings
    const motherVessel = effectiveMother;
    const lighterVessel = effectiveLighter;
    const masterMobile = effectiveMaster;

    // A client may not assign the Escort. Assignment belongs to the verified
    // Admin confirmation. An incoming client message that carries Escort
    // Name/Mobile is preserved for review, never turned into a Draft.
    if (fields.escortName || fields.escortMobile || fields.employeeMobile) {
      const submitted = await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
        'INCOMPLETE_VESSEL_ORDER', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields: {motherVessel, lighterVessel, masterMobile,
            destination: fields.destination ?? null,
            escortName: fields.escortName ?? null,
            escortMobile: fields.escortMobile ?? null},
          missingFields: ['ADMIN_ASSIGNMENT_REQUIRED'],
          reasons: ['CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN'],
          parser: 'parseEscortOrder',
          parserVersion: 'escort-intake-candidate-v2',
        });
      if (submitted.submitted) reviewSubmitted = true;
      allReasons.push('CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN');
      continue;
    }

    // Check for multi-message correlation: if this message has a mother vessel
    // that matches a recently created program in the same chat, correlate
    let correlatedProgramId: string | null = null;
    if (motherVessel) {
      const correlated = await findCorrelatedProgram(
        message.account_id,
        message.chat_jid,
        motherVessel,
        masterMobile,
      );
      if (correlated) {
        correlatedProgramId = correlated.id;
      }
    }

    // Duplicate check: same Mother + Lighter + Start Date ±1 day
    const startDate = derived?.date ?? block.assignmentDate ?? '';
    const dups = await potentialDuplicates({
      motherVessel,
      lighterVessel,
      startDate,
    });
    const exact = dups.find((c) => c.start_date === startDate);
    if (exact) {
      allReasons.push(`DUPLICATE_PROGRAM:${exact.id}`);
      // Still record source reference for the existing program
      if (correlatedProgramId || exact.id) {
        await recordProgramSource(
          correlatedProgramId || exact.id,
          message.account_id,
          message.chat_jid,
          message.message_id,
          'contributor',
        );
      }
      continue;
    }
    if (dups.length > 0) {
      // ±1-day duplicate warning → Review Queue (does NOT discard the order)
      const duplicateSubmitted = await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
        'VESSEL_DUPLICATE_CANDIDATE', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields: {motherVessel, lighterVessel, masterMobile,
            destination: fields.destination ?? null,
            assignmentDate: fields.assignmentDate ?? null,
            shift: fields.shift ?? null},
          duplicateWarning: true,
          potentialDuplicates: dups.map((d) => ({id: d.id, start_date: d.start_date})),
          parser: 'parseEscortOrder',
        });
      if (duplicateSubmitted.submitted) reviewSubmitted = true;
      allReasons.push('DUPLICATE_WARNING_SUBMITTED_TO_REVIEW');
      continue;
    }

    try {
      const noteParts: string[] = [];
      if (!block.assignmentDate) noteParts.push('START_DATE_DERIVED_FROM_MESSAGE_TIMESTAMP');
      if (mergedPriorMessageId) noteParts.push(`MERGED_ORDER_FRAGMENT:${mergedPriorMessageId}`);
      const result = await createProgram(actor, {
        motherVessel,
        lighterVessel,
        masterMobile,
        destination: fields.destination ?? null,
        startDate,
        startShift: orderIntakeShift(message.source_timestamp, text),
        notes: noteParts.length ? noteParts.join('; ') : null,
      }, {channel: 'WHATSAPP', messageId: message.message_id, chatJid: message.chat_jid});

      const programId = result.program.id;

      // Record primary source message reference
      await recordProgramSource(
        programId,
        message.account_id,
        message.chat_jid,
        message.message_id,
        'primary',
      );

      // The merged fragment is now part of this Draft. Withdraw its separate
      // review item and keep the message as contributing provenance.
      if (mergedReviewId) {
        await row(
          `UPDATE review_items SET state = 'WITHDRAWN', decided_at = now()
            WHERE id = $1 AND state = 'PENDING'`,
          [mergedReviewId],
        );
        if (mergedPriorMessageId) {
          await recordProgramSource(
            programId,
            message.account_id,
            message.chat_jid,
            mergedPriorMessageId,
            'contributor',
          );
        }
        await recordAudit({
          actor,
          action: 'VESSEL_ORDER_FRAGMENTS_MERGED',
          entity: 'program',
          entityId: programId,
          detail: {messageId: message.message_id, mergedMessageId: mergedPriorMessageId, reviewItemId: mergedReviewId},
          source: 'SYSTEM',
        });
      }

      // If this was correlated with an existing program, also link as contributor
      if (correlatedProgramId && correlatedProgramId !== programId) {
        await recordProgramSource(
          correlatedProgramId,
          message.account_id,
          message.chat_jid,
          message.message_id,
          'contributor',
        );
      }

      created += 1;
    } catch (error) {
      if ((error as Error).message.startsWith('DUPLICATE_PROGRAM')) continue;
      throw error;
    }
  }

  return {created: created > 0, reviewSubmitted, reasons: allReasons, programsCreated: created};
}

/**
 * Handle an admin outgoing message as a potential vessel confirmation.
 * The admin's existing outgoing reply containing Escort Name, Escort Mobile,
 * Start Date and Shift IS the confirmation — no new outbound sender is used.
 * Reuses applyConfirmation() from the existing whatsapp module.
 * WA-01 only; confirmation must be in the same conversation as the original order.
 * Ambiguous matches remain unconfirmed and enter review.
 */
async function handleConfirmation(
  actor: Actor,
  message: MessageToProcess,
  text: string,
  accountAdminJids: string[],
  sourceRole: SourceRole | null,
): Promise<{confirmed: boolean; classification: string}> {
  // Vessel authorization: WA-01 only
  const vesselAuth = await isVesselAuthorized(message.account_id);
  if (!vesselAuth.authorized) {
    return {confirmed: false, classification: vesselAuth.reason as string};
  }

  // The confirmation must be an Admin OUTGOING reply in the SAME original
  // direct Order conversation. Groups are never a confirmation receiver.
  if (sourceRole !== 'ORDER_INTAKE' || message.chat_jid.endsWith('@g.us')) {
    return {confirmed: false, classification: 'CONFIRMATION_CHAT_NOT_ORDER_INTAKE'};
  }
  if (message.direction !== 'OUTGOING') {
    return {confirmed: false, classification: 'CONFIRMATION_REQUIRES_OUTGOING'};
  }

  const isAdmin = accountAdminJids.some((jid) => jidsMatch(jid, message.sender_jid));
  if (!isAdmin) {
    return {confirmed: false, classification: 'OUTGOING_NON_ADMIN'};
  }

  // Weighted Owner score (Step 14). The legacy matcher remains the state
  // transition authority; this gate chooses confirm / review / skip.
  const candidates = await rows<Record<string, unknown>>(
    `SELECT * FROM programs
      WHERE source_chat_jid = $1
        AND state IN ('DRAFT','CONFIRMED')
        AND event_at <= $2::timestamptz
      ORDER BY event_at DESC
      LIMIT 50`,
    [message.chat_jid, message.source_timestamp],
  ).catch(() => []);
  let best: {program: Record<string, unknown>; score: number} | null = null;
  for (const program of candidates) {
    const score = computeConfirmationScore(text, program as never, message.source_timestamp.slice(0, 10));
    if (!best || score > best.score) best = {program, score};
  }
  const score = best?.score ?? 0;
  const confirmConfig = await featureConfig('vessel.auto_confirm', {fuzzy_threshold: 0.90});
  const rawThreshold = Number(confirmConfig.fuzzy_threshold ?? 0.90);
  const threshold = rawThreshold <= 1 ? Math.round(rawThreshold * 100) : Math.round(rawThreshold);
  const shadow = await isFeatureEnabled('vessel.auto_confirm.shadow', false);
  if (shadow) {
    await row(
      `INSERT INTO audit_events(actor,actor_role,action,entity,entity_id,detail,source)
       VALUES($1,'SYSTEM','VESSEL:CONFIRMATION_SHADOW','program',$2,$3::jsonb,'SYSTEM')`,
      [actor.id, best?.program.id ?? null, JSON.stringify({score, threshold, decision: score >= threshold ? 'CONFIRM' : score >= 75 ? 'REVIEW' : 'SKIP', messageId: message.message_id})],
    );
    return {confirmed: false, classification: 'CONFIRMATION_SHADOW'};
  }
  if (score < 75) {
    return {confirmed: false, classification: 'CONFIRMATION_SCORE_BELOW_THRESHOLD'};
  }
  if (score < threshold) {
    await row(
      `INSERT INTO message_review_queue(source_account_id,source_chat_jid,source_message_id,source_timestamp,sender_jid,message_text,confusion_reason,suggested_workflow)
       VALUES($1,$2,$3,$4,$5,$6,$7,'vessel')
       ON CONFLICT (source_account_id,source_chat_jid,source_message_id) DO NOTHING`,
      [message.account_id, message.chat_jid, message.message_id, message.source_timestamp, message.sender_jid, text, `CONFIRMATION_SCORE_${score}`],
    ).catch(() => null);
    return {confirmed: false, classification: `CONFIRMATION_SCORE_${score}`};
  }

  const {applyConfirmation} = await import('./standalone/whatsapp.ts');
  const classification = await applyConfirmation(actor, {
    message_id: message.message_id,
    chat_jid: message.chat_jid,
    account_id: message.account_id,
    sender_jid: message.sender_jid,
    source_timestamp: message.source_timestamp,
  }, text);

  // Ambiguous, unmatched, weak or already-confirmed evidence never silently
  // confirms. It is preserved for a human reviewer.
  if (
    classification === 'CONFIRMATION_AMBIGUOUS' ||
    classification === 'CONFIRMATION_ALREADY_CONFIRMED' ||
    classification === 'CONFIRMATION_WEAK_EVIDENCE'
  ) {
    await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
      'AMBIGUOUS_VESSEL_CONFIRMATION', {
        sourceMessageId: message.message_id,
        sourceChatJid: message.chat_jid,
        sourceAccountId: message.account_id,
        sourceTimestamp: message.source_timestamp,
        senderJid: message.sender_jid,
        rawText: text,
        classification,
        parser: 'applyConfirmation',
        needsReviewerResolution: true,
      });
    return {confirmed: false, classification};
  }

  // Unmatched confirmations go to Review Queue
  if (classification === 'CONFIRMATION_UNMATCHED') {
    await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
      'UNMATCHED_VESSEL_ASSIGNMENT', {
        sourceMessageId: message.message_id,
        sourceChatJid: message.chat_jid,
        sourceAccountId: message.account_id,
        sourceTimestamp: message.source_timestamp,
        senderJid: message.sender_jid,
        rawText: text,
        classification,
        parser: 'applyConfirmation',
        needsReviewerResolution: true,
      });
    return {confirmed: false, classification};
  }

  return {confirmed: classification === 'CONFIRMED', classification};
}

/**
 * Single canonical processing entry point. Processes a batch of staged
 * WhatsApp messages through domain classification, authorization, domain
 * handlers (cash REVIEW, vessel DRAFT), Review Queue submission for
 * errors/ambiguity, and crash-safe processing state with retry.
 *
 * Both processPending() and routePending() delegate here, so there is exactly
 * one code path that can create business records from WhatsApp messages.
 */
export async function routePendingMessages(
  actor: Actor,
  limit = 100,
): Promise<RouterResult> {
  const result: RouterResult = {
    processed: 0,
    instructions: 0,
    programs: 0,
    confirmations: 0,
    releases: 0,
    reviewItems: 0,
    ignored: 0,
    errors: 0,
    disabled: false,
    reason: null,
    byMessage: [],
  };

  const config = await loadRouterConfig();
  if (!config.enabled) {
    return {...result, disabled: true, reason: config.reason};
  }

  const claimed = await claimMessages(limit);
  if (claimed.length === 0) return result;

  for (const message of claimed) {
    const text = message.text_content ?? '';
    let classification = 'IGNORED';
    let domain: Domain = 'UNKNOWN';
    let action = 'ignored';
    let deferred = false;

    try {
      const account = await row<WhatsAppAccount>(
        'SELECT id, admin_jids FROM whatsapp_accounts WHERE id = $1',
        [message.account_id],
      );
      const adminJids = account?.admin_jids ?? [];

      const chatAuth = await isChatAuthorized(
        message.account_id,
        message.chat_jid,
      );
      const sourceRole = chatAuth.sourceRole;

      if (!chatAuth.authorized) {
        classification = 'UNAUTHORIZED_CHAT';
        action = 'ignored';
        result.ignored += 1;
      } else {
        // Parser-backed gate: direct ORDER_INTAKE incoming messages bypass the
        // keyword classifier. If the parser finds at least one block, it is an
        // order even when the old looksLikeVessel() would miss it.
        let cls: ClassificationResult;
        if (message.direction === 'INCOMING'
          && sourceRole === 'ORDER_INTAKE'
          && !message.chat_jid.endsWith('@g.us')
          && ORDER_INTAKE_JIDS.has(message.chat_jid)) {
          const {parseEscortOrder} = await import('./escort-intake-candidate.mjs');
          let parsed = 0;
          try {
            parsed = parseEscortOrder(text, {messageDate: message.source_timestamp.slice(0, 10)}).length;
          } catch {
            parsed = 0;
          }
          cls = parsed > 0
            ? {domain: 'VESSEL', confidence: 'HIGH', reasons: ['PARSER_BACKED_ORDER_GATE']}
            : classifyDomain(text, chatAuth.purpose);
        } else {
          cls = classifyDomain(text, chatAuth.purpose);
        }
        domain = cls.domain;

        // WA-02 is identity-only. Vessel-domain text is rejected before any
        // source-role branch so an unconfigured WA-02 group cannot hide the
        // account rejection behind a source-role gap.
        if (message.account_id !== 'wa-01' && domain === 'VESSEL') {
          classification = 'VESSEL_WA02_NOT_AUTHORIZED';
          action = 'ignored';
          result.ignored += 1;
        } else if (sourceRole === 'SUPPORT_ONLY') {
          // Escort Support / operational group: order-shaped text is context,
          // never a Draft. Other approved group: context only. Unresolved
          // source: block state-changing work and expose the gap.
          classification = 'SUPPORT_GROUP_NO_ORDER_DRAFT';
          action = 'support_group_context';
          result.ignored += 1;
        } else if (sourceRole === 'OTHER_APPROVED') {
          classification = 'OTHER_APPROVED_GROUP_CONTEXT_ONLY';
          action = 'other_group_context';
          result.ignored += 1;
        } else if (sourceRole === 'REVIEW_REQUIRED' || sourceRole === null) {
          classification = 'SOURCE_ROLE_REVIEW_REQUIRED';
          action = 'source_role_unresolved';
          result.ignored += 1;
        } else if (sourceRole === 'RELEASE_ONLY') {
          if (message.direction !== 'INCOMING') {
            classification = 'RELEASE_GROUP_OUTGOING_CONTEXT';
            action = 'ignored';
            result.ignored += 1;
          } else if (process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED === '0') {
            classification = 'VESSEL:PROCESSING_DISABLED';
            action = 'deferred';
            deferred = true;
          } else {
            const vesselResult = await handleVessel(SYSTEM_ACTOR, message, text, sourceRole);
            result.releases += vesselResult.releases ?? 0;
            result.reviewItems += vesselResult.reviewSubmitted ? 1 : 0;
            classification = vesselResult.releases
              ? 'VESSEL:RELEASE_APPLIED'
              : vesselResult.idempotent
                ? 'VESSEL:RELEASE_ALREADY_APPLIED'
                : vesselResult.reviewSubmitted
                  ? `VESSEL:RELEASE_REVIEW_SUBMITTED:${vesselResult.reasons.join(',')}`
                  : `VESSEL:${vesselResult.reasons[0] ?? 'RELEASE_NO_OP'}`;
            action = vesselResult.releases ? 'program_released'
              : vesselResult.idempotent ? 'release_idempotent_skip'
                : vesselResult.reviewSubmitted ? 'release_review_submitted' : 'release_no_op';
          }
        } else if (domain === 'CASH' && message.direction === 'OUTGOING') {
          const isAdmin = adminJids.some((jid) => jidsMatch(jid, message.sender_jid));
          const isWa01 = message.account_id === 'wa-01';
          if (!isAdmin) {
            classification = 'CASH:NON_ADMIN_SENDER';
            action = 'ignored';
            result.ignored += 1;
          } else if (!isWa01) {
            classification = 'CASH:WRONG_ACCOUNT';
            action = 'ignored';
            result.ignored += 1;
          } else {
            const cashConversation = await isAuthorizedCashConversation(message.account_id, message.chat_jid);
            if (!cashConversation.authorized) {
              classification = `CASH:${cashConversation.reason ?? 'ACCOUNTANT_NOT_AUTHORIZED'}`;
              action = 'ignored';
              result.ignored += 1;
            } else {
              const cashResult = await handleCash(SYSTEM_ACTOR, message, text);
              result.instructions += cashResult.instructionsCreated;
              result.reviewItems += cashResult.reviewSubmitted ? 1 : 0;
              classification = cashResult.created
                ? (cashResult.reviewSubmitted ? `CASH:AUTO_POSTED_WITH_REVIEW` : `CASH:AUTO_POSTED`)
                : cashResult.reviewSubmitted
                  ? `CASH:REVIEW_SUBMITTED:${cashResult.reasons.join(',')}`
                  : 'CASH:IDEMPOTENT_SKIP';
              action = cashResult.created ? 'cash_auto_posted'
                : cashResult.reviewSubmitted ? 'cash_review_submitted' : 'cash_idempotent_skip';
            }
          }
        } else if (domain === 'CASH' && message.direction === 'INCOMING') {
          // Incoming messages never create cash instructions
          classification = 'CASH:INCOMING_NOT_PROCESSED';
          action = 'ignored';
          result.ignored += 1;
        } else if (sourceRole === 'ORDER_INTAKE' && message.direction === 'INCOMING') {
          // Deployment-level safety switch. The Live Router activation gate is
          // still required; this flag lets an installation enable Cash routing
          // while Vessel intake is not yet approved. An unset value is treated
          // as enabled for compatibility; production .env explicitly sets 0.
          if (process.env.ALRIFAI_VESSEL_PROCESSING_ENABLED === '0') {
            // Do not consume the message: it must remain eligible when the
            // Owner enables Vessel intake later. Marking it COMPLETED here
            // would silently lose the order.
            classification = 'VESSEL:PROCESSING_DISABLED';
            action = 'deferred';
            deferred = true;
          } else {
            const vesselResult = await handleVessel(SYSTEM_ACTOR, message, text, sourceRole);
            result.programs += vesselResult.programsCreated ?? (vesselResult.created ? 1 : 0);
            result.releases += vesselResult.releases ?? 0;
            result.reviewItems += vesselResult.reviewSubmitted ? 1 : 0;
            classification = vesselResult.created
              ? `VESSEL:PROGRAM_DRAFT`
              : vesselResult.reviewSubmitted
                ? `VESSEL:REVIEW_SUBMITTED:${vesselResult.reasons.join(',')}`
                : (vesselResult.reasons[0] ?? 'VESSEL:NO_VALID_BLOCK');
            action = vesselResult.created ? 'program_draft_created'
              : vesselResult.reviewSubmitted ? 'vessel_review_submitted' : 'vessel_no_valid_block';
          }
        } else if (sourceRole === 'ORDER_INTAKE' && message.direction === 'OUTGOING') {
          const confResult = await handleConfirmation(SYSTEM_ACTOR, message, text, adminJids, sourceRole);
          result.confirmations += confResult.confirmed ? 1 : 0;
          result.reviewItems += confResult.classification === 'CONFIRMATION_AMBIGUOUS'
            || confResult.classification === 'CONFIRMATION_UNMATCHED'
            || confResult.classification === 'CONFIRMATION_ALREADY_CONFIRMED'
            || confResult.classification === 'CONFIRMATION_WEAK_EVIDENCE' ? 1 : 0;
          classification = confResult.classification;
          action = confResult.confirmed ? 'confirmation_matched' : 'outgoing_no_confirmation';
        } else {
          classification = domain === 'VESSEL' ? 'VESSEL:CHAT_NOT_ORDER_INTAKE' : 'IGNORED';
          action = 'ignored';
          result.ignored += 1;
        }
      }

      // A deferred message stays PENDING so a later activation can process it.
      // It is not counted as processed and it is never marked COMPLETED.
      if (deferred) {
        await tx(async (client) => {
          await client.query(
            `UPDATE whatsapp_messages
                SET processing_status = 'PENDING',
                    classification = $2,
                    last_error = NULL,
                    last_processed_at = now(),
                    processed_at = NULL
              WHERE id = $1`,
            [message.id, classification.slice(0, 120)],
          );
        });
        result.ignored += 1;
        result.byMessage.push({messageId: message.message_id, domain, action, classification});
        continue;
      }

      // Business actions are durably committed by the domain services before
      // we reach this point. Mark COMPLETED only now.
      await tx(async (client) => {
        await markOutcome(
          client,
          message.id,
          'COMPLETED',
          classification,
          null,
          false,
        );
      });
      result.processed += 1;
      result.byMessage.push({messageId: message.message_id, domain, action, classification});
    } catch (error) {
      const errMsg = (error as Error).message.slice(0, 200);
      await tx(async (client) => {
        await markOutcome(
          client,
          message.id,
          'FAILED',
          `ERROR:${errMsg}`,
          errMsg,
          true,
        );
      });
      result.errors += 1;
      result.byMessage.push({
        messageId: message.message_id,
        domain,
        action: 'error',
        classification: `ERROR:${errMsg}`,
      });
      await recordAudit({
        actor,
        action: 'ROUTER_MESSAGE_ERROR',
        entity: 'whatsapp_message',
        entityId: message.id,
        detail: {messageId: message.message_id, error: errMsg},
        source: 'SYSTEM',
      });

      // Submit processing error to Review Queue
      await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
        'PROCESSING_ERROR', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          error: errMsg,
          parser: 'message-router',
        });
    }
  }

  await recordAudit({
    actor,
    action: 'WHATSAPP_ROUTER_BATCH',
    entity: 'whatsapp',
    detail: {...result, invokedBy: actor.id},
    source: 'SYSTEM',
  });

  return result;
}

const router = { routePendingMessages, classifyDomain };
export default router;
