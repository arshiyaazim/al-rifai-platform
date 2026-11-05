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
// No automatic financial posting: cash instructions are created in REVIEW state.
// No outbound WhatsApp sender: confirmation reuses applyConfirmation() on the
// admin's existing outgoing reply.
// WA-02 is raw-ingestion/identity-only; no business processing from WA-02.

import {row, tx, DomainError, type Actor} from './standalone/db.ts';
import {newId, stableId, recordAudit} from './standalone/audit.ts';
import {createInstruction} from './standalone/finance.ts';
import {createProgram, potentialDuplicates} from './standalone/programs.ts';
import {submitForReview} from './standalone/review.ts';
import {classifyDomain, type Domain} from './message-classifier.ts';
import type {WhatsAppAccount} from './standalone/whatsapp.ts';

export type RouterResult = {
  processed: number;
  instructions: number;
  programs: number;
  confirmations: number;
  reviewItems: number;
  ignored: number;
  errors: number;
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
      `SELECT id::text, account_id, chat_jid, message_id::text, direction,
              sender_jid, to_char(source_timestamp AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS source_timestamp, text_content,
              processing_status, retry_count, last_error
         FROM whatsapp_messages
        WHERE (processing_status = 'PENDING'
               OR (processing_status = 'FAILED' AND retry_count < 10
                   AND (last_processed_at IS NULL
                        OR last_processed_at < now() - interval '10 minutes'))
               OR (processing_status = 'PROCESSING'
                   AND last_processed_at < now() - interval '30 minutes'))
        ORDER BY id
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

/**
 * Check whether a chat is authorized for the given domain and direction.
 * Uses whatsapp_chats.authorized + purpose (existing contract).
 * Vessel domain requires WA-01 account only.
 */
async function isChatAuthorized(
  accountId: string,
  chatJid: string,
  direction: 'INCOMING' | 'OUTGOING',
): Promise<{authorized: boolean; purpose: string | null}> {
  const chat = await row<{purpose: string | null; authorized: boolean}>(
    `SELECT purpose, authorized
           FROM whatsapp_chats
          WHERE account_id = $1 AND chat_jid = $2`,
    [accountId, chatJid],
  );
  if (!chat || !chat.authorized) {
    return {authorized: false, purpose: chat?.purpose ?? null};
  }
  const purpose = chat.purpose ?? 'BOTH';
  // The domain classifier enforces the chat purpose after this gate. A CASH
  // chat must therefore admit INCOMING messages so the classifier can see
  // them; it returns UNKNOWN for a purpose mismatch instead of dropping the
  // message before classification.
  if (direction === 'INCOMING') {
    return {
      authorized: purpose === 'ORDERS' || purpose === 'CASH' || purpose === 'BOTH',
      purpose,
    };
  }
  return {
    authorized: purpose === 'ORDERS' || purpose === 'CASH' || purpose === 'BOTH',
    purpose,
  };
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

  const auth = await row<{participant_jid: string | null}>(
    `SELECT participant_jid
           FROM escort_client_group_authorizations
          WHERE account_id = $1
            AND group_jid = $2
            AND participant_jid = $3
            AND active = true
          LIMIT 1`,
    [accountId, chatJid, senderJid ?? ''],
  );

  if (!auth || !auth.participant_jid) {
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
 * Parse a message for cash and optionally create a cash_instruction in REVIEW.
 * Reuses createInstruction() (verified business rule: REVIEW state only,
 * never automatic posting). Unparsable messages go to submitCash() which
 * creates a cash_submission in PENDING_REVIEW (the established path for CASH
 * review — submitForReview() rejects CASH domain by design).
 * WA-01 Admin OUTGOING only.
 */
async function handleCash(
  actor: Actor,
  message: MessageToProcess,
  text: string,
): Promise<{created: boolean; reviewSubmitted: boolean; reasons: string[]}> {
  const {parsePaymentBlocks} = await import('./history-extraction.mjs');
  const blocks = parsePaymentBlocks(text) as Array<{
    blockKey: string;
    fields: Record<string, string>;
    reasons: string[];
  }>;

  const block = (blocks ?? []).find((b) => b.reasons.length === 0);
  if (!block) {
    // No cleanly parsable block: submit to cash_submissions (PENDING_REVIEW).
    // Also submit a review item with category EXTRACTION_FAILED.
    const payload = {
      sourceMessageId: message.message_id,
      sourceChatJid: message.chat_jid,
      sourceAccountId: message.account_id,
      sourceTimestamp: message.source_timestamp,
      senderJid: message.sender_jid,
      rawText: text,
      parseReasons: blocks?.flatMap((b) => b.reasons ?? []).filter(Boolean) ?? ['NO_PARSEABLE_BLOCK'],
      parser: 'parsePaymentBlocks',
      parserVersion: 'history-extraction-v2',
      needsReviewerCorrection: true,
    };
    // submitReviewItem() creates the single CASH review candidate
    // (cash_submissions) with the raw text and parse reasons; do not also
    // insert a summary submission for the same message.
    await submitReviewItem(actor, 'CASH', 'CREATE', message.message_id,
      'EXTRACTION_FAILED', payload);
    return {created: false, reviewSubmitted: true,
      reasons: blocks?.flatMap((b) => b.reasons ?? []).filter(Boolean) ?? ['NO_PARSEABLE_BLOCK']};
  }

  const fields = block.fields;
  const employeeMobile = fields.employeeMobile ?? null;
  const amountMinor = Number(fields.amountMinor);
  const purpose = fields.purpose ?? null;

  if (!Number.isSafeInteger(amountMinor) || amountMinor <= 0) {
    // Invalid amount: submit to cash_submissions for reviewer correction
    const payload = {
      sourceMessageId: message.message_id,
      sourceChatJid: message.chat_jid,
      sourceAccountId: message.account_id,
      rawText: text,
      fields,
      parseReasons: ['AMOUNT_INVALID_OR_MISSING'],
      parser: 'parsePaymentBlocks',
      needsReviewerCorrection: true,
    };
    await submitReviewItem(actor, 'CASH', 'CREATE', message.message_id,
      'INCOMPLETE_CASH_INSTRUCTION', payload);
    return {created: false, reviewSubmitted: true, reasons: ['AMOUNT_INVALID_OR_MISSING']};
  }

  const hash = stableId('h', [message.account_id, message.message_id, block.blockKey]);

  // Atomic: createInstruction() now writes source provenance fields in the
  // same INSERT. No separate stamping transaction needed.
  const created = await createInstruction(actor, {
    employeeMobile,
    employeeName: fields.employeeName ?? 'Unknown',
    payoutMobile: fields.payoutMobile ?? null,
    method: fields.method ?? 'cash',
    amountMinor,
    purpose,
    accountId: null,
    sourceChannel: 'WHATSAPP',
    sourceMessageId: message.message_id,
    sourceBlockKey: block.blockKey,
    sourceHash: hash,
  });

  // The unique source identity already exists: this is a replay or a losing
  // concurrent worker. Report an idempotent skip; do not create another row.
  if (!created) return {created: false, reviewSubmitted: false, reasons: ['IDEMPOTENT_SKIP']};

  return {created: true, reviewSubmitted: false, reasons: []};
}

/**
 * Parse a message for vessel order and optionally create program(s) in DRAFT.
 * Supports multiple lighter vessels per message and multi-message correlation.
 * Reuses createProgram() (verified business rule: DRAFT state only).
 * Duplicates and missing fields go to Review Queue (PROGRAM domain).
 * WA-01 only; WA-02 rejected. Group participants must be authorized.
 */
async function handleVessel(
  actor: Actor,
  message: MessageToProcess,
  text: string,
): Promise<{created: boolean; reviewSubmitted: boolean; reasons: string[]}> {
  // Vessel authorization: WA-01 only
  const vesselAuth = await isVesselAuthorized(message.account_id);
  if (!vesselAuth.authorized) {
    return {created: false, reviewSubmitted: false, reasons: [vesselAuth.reason as string]};
  }

  // Group participant authorization for group chats
  const groupAuth = await isGroupParticipantAuthorized(
    message.account_id,
    message.chat_jid,
    message.sender_jid,
  );
  if (!groupAuth.authorized) {
    return {created: false, reviewSubmitted: false, reasons: [groupAuth.reason as string]};
  }

  const {parseEscortOrder} = await import('./escort-intake-candidate.mjs');
  const {orderDraftDateAndShift} = await import('./shift-boundary.ts');

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

  const derived = orderDraftDateAndShift(message.source_timestamp);
  let created = 0;
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

    // Minimum order requirements: Mother Vessel + Lighter Vessel + Master Mobile
    if (!motherVesselRaw || !lighterVesselRaw || !masterMobileRaw) {
      const missing: string[] = [];
      if (!motherVesselRaw) missing.push('MISSING_MOTHER_VESSEL');
      if (!lighterVesselRaw) missing.push('MISSING_LIGHTER_VESSEL');
      if (!masterMobileRaw) missing.push('MISSING_MASTER_MOBILE');
      // Submit to Review Queue with what we have — do not discard
      await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
        'INCOMPLETE_VESSEL_ORDER', {
          sourceMessageId: message.message_id,
          sourceChatJid: message.chat_jid,
          sourceAccountId: message.account_id,
          sourceTimestamp: message.source_timestamp,
          senderJid: message.sender_jid,
          rawText: text,
          fields: {motherVessel: motherVesselRaw, lighterVessel: lighterVesselRaw, masterMobile: masterMobileRaw,
            destination: fields.destination ?? null,
            assignmentDate: fields.assignmentDate ?? null,
            shift: fields.shift ?? null},
          missingFields: missing,
          parser: 'parseEscortOrder',
          parserVersion: 'escort-intake-candidate-v2',
        });
      allReasons.push(...missing);
      continue;
    }

    // At this point all three are non-null strings
    const motherVessel = motherVesselRaw;
    const lighterVessel = lighterVesselRaw;
    const masterMobile = masterMobileRaw;

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
    const startDate = block.assignmentDate ?? derived?.date ?? '';
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
      await submitReviewItem(actor, 'PROGRAM', 'CREATE', message.message_id,
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
      allReasons.push('DUPLICATE_WARNING_SUBMITTED_TO_REVIEW');
      continue;
    }

    try {
      const result = await createProgram(actor, {
        motherVessel,
        lighterVessel,
        masterMobile,
        destination: fields.destination ?? null,
        startDate,
        startShift: (block.shift as 'D' | 'N' | null) ?? derived?.shift ?? 'D',
        notes: block.assignmentDate ? null : 'START_DATE_DERIVED_FROM_MESSAGE_TIMESTAMP',
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

  return {created: created > 0, reviewSubmitted: false, reasons: allReasons};
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
): Promise<{confirmed: boolean; classification: string}> {
  // Vessel authorization: WA-01 only
  const vesselAuth = await isVesselAuthorized(message.account_id);
  if (!vesselAuth.authorized) {
    return {confirmed: false, classification: vesselAuth.reason as string};
  }

  const isAdmin = accountAdminJids.includes(message.sender_jid ?? '');
  if (!isAdmin) {
    return {confirmed: false, classification: 'OUTGOING_NON_ADMIN'};
  }

  const {applyConfirmation} = await import('./standalone/whatsapp.ts');
  const classification = await applyConfirmation(actor, {
    message_id: message.message_id,
    chat_jid: message.chat_jid,
  }, text);

  // Ambiguous confirmations go to Review Queue instead of silently failing
  if (classification === 'CONFIRMATION_AMBIGUOUS') {
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
    reviewItems: 0,
    ignored: 0,
    errors: 0,
    byMessage: [],
  };

  const claimed = await claimMessages(limit);
  if (claimed.length === 0) return result;

  for (const message of claimed) {
    const text = message.text_content ?? '';
    let classification = 'IGNORED';
    let domain: Domain = 'UNKNOWN';
    let action = 'ignored';

    try {
      const account = await row<WhatsAppAccount>(
        'SELECT id, admin_jids FROM whatsapp_accounts WHERE id = $1',
        [message.account_id],
      );
      const adminJids = account?.admin_jids ?? [];

      const chatAuth = await isChatAuthorized(
        message.account_id,
        message.chat_jid,
        message.direction as 'INCOMING' | 'OUTGOING',
      );

      if (!chatAuth.authorized) {
        classification = 'UNAUTHORIZED_CHAT';
        action = 'ignored';
        result.ignored += 1;
      } else {
        const cls = classifyDomain(text, chatAuth.purpose);
        domain = cls.domain;

        // Cash: only WA-01 Admin OUTGOING messages in Accountant conversation
        if (domain === 'CASH' && message.direction === 'OUTGOING') {
          const isAdmin = adminJids.includes(message.sender_jid ?? '');
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
            const cashResult = await handleCash(actor, message, text);
            result.instructions += cashResult.created ? 1 : 0;
            result.reviewItems += cashResult.reviewSubmitted ? 1 : 0;
            classification = cashResult.created
              ? `CASH:REVIEW_CREATED`
              : cashResult.reviewSubmitted
                ? `CASH:REVIEW_SUBMITTED:${cashResult.reasons.join(',')}`
                : 'CASH:IDEMPOTENT_SKIP';
            action = cashResult.created ? 'cash_instruction_created'
              : cashResult.reviewSubmitted ? 'cash_review_submitted' : 'cash_idempotent_skip';
          }
        } else if (domain === 'CASH' && message.direction === 'INCOMING') {
          // Incoming messages never create cash instructions
          classification = 'CASH:INCOMING_NOT_PROCESSED';
          action = 'ignored';
          result.ignored += 1;
        } else if (domain === 'VESSEL' && message.direction === 'INCOMING') {
          const vesselResult = await handleVessel(actor, message, text);
          result.programs += vesselResult.created ? 1 : 0;
          result.reviewItems += vesselResult.reviewSubmitted ? 1 : 0;
          classification = vesselResult.created
            ? `VESSEL:PROGRAM_DRAFT`
            : vesselResult.reviewSubmitted
              ? `VESSEL:REVIEW_SUBMITTED:${vesselResult.reasons.join(',')}`
              : 'VESSEL:NO_VALID_BLOCK';
          action = vesselResult.created ? 'program_draft_created'
            : vesselResult.reviewSubmitted ? 'vessel_review_submitted' : 'vessel_no_valid_block';
        } else if (
          message.direction === 'OUTGOING' &&
          (chatAuth.purpose === 'ORDERS' || chatAuth.purpose === 'BOTH')
        ) {
          const confResult = await handleConfirmation(actor, message, text, adminJids);
          result.confirmations += confResult.confirmed ? 1 : 0;
          result.reviewItems += confResult.classification === 'CONFIRMATION_AMBIGUOUS' || confResult.classification === 'CONFIRMATION_UNMATCHED' ? 1 : 0;
          classification = confResult.classification;
          action = confResult.confirmed ? 'confirmation_matched' : 'outgoing_no_confirmation';
        } else {
          classification = 'IGNORED';
          action = 'ignored';
          result.ignored += 1;
        }
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
    detail: result,
    source: 'SYSTEM',
  });

  return result;
}

const router = { routePendingMessages, classifyDomain };
export default router;
