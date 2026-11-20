import type {PoolClient} from 'pg';
import {createHash, randomUUID} from 'node:crypto';
import {rows, row, tx, text, optionalText, optionalMobile, isoDate, shift, DomainError, type Actor} from './db.ts';
import {recordAudit, newId} from './audit.ts';
import {emitDomainEvent} from '../realtime/server.ts';
import {assertCapability, can} from './authz.ts';
import {createEmployee, deleteEmployee, updateEmployee} from './employees.ts';
import {createProgram, updateProgram} from './programs.ts';
import {createAttendanceRecord} from './attendance-records.ts';

export type Domain = 'EMPLOYEE' | 'PROGRAM' | 'ATTENDANCE' | 'CASH';
export type Action = 'CREATE' | 'UPDATE' | 'DELETE';

const DOMAINS: Domain[] = ['EMPLOYEE', 'PROGRAM', 'ATTENDANCE', 'CASH'];

/**
 * Mirror review actions into the Cash portal audit table as well as the
 * platform `audit_events` trail. The Cash portal table is append-only and
 * shared by every portal action, so reviewers see one audit surface.
 */
async function portalAudit(
  actorId: string,
  targetId: string,
  action: string,
  details: Record<string, unknown>,
  client?: Pick<PoolClient, 'query'>,
): Promise<void> {
  const id = createHash('sha256').update(`${actorId}:${targetId}:${action}:${randomUUID()}`).digest('hex');
  const sql = `INSERT INTO cash_portal_audit (id, actor_id, target_id, action, details)
               VALUES ($1,$2,$3,$4,$5::jsonb)`;
  const params = [id, actorId, targetId, action, JSON.stringify(details ?? {})];
  if (client) await client.query(sql, params);
  else await row(sql, params);
}

// ── Review Queue reads ─────────────────────────────────────────────────────
export type ReviewQueueFilters = {
  state?: string;
  domain?: string;
  category?: string;
  q?: string;
  mine?: boolean;
  actor?: Actor;
  limit?: number;
};

export type ReviewQueueRow = {
  id: string;
  domain: string;
  action: string;
  category: string | null;
  target_ref: string | null;
  payload: Record<string, unknown>;
  submitted_by: string;
  state: string;
  created_at: string;
  decided_at: string | null;
  updated_at: string;
  corrected_by: string | null;
  corrected_at: string | null;
  retry_count: number;
  last_error: string | null;
  submitter_name: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_by: string | null;
  decision_at: string | null;
};

function reviewStateClause(state: string | undefined): {clause: string; params: unknown[]} {
  const params: unknown[] = [];
  if (!state || state === 'ALL') return {clause: '', params};
  if (state === 'RESOLVED') {
    return {clause: `r.state IN ('APPROVED','WITHDRAWN')`, params};
  }
  params.push(state);
  return {clause: `r.state = $${params.length}`, params};
}

/**
 * Filterable Review Queue list. Includes the category column added in
 * Increment 4, the submitter display name and the latest decision. The
 * caller is already authenticated; this function does not widen access.
 */
export async function listReviewQueue(filters: ReviewQueueFilters = {}): Promise<ReviewQueueRow[]> {
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 300);
  const params: unknown[] = [];
  const where: string[] = [];

  const stateClause = reviewStateClause(filters.state);
  if (stateClause.clause) where.push(stateClause.clause);
  params.push(...stateClause.params);

  if (filters.domain && filters.domain !== 'ALL') {
    params.push(filters.domain);
    where.push(`r.domain = $${params.length}`);
  }
  if (filters.category && filters.category !== 'ALL') {
    params.push(filters.category);
    where.push(`r.category = $${params.length}`);
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(r.id ILIKE $${params.length} OR r.target_ref ILIKE $${params.length}
      OR r.payload->>'rawText' ILIKE $${params.length}
      OR r.payload->>'sourceMessageId' ILIKE $${params.length}
      OR u.display_name ILIKE $${params.length})`);
  }
  if (filters.mine) {
    if (!filters.actor) throw new DomainError('ACTOR_REQUIRED', 401);
    params.push(filters.actor.id);
    where.push(`r.submitted_by = $${params.length}`);
  }

  params.push(limit);
  return rows<ReviewQueueRow>(
    `SELECT r.*, u.display_name AS submitter_name,
            d.decision, d.reason AS decision_reason, d.actor AS decided_by, d.created_at AS decision_at
       FROM review_items r
       LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
       LEFT JOIN review_decisions d ON d.item_id = r.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY r.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

/** Backwards-compatible list used by the existing review page. */
export async function listReview(filters: {state?: string; mine?: boolean; actor?: Actor; limit?: number} = {}) {
  return listReviewQueue({...filters, state: filters.state ?? 'PENDING'});
}

// ── Review Queue detail ────────────────────────────────────────────────────
export type SourceMessageRow = {
  id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  direction: string;
  sender_jid: string | null;
  sender_name?: string | null;
  sender_mobile?: string | null;
  source_timestamp: string;
  text_content: string | null;
  media_type: string | null;
  media_status: string | null;
  processing_status: string;
  classification: string | null;
};

export type ProgramSourceRow = {
  id: string;
  program_id: string;
  account_id: string;
  chat_jid: string;
  message_id: string;
  source_role: string;
  text_content: string | null;
  source_timestamp: string | null;
  direction: string | null;
  sender_jid: string | null;
};

export type AuditHistoryRow = {
  id: string;
  at: string;
  actor: string;
  actor_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  source: string;
  source_ref: string | null;
  detail: Record<string, unknown>;
};

export type ReviewDetail = {
  kind: 'review_item' | 'cash_submission';
  item: ReviewQueueRow | (Record<string, unknown> & {id: string; state: string; submitted_by: string; payload: Record<string, unknown>});
  submitter_name: string | null;
  decision: {decision: string; reason: string | null; actor: string | null; created_at: string | null} | null;
  audit: AuditHistoryRow[];
  sourceMessages: SourceMessageRow[];
  programSources: ProgramSourceRow[];
  relatedProgram: Record<string, unknown> | null;
  relatedInstruction: Record<string, unknown> | null;
};

async function sourceMessagesFor(messageId: string | null, accountId?: string | null): Promise<SourceMessageRow[]> {
  if (!messageId) return [];
  const params: unknown[] = [messageId];
  let accountClause = '';
  if (accountId) {
    params.push(accountId);
    accountClause = `AND m.account_id = $${params.length}`;
  }
  const found = await rows<SourceMessageRow & {sender_canonical_jid: string | null}>(
    `SELECT m.id::text, m.account_id, m.chat_jid, m.message_id, m.direction, m.sender_jid,
            m.source_timestamp::text, m.text_content, m.media_type,
            wm.status AS media_status, m.processing_status, m.classification,
            coalesce(ident.display_name, emp.preferred_name) AS sender_name,
            ident.canonical_jid AS sender_canonical_jid
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_media wm
              ON wm.account_id = m.account_id AND wm.chat_jid = m.chat_jid AND wm.message_id = m.message_id
       LEFT JOIN LATERAL (
         SELECT ia.display_name, ia.canonical_jid
           FROM identity_aliases ia
          WHERE ia.account_id = m.account_id
            AND (ia.jid = m.sender_jid
                 OR ia.jid = m.sender_jid || '@lid'
                 OR ia.canonical_jid = m.sender_jid)
          ORDER BY (ia.canonical_jid IS NOT NULL) DESC,
                   (ia.display_name IS NOT NULL) DESC,
                   ia.updated_at DESC
          LIMIT 1
       ) ident ON true
       LEFT JOIN LATERAL (
         SELECT e.preferred_name
           FROM employees e
          WHERE right(regexp_replace(e.employee_mobile, '[^0-9]', '', 'g'), 10)
                = right(regexp_replace(coalesce(ident.canonical_jid, m.sender_jid), '[^0-9]', '', 'g'), 10)
          LIMIT 1
       ) emp ON true
      WHERE m.message_id = $1 ${accountClause}
      ORDER BY m.source_timestamp DESC
      LIMIT 10`,
    params,
  );
  return found.map((row) => {
    const canonical = String(row.sender_canonical_jid ?? '');
    const canonicalDigits = canonical.replace(/[^0-9]/g, '').replace(/^880/, '0');
    const jid = String(row.sender_jid ?? '');
    const jidDigits = jid.endsWith('@s.whatsapp.net')
      ? jid.replace(/[^0-9]/g, '').replace(/^880/, '0')
      : '';
    const digits = canonicalDigits.length >= 11 ? canonicalDigits : jidDigits;
    const sender_mobile = digits.length >= 11 ? digits.slice(-11) : null;
    const sender_name = row.sender_name
      ?? (jid ? `Unknown ${jid.replace(/[^0-9]/g, '').slice(-8)}` : null);
    return {...row, sender_name, sender_mobile};
  });
}

async function programSourcesFor(programId: string | null): Promise<ProgramSourceRow[]> {
  if (!programId) return [];
  return rows<ProgramSourceRow>(
    `SELECT psm.id, psm.program_id, psm.account_id, psm.chat_jid, psm.message_id, psm.source_role,
            m.text_content, m.source_timestamp::text, m.direction, m.sender_jid
       FROM program_source_messages psm
       LEFT JOIN whatsapp_messages m
              ON m.account_id = psm.account_id AND m.chat_jid = psm.chat_jid AND m.message_id = psm.message_id
      WHERE psm.program_id = $1
      ORDER BY psm.created_at`,
    [programId],
  );
}

/** Multi-message evidence for a set of programs (used by the vessel page). */
export async function listProgramSourcesForPrograms(programIds: string[]): Promise<ProgramSourceRow[]> {
  if (!programIds.length) return [];
  return rows<ProgramSourceRow>(
    `SELECT psm.id, psm.program_id, psm.account_id, psm.chat_jid, psm.message_id, psm.source_role,
            m.text_content, m.source_timestamp::text, m.direction, m.sender_jid
       FROM program_source_messages psm
       LEFT JOIN whatsapp_messages m
              ON m.account_id = psm.account_id AND m.chat_jid = psm.chat_jid AND m.message_id = psm.message_id
      WHERE psm.program_id = ANY($1::text[])
      ORDER BY psm.program_id, psm.created_at`,
    [programIds],
  );
}

async function auditHistoryFor(id: string): Promise<AuditHistoryRow[]> {
  return rows<AuditHistoryRow>(
    `SELECT a.id::text, a.at::text, a.actor, u.display_name AS actor_name, a.action,
            a.entity, a.entity_id, a.source, a.source_ref, a.detail
       FROM audit_events a
       LEFT JOIN cash_portal_users u ON u.id = a.actor
      WHERE (a.entity = 'review_item' AND a.entity_id = $1)
         OR (a.entity = 'cash_submission' AND a.entity_id = $1)
      ORDER BY a.at DESC, a.id DESC
      LIMIT 100`,
    [id],
  );
}

/**
 * Full detail for either a review_item or a cash_submission. The Review Queue
 * is the single place where both kinds of review evidence are shown; the
 * underlying state machines remain separate and unchanged.
 */
export async function getReviewDetail(id: string): Promise<ReviewDetail | null> {
  const reviewItem = await row<ReviewQueueRow>(
    `SELECT r.*, u.display_name AS submitter_name,
            d.decision, d.reason AS decision_reason, d.actor AS decided_by, d.created_at AS decision_at
       FROM review_items r
       LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
       LEFT JOIN review_decisions d ON d.item_id = r.id
      WHERE r.id = $1`,
    [id],
  );

  if (reviewItem) {
    const payload = (reviewItem.payload ?? {}) as Record<string, unknown>;
    const messageId = typeof payload.sourceMessageId === 'string' ? payload.sourceMessageId : null;
    const accountId = typeof payload.sourceAccountId === 'string' ? payload.sourceAccountId : null;
    const programId = typeof payload.programId === 'string'
      ? payload.programId
      : typeof payload.correlatedProgramId === 'string'
        ? payload.correlatedProgramId
        : reviewItem.domain === 'PROGRAM' && reviewItem.target_ref && /^[A-Za-z0-9._:-]{1,120}$/.test(reviewItem.target_ref)
          ? reviewItem.target_ref
          : null;
    const [sourceMessages, programSources, audit, relatedProgram, relatedInstruction] = await Promise.all([
      sourceMessagesFor(messageId, accountId),
      programSourcesFor(programId),
      auditHistoryFor(id),
      programId ? row<Record<string, unknown>>('SELECT * FROM programs WHERE id = $1', [programId]) : Promise.resolve(null),
      messageId
        ? row<Record<string, unknown>>(
            `SELECT * FROM cash_instructions
              WHERE source_message_id = $1
                AND ($2::text IS NULL OR source_block_key = $2)
              ORDER BY created_at DESC LIMIT 1`,
            [messageId, typeof payload.sourceBlockKey === 'string' ? payload.sourceBlockKey : null],
          )
        : Promise.resolve(null),
    ]);
    return {
      kind: 'review_item',
      item: reviewItem,
      submitter_name: reviewItem.submitter_name,
      decision: reviewItem.decision
        ? {decision: reviewItem.decision, reason: reviewItem.decision_reason, actor: reviewItem.decided_by, created_at: reviewItem.decision_at}
        : null,
      audit,
      sourceMessages,
      programSources,
      relatedProgram,
      relatedInstruction,
    };
  }

  const submission = await row<Record<string, unknown> & {id: string; state: string; submitted_by: string}>(
    `SELECT s.*, u.display_name AS submitter_name,
            d.decision, d.reason AS decision_reason, d.reviewer AS decided_by, d.created_at AS decision_at
       FROM cash_submissions s
       LEFT JOIN cash_portal_users u ON u.id = s.submitted_by
       LEFT JOIN cash_submission_reviews d ON d.submission_id = s.id
      WHERE s.id = $1`,
    [id],
  );
  if (!submission) return null;

  const payload = {...((submission.payload ?? {}) as Record<string, unknown>)};
  if (!payload.sourceMessageId && submission.source_message_id) payload.sourceMessageId = submission.source_message_id;
  if (!payload.sourceChatJid && submission.source_chat_jid) payload.sourceChatJid = submission.source_chat_jid;
  if (!payload.sourceAccountId && submission.source_account_id) payload.sourceAccountId = submission.source_account_id;
  if (!payload.category && submission.category) payload.category = submission.category;
  const messageId = typeof payload.sourceMessageId === 'string' ? payload.sourceMessageId : null;
  const accountId = typeof payload.sourceAccountId === 'string' ? payload.sourceAccountId : null;
  const [sourceMessages, audit, relatedInstruction] = await Promise.all([
    sourceMessagesFor(messageId, accountId),
    auditHistoryFor(id),
    messageId
      ? row<Record<string, unknown>>(
          `SELECT * FROM cash_instructions
            WHERE source_message_id = $1
              AND ($2::text IS NULL OR source_block_key = $2)
            ORDER BY created_at DESC LIMIT 1`,
          [messageId, typeof payload.sourceBlockKey === 'string' ? payload.sourceBlockKey : null],
        )
      : Promise.resolve(null),
  ]);

  return {
    kind: 'cash_submission',
    item: {...submission, payload},
    submitter_name: (submission.submitter_name as string | null) ?? null,
    decision: submission.decision
      ? {
          decision: String(submission.decision),
          reason: (submission.decision_reason as string | null) ?? null,
          actor: (submission.decided_by as string | null) ?? null,
          created_at: (submission.decision_at as string | null) ?? null,
        }
      : null,
    audit,
    sourceMessages,
    programSources: [],
    relatedProgram: null,
    relatedInstruction,
  };
}

// ── Cash review candidates ─────────────────────────────────────────────────
export type CashReviewCandidate = {
  id: string;
  payload: Record<string, unknown>;
  state: string;
  submitted_by: string;
  submitter_name: string | null;
  created_at: string;
  updated_at: string;
  corrected_by: string | null;
  corrected_at: string | null;
  source_message_id: string | null;
  source_chat_jid: string | null;
  source_account_id: string | null;
  category: string | null;
  decision: string | null;
  decision_reason: string | null;
  decided_at: string | null;
};

export async function listCashReviewCandidates(filters: {state?: string; q?: string; mine?: boolean; actor?: Actor; limit?: number} = {}): Promise<CashReviewCandidate[]> {
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 300);
  const params: unknown[] = [];
  const where: string[] = [];
  if (filters.state && filters.state !== 'ALL') {
    if (filters.state === 'RESOLVED') where.push(`s.state IN ('APPROVED','REJECTED')`);
    else {
      params.push(filters.state);
      where.push(`s.state = $${params.length}`);
    }
  }
  if (filters.q) {
    params.push(`%${filters.q}%`);
    where.push(`(s.id ILIKE $${params.length} OR s.payload->>'rawText' ILIKE $${params.length}
      OR s.payload->>'sourceMessageId' ILIKE $${params.length}
      OR s.payload->>'employeeName' ILIKE $${params.length}
      OR u.display_name ILIKE $${params.length})`);
  }
  if (filters.mine) {
    if (!filters.actor) throw new DomainError('ACTOR_REQUIRED', 401);
    params.push(filters.actor.id);
    where.push(`s.submitted_by = $${params.length}`);
  }
  params.push(limit);
  return rows<CashReviewCandidate>(
    `SELECT s.*, u.display_name AS submitter_name,
            d.decision, d.reason AS decision_reason, d.reviewer AS decided_by, d.created_at AS decision_at
       FROM cash_submissions s
       LEFT JOIN cash_portal_users u ON u.id = s.submitted_by
       LEFT JOIN cash_submission_reviews d ON d.submission_id = s.id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY s.created_at DESC
      LIMIT $${params.length}`,
    params,
  );
}

// ── Corrections (no approval, posting or settlement) ───────────────────────
const CASH_METHODS = ['bkash', 'nagad', 'rocket', 'bank', 'cash'];

function validateCorrections(domain: string, corrections: Record<string, unknown>): Record<string, string | number | null> {
  const clean: Record<string, string | number | null> = {};
  const allowed = domain === 'PROGRAM'
    ? ['motherVessel', 'lighterVessel', 'masterMobile', 'destination', 'escortName', 'escortMobile', 'startDate', 'startShift', 'endDate', 'endShift', 'notes']
    : domain === 'CASH'
      ? ['employeeName', 'employeeMobile', 'payoutMobile', 'method', 'amountMinor', 'purpose', 'accountId']
      : domain === 'EMPLOYEE'
        ? ['preferredName', 'employeeMobile', 'dutyType', 'designation', 'state', 'dateOfJoin', 'altMobile', 'homePhone', 'presentAddress', 'permanentAddress', 'referenceName', 'referenceMobile', 'nidNumber', 'birthCertNumber', 'passportNumber', 'notes']
        : domain === 'ATTENDANCE'
          ? ['employeeMobile', 'attendanceDate', 'dutyDate', 'shift', 'location', 'clientName', 'designation', 'remarks', 'state', 'hours']
          : [];
  for (const [key, value] of Object.entries(corrections)) {
    if (!allowed.includes(key)) throw new DomainError('UNSUPPORTED_CORRECTION', 400);
    if (value === undefined || value === null || value === '') {
      clean[key] = null;
      continue;
    }
    if (key === 'amountMinor') {
      const amount = Number(value);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError('INVALID_AMOUNT');
      clean[key] = amount;
      continue;
    }
    if (key === 'method') {
      const method = String(value).toLowerCase();
      if (!CASH_METHODS.includes(method)) throw new DomainError('INVALID_METHOD');
      clean[key] = method;
      continue;
    }
    if (key === 'shift' && domain === 'ATTENDANCE') {
      const nextShift = String(value).toUpperCase();
      if (!['D', 'N', 'FULL'].includes(nextShift)) throw new DomainError('INVALID_SHIFT');
      clean[key] = nextShift;
      continue;
    }
    if (key === 'startShift' || key === 'endShift') {
      clean[key] = shift(value, key);
      continue;
    }
    if (key === 'startDate' || key === 'endDate' || key === 'dutyDate' || key === 'attendanceDate' || key === 'dateOfJoin') {
      clean[key] = isoDate(value, key);
      continue;
    }
    if (key === 'employeeMobile' || key === 'payoutMobile' || key === 'escortMobile' || key === 'altMobile' || key === 'referenceMobile') {
      clean[key] = optionalMobile(value, key);
      continue;
    }
    if (key === 'masterMobile') {
      const digits = String(value).replace(/[^0-9]/g, '');
      const normalized = digits.replace(/^880(1[3-9][0-9]{8})$/, '0$1');
      if (normalized && !/^01[3-9][0-9]{8}$/.test(normalized)) throw new DomainError('INVALID_MASTERMOBILE');
      clean[key] = normalized || null;
      continue;
    }
    const stringValue = String(value).trim();
    if (!stringValue) throw new DomainError(`INVALID_${key.toUpperCase()}`);
    clean[key] = stringValue.slice(0, 2000);
  }
  if (!Object.keys(clean).length) throw new DomainError('NO_CORRECTIONS');
  return clean;
}

function mergeCorrections(payload: Record<string, unknown>, corrections: Record<string, string | number | null>): Record<string, unknown> {
  const fields = (payload.fields && typeof payload.fields === 'object' && !Array.isArray(payload.fields))
    ? {...(payload.fields as Record<string, unknown>), ...corrections}
    : {...corrections};
  const extractedFields = (payload.extractedFields && typeof payload.extractedFields === 'object' && !Array.isArray(payload.extractedFields))
    ? {...(payload.extractedFields as Record<string, unknown>), ...corrections}
    : {...corrections};
  return {...payload, ...corrections, fields, extractedFields, correctedFields: Object.keys(corrections)};
}

/**
 * Correct supported extracted fields on a pending review item. The item stays
 * PENDING; this never approves, posts or settles. ADMIN only, never the
 * submitter, and every change is written to the append-only audit trail.
 */
export async function correctReviewItem(actor: Actor, id: string, corrections: Record<string, unknown>) {
  assertCapability(actor, 'review.decide');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const clean = validateCorrections(String((await row<{domain: string}>('SELECT domain FROM review_items WHERE id = $1', [id]))?.domain ?? ''), corrections);
  return tx(async (client) => {
    const found = await client.query<{id: string; domain: string; payload: Record<string, unknown>; submitted_by: string; state: string}>(
      'SELECT id, domain, payload, submitted_by, state FROM review_items WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!found.rowCount) throw new DomainError('ITEM_NOT_FOUND', 404);
    const item = found.rows[0];
    if (item.state !== 'PENDING') throw new DomainError('ITEM_NOT_PENDING', 409);
    if (item.submitted_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    const merged = mergeCorrections(item.payload ?? {}, clean);
    await client.query(
      `UPDATE review_items
          SET payload = $2::jsonb, updated_at = now(), corrected_by = $3, corrected_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(merged), actor.id],
    );
    await recordAudit({
      actor,
      action: 'REVIEW_ITEM_CORRECTED',
      entity: 'review_item',
      entityId: id,
      detail: {domain: item.domain, corrections: clean, state: 'PENDING'},
    }, client);
    await portalAudit(actor.id, id, 'REVIEW_ITEM_CORRECTED', {domain: item.domain, corrections: clean}, client);
    return {id, corrected: true, fields: Object.keys(clean), state: 'PENDING'};
  }).then((result) => {
    emitDomainEvent('REVIEW', 'REVIEW_ITEM_CORRECTED', id);
    return result;
  });
}

/**
 * Correct supported fields on a pending cash review candidate. This updates
 * the candidate payload only. It does not approve, post or settle funds and
 * does not create a cash instruction.
 */
export async function correctCashSubmission(actor: Actor, id: string, corrections: Record<string, unknown>) {
  assertCapability(actor, 'review.decide');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const clean = validateCorrections('CASH', corrections);
  return tx(async (client) => {
    const found = await client.query<{id: string; payload: Record<string, unknown>; submitted_by: string; state: string}>(
      'SELECT id, payload, submitted_by, state FROM cash_submissions WHERE id = $1 FOR UPDATE',
      [id],
    );
    if (!found.rowCount) throw new DomainError('SUBMISSION_NOT_FOUND', 404);
    const submission = found.rows[0];
    if (submission.state !== 'PENDING_REVIEW') throw new DomainError('SUBMISSION_NOT_PENDING', 409);
    if (submission.submitted_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    const merged = mergeCorrections(submission.payload ?? {}, clean);
    await client.query(
      `UPDATE cash_submissions
          SET payload = $2::jsonb, updated_at = now(), corrected_by = $3, corrected_at = now()
        WHERE id = $1`,
      [id, JSON.stringify(merged), actor.id],
    );
    await recordAudit({
      actor,
      action: 'CASH_SUBMISSION_CORRECTED',
      entity: 'cash_submission',
      entityId: id,
      detail: {corrections: clean, state: 'PENDING_REVIEW'},
    }, client);
    return {id, corrected: true, fields: Object.keys(clean), state: 'PENDING_REVIEW'};
  }).then((result) => {
    emitDomainEvent('REVIEW', 'CASH_SUBMISSION_CORRECTED', id);
    return result;
  });
}

// ── Submit / decide / withdraw (existing state machines) ───────────────────
/**
 * Hard-delete a PENDING review submission and, when it targets an existing
 * domain row, that row as well. This is the Owner's "Delete means delete"
 * rule. Immutable ledger/audit rows are never touched; a row with financial or
 * dependent history is refused instead of being half-deleted.
 */
export async function deletePendingReview(
  actor: Actor,
  id: string,
  kind: 'review_item' | 'cash_submission',
) {
  if (!can(actor, 'review.decide')) throw new DomainError('CAPABILITY_REQUIRED', 403, 'review.decide');
  return tx(async (client) => {
    if (kind === 'cash_submission') {
      const found = await client.query<{id: string; state: string; payload: Record<string, unknown>}>(
        'SELECT id, state, payload FROM cash_submissions WHERE id = $1 FOR UPDATE', [id],
      );
      if (!found.rowCount) throw new DomainError('REVIEW_NOT_FOUND', 404);
      if (found.rows[0].state !== 'PENDING_REVIEW') throw new DomainError('REVIEW_NOT_PENDING', 409);
      const payload = found.rows[0].payload ?? {};
      const instructionId = typeof payload.instructionId === 'string' ? payload.instructionId : null;
      let domainDeleted = false;
      if (instructionId) {
        const instruction = await client.query<{state: string}>(
          'SELECT state FROM cash_instructions WHERE id = $1 FOR UPDATE', [instructionId],
        );
        if (instruction.rowCount) {
          if (['POSTED', 'REVERSED'].includes(instruction.rows[0].state)) {
            throw new DomainError('POSTED_CASH_REQUIRES_REVERSAL', 409,
              'Posted cash cannot be deleted. Reverse it first so the ledger stays balanced.');
          }
          const dependencies = await client.query<{count: string}>(
            `SELECT count(*)::text AS count FROM cash_payment_events WHERE instruction_id = $1
              UNION ALL SELECT count(*)::text FROM cash_postings WHERE instruction_id = $1
              UNION ALL SELECT count(*)::text FROM cash_submissions WHERE instruction_id = $1 AND id <> $2`,
            [instructionId, id],
          );
          if (dependencies.rows.some((entry) => Number(entry.count) > 0)) {
            throw new DomainError('CASH_IN_USE', 409, 'This cash row has financial history and cannot be deleted.');
          }
          await client.query('DELETE FROM cash_instructions WHERE id = $1', [instructionId]);
          domainDeleted = true;
        }
      }
      await client.query('DELETE FROM cash_submissions WHERE id = $1', [id]);
      return {deleted: true, domainDeleted, kind, id};
    }

    const found = await client.query<{
      id: string; domain: Domain; action: Action; target_ref: string | null; state: string;
    }>('SELECT id, domain, action, target_ref, state FROM review_items WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('REVIEW_NOT_FOUND', 404);
    const item = found.rows[0];
    if (item.state !== 'PENDING') throw new DomainError('REVIEW_NOT_PENDING', 409);
    let domainDeleted = false;
    if (item.target_ref && item.action !== 'CREATE') {
      if (item.domain === 'EMPLOYEE') {
        await deleteEmployee(actor, item.target_ref, client);
        domainDeleted = true;
      } else if (item.domain === 'PROGRAM') {
        await hardDeleteProgram(client, item.target_ref);
        domainDeleted = true;
      } else if (item.domain === 'ATTENDANCE') {
        await hardDeleteAttendance(client, item.target_ref);
        domainDeleted = true;
      }
    }
    await client.query('DELETE FROM review_items WHERE id = $1', [id]);
    return {deleted: true, domainDeleted, kind, id};
  }).then((result) => {
    emitDomainEvent('REVIEW', 'REVIEW_DELETED', id);
    return result;
  });
}

export async function submitForReview(
  actor: Actor,
  input: {domain: string; action: string; targetRef?: string | null; payload: Record<string, unknown>},
) {
  const domain = input.domain as Domain;
  if (!DOMAINS.includes(domain)) throw new DomainError('INVALID_DOMAIN');
  if (!['CREATE', 'UPDATE', 'DELETE'].includes(input.action)) throw new DomainError('INVALID_ACTION');
  if (domain === 'CASH') throw new DomainError('USE_CASH_SUBMISSION', 400);
  if (!input.payload || typeof input.payload !== 'object') throw new DomainError('INVALID_PAYLOAD');
  const id = newId('rev');
  const category = typeof input.payload.category === 'string' ? input.payload.category : null;
  const created = await row(
    `INSERT INTO review_items (id, domain, action, target_ref, payload, submitted_by, category)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, domain, input.action, input.targetRef ?? null, JSON.stringify(input.payload), actor.id, category],
  );
  if (!created) throw new DomainError('PENDING_REVIEW_EXISTS', 409);
  await recordAudit({actor, action: 'REVIEW_SUBMITTED', entity: 'review_item', entityId: id, detail: {domain, category}});
  await portalAudit(actor.id, id, 'REVIEW_SUBMITTED', {domain, action: input.action, category});
  emitDomainEvent('REVIEW', 'REVIEW_SUBMITTED', id);
  return created;
}

async function hardDeleteProgram(client: Pick<PoolClient, 'query'>, programId: string) {
  // program_assignments is the only RESTRICT reference; program_pay and
  // program_source_messages are ON DELETE CASCADE. program_events is immutable
  // by design and intentionally remains as the audit trail.
  await client.query('DELETE FROM program_assignments WHERE program_id = $1', [programId]);
  const deleted = await client.query('DELETE FROM programs WHERE id = $1 RETURNING id', [programId]);
  if (!deleted.rowCount) throw new DomainError('PROGRAM_NOT_FOUND', 404);
  return {id: programId, deleted: true};
}

async function hardDeleteAttendance(client: Pick<PoolClient, 'query'>, id: string) {
  const deleted = await client.query('DELETE FROM attendance_records WHERE id = $1 RETURNING id', [id]);
  if (!deleted.rowCount) throw new DomainError('ATTENDANCE_NOT_FOUND', 404);
  return {id, deleted: true};
}

async function applyItem(
  client: Pick<PoolClient, 'query'>,
  actor: Actor,
  item: {domain: Domain; action: Action; target_ref: string | null; payload: Record<string, unknown>},
) {
  if (item.domain === 'EMPLOYEE' && item.action === 'CREATE') return createEmployee(actor, item.payload as never, client);
  if (item.domain === 'EMPLOYEE' && item.action === 'UPDATE') {
    if (!item.target_ref) throw new DomainError('TARGET_REQUIRED');
    return updateEmployee(actor, item.target_ref, item.payload as never, client);
  }
  if (item.domain === 'EMPLOYEE' && item.action === 'DELETE') {
    if (!item.target_ref) throw new DomainError('TARGET_REQUIRED');
    return deleteEmployee(actor, item.target_ref, client);
  }
  if (item.domain === 'PROGRAM' && item.action === 'DELETE') {
    if (!item.target_ref) throw new DomainError('TARGET_REQUIRED');
    return hardDeleteProgram(client, item.target_ref);
  }
  if (item.domain === 'ATTENDANCE' && (item.action === 'UPDATE' || item.action === 'DELETE')) {
    if (!item.target_ref) throw new DomainError('TARGET_REQUIRED');
    if (item.action === 'DELETE') return hardDeleteAttendance(client, item.target_ref);
    const payload = item.payload ?? {};
    const found = await client.query<{
      employee_mobile: string; attendance_date: string; shift: string;
      location: string | null; client_name: string | null; designation: string | null; remarks: string | null;
    }>('SELECT employee_mobile, attendance_date::text, shift, location, client_name, designation, remarks FROM attendance_records WHERE id = $1 FOR UPDATE',
      [item.target_ref]);
    if (!found.rowCount) throw new DomainError('ATTENDANCE_NOT_FOUND', 404);
    const current = found.rows[0];
    const value = (key: string, fallback: unknown) => payload[key] === undefined ? fallback : payload[key];
    await client.query(
      `UPDATE attendance_records
          SET employee_mobile=$2, attendance_date=$3, shift=$4, location=$5,
              client_name=$6, designation=$7, remarks=$8, updated_at=now()
        WHERE id=$1`,
      [item.target_ref,
        optionalMobile(value('employeeMobile', current.employee_mobile), 'employeeMobile') ?? current.employee_mobile,
        isoDate(value('attendanceDate', value('dutyDate', current.attendance_date)), 'attendanceDate'),
        shift(value('shift', current.shift), 'shift'),
        value('location', current.location) === null ? null : String(value('location', current.location)).slice(0, 250),
        value('clientName', current.client_name) === null ? null : String(value('clientName', current.client_name)).slice(0, 150),
        value('designation', current.designation) === null ? null : String(value('designation', current.designation)).slice(0, 80),
        value('remarks', current.remarks) === null ? null : String(value('remarks', current.remarks)).slice(0, 2000)],
    );
    return {id: item.target_ref, updated: true};
  }
  if (item.domain === 'PROGRAM' && (item.action === 'CREATE' || item.action === 'UPDATE')) {
    const payload = item.payload ?? {};
    const parser = typeof payload.parser === 'string' ? payload.parser : '';
    const classification = typeof payload.classification === 'string' ? payload.classification : '';

    // Preflight: release slips/evidence need a matched program (v3.3.5).
    if (parser === 'release-slip' || payload.releaseCategory) {
      throw new DomainError('RELEASE_NOT_APPROVABLE', 400,
        'This is an escort release slip. Manual program matching will be available in v3.3.5. Please Decline for now.');
    }

    // Preflight: confirmations/assignments need the v3.3.5 matching/assign flow.
    if (parser === 'applyConfirmation' || classification.startsWith('CONFIRMATION_')) {
      throw new DomainError('CONFIRMATION_NOT_APPROVABLE', 400,
        'This is an escort assignment/confirmation message. Manual program matching and escort assign flow will be available in v3.3.5.');
    }

    // Preflight: cash instructions misrouted to PROGRAM. Only messages from
    // the Bridge-1 -> Accountant chat are treated as cash.
    if (parser === 'message-router') {
      const accountantJid = process.env.ACCOUNTANT_CHAT_JID;
      const sourceMessageId = typeof payload.sourceMessageId === 'string' ? payload.sourceMessageId : null;
      const sourceAccountId = typeof payload.sourceAccountId === 'string' ? payload.sourceAccountId : null;
      if (accountantJid && sourceMessageId && sourceAccountId === 'wa-01') {
        const message = await client.query<{chat_jid: string; text_content: string | null}>(
          `SELECT chat_jid, text_content
             FROM whatsapp_messages
            WHERE message_id = $1 AND account_id = $2
            ORDER BY source_timestamp DESC
            LIMIT 1`,
          [sourceMessageId, sourceAccountId],
        );
        const chatJid = message.rows[0]?.chat_jid ?? null;
        const body = message.rows[0]?.text_content ?? '';
        const cashPattern = /\bI\s*D\s*:?\s*[+\d\s()-]{10,18}\s+.+?\s+[+\d\s()-]{10,18}\s*\(\s*[BNRC]\s*\)\s*[-/\s]*\d[\d,]*\s*[-/\s]+/i;
        if (chatJid === accountantJid && cashPattern.test(body)) {
          throw new DomainError('CASH_MESSAGE_MISROUTED', 400,
            'This is a cash instruction from Bridge-1 to Accountant, not a vessel order. Please Decline.');
        }
      }
    }

    // Flatten parser output. Top-level corrections (Admin "correct") win.
    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
    const merged: Record<string, unknown> = {
      ...asRecord(payload.fields),
      ...asRecord(payload.extractedFields),
      ...payload,
    };
    for (const key of ['parser', 'rawText', 'sourceMessageId', 'sourceTimestamp', 'sourceAccountId',
      'senderJid', 'candidates', 'releaseCategory', 'category', 'fields', 'extractedFields',
      'classification', 'error']) {
      delete merged[key];
    }

    // A real USER edit targets an existing program and may legitimately omit
    // identity fields (updateProgram keeps the current values). Creates and
    // parser fallbacks must carry at least the mother vessel.
    const isRealUpdate = item.action === 'UPDATE' && Boolean(item.target_ref?.startsWith('prog_'));
    if (!isRealUpdate && (typeof merged.motherVessel !== 'string' || !merged.motherVessel.trim())) {
      throw new DomainError('MISSING_REQUIRED_FIELDS', 400,
        'Mother Vessel is required. Use Correct to fill in vessel fields, then Approve.');
    }

    if (item.action === 'CREATE') return createProgram(actor, merged as never, {}, client);
    // Parser failures can carry a message id instead of a program id;
    // approving those creates the program from the reviewed fields.
    if (!isRealUpdate) return createProgram(actor, merged as never, {}, client);
    return updateProgram(actor, item.target_ref as string, merged as never, client);
  }
  if (item.domain === 'ATTENDANCE' && item.action === 'CREATE') return createAttendanceRecord(actor, item.payload as never, client);
  throw new DomainError(`DOMAIN_NOT_IMPLEMENTED:${item.domain}:${item.action}`, 501);
}

export type PendingProgramReview = {
  id: string;
  action: string;
  category: string | null;
  target_ref: string | null;
  payload: Record<string, unknown>;
  submitted_by: string;
  submitter_name: string | null;
  created_at: string;
  source_message_id: string | null;
  source_timestamp: string | null;
  raw_text: string | null;
  sender_name: string | null;
  sender_mobile: string | null;
  /** Current program values for an UPDATE submission (merged for display). */
  target: {
    motherVessel: string | null;
    lighterVessel: string | null;
    masterMobile: string | null;
    destination: string | null;
    escortName: string | null;
    escortMobile: string | null;
    startDate: string | null;
    startShift: string | null;
    endDate: string | null;
    endShift: string | null;
    notes: string | null;
  } | null;
};

/**
 * PENDING PROGRAM review items with their original WhatsApp evidence resolved.
 * Used by the /review vessel table (source-message and submitted-data dialogs).
 */
export async function listPendingProgramReviews(limit = 300): Promise<PendingProgramReview[]> {
  const items = await rows<{
    id: string; action: string; category: string | null; target_ref: string | null;
    payload: Record<string, unknown>; submitted_by: string; submitter_name: string | null;
    created_at: string; source_message_id: string | null; source_timestamp: string | null;
    raw_text: string | null; sender_name: string | null; sender_jid: string | null;
    sender_canonical_jid: string | null;
    target_mother_vessel: string | null; target_lighter_vessel: string | null;
    target_master_mobile: string | null; target_destination: string | null;
    target_escort_name: string | null; target_escort_mobile: string | null;
    target_start_date: string | null; target_start_shift: string | null;
    target_end_date: string | null; target_end_shift: string | null; target_notes: string | null;
  }>(
    `SELECT r.id, r.action, r.category, r.target_ref, r.payload, r.submitted_by,
            u.display_name AS submitter_name, r.created_at::text AS created_at,
            wm.message_id AS source_message_id, wm.source_timestamp::text AS source_timestamp,
            coalesce(wm.text_content, r.payload->>'rawText') AS raw_text,
            coalesce(ident.display_name, emp.preferred_name) AS sender_name,
            wm.sender_jid, ident.canonical_jid AS sender_canonical_jid,
            p.mother_vessel AS target_mother_vessel, p.lighter_vessel AS target_lighter_vessel,
            p.master_mobile AS target_master_mobile, p.destination AS target_destination,
            p.escort_name AS target_escort_name, p.escort_mobile AS target_escort_mobile,
            p.start_date::text AS target_start_date, p.start_shift AS target_start_shift,
            p.end_date::text AS target_end_date, p.end_shift AS target_end_shift,
            p.notes AS target_notes
       FROM review_items r
       LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
       LEFT JOIN programs p ON p.id = r.target_ref
       LEFT JOIN LATERAL (
         SELECT m.account_id, m.chat_jid, m.message_id, m.source_timestamp, m.text_content, m.sender_jid
           FROM whatsapp_messages m
          WHERE m.message_id = coalesce(r.payload->>'sourceMessageId', r.target_ref)
          ORDER BY m.source_timestamp DESC
          LIMIT 1
       ) wm ON true
       LEFT JOIN LATERAL (
         SELECT ia.display_name, ia.canonical_jid
           FROM identity_aliases ia
          WHERE ia.account_id = wm.account_id
            AND (ia.jid = wm.sender_jid
                 OR ia.jid = wm.sender_jid || '@lid'
                 OR ia.canonical_jid = wm.sender_jid)
          ORDER BY (ia.canonical_jid IS NOT NULL) DESC,
                   (ia.display_name IS NOT NULL) DESC,
                   ia.updated_at DESC
          LIMIT 1
       ) ident ON true
       LEFT JOIN LATERAL (
         SELECT e.preferred_name
           FROM employees e
          WHERE right(regexp_replace(e.employee_mobile, '[^0-9]', '', 'g'), 10)
                = right(regexp_replace(coalesce(ident.canonical_jid, wm.sender_jid), '[^0-9]', '', 'g'), 10)
          LIMIT 1
       ) emp ON true
      WHERE r.domain = 'PROGRAM' AND r.state = 'PENDING'
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return items.map((item) => {
    const jid = String(item.sender_jid ?? '');
    const canonical = String(item.sender_canonical_jid ?? '');
    const canonicalDigits = canonical.replace(/[^0-9]/g, '').replace(/^880/, '0');
    const jidDigits = jid.endsWith('@s.whatsapp.net')
      ? jid.replace(/[^0-9]/g, '').replace(/^880/, '0')
      : '';
    const digits = canonicalDigits.length >= 11 ? canonicalDigits : jidDigits;
    const mobile = digits.length >= 11 ? digits.slice(-11) : null;
    const senderName = item.sender_name
      ?? (jid ? `Unknown ${jid.replace(/[^0-9]/g, '').slice(-8)}` : null);
    return {
      id: item.id,
      action: item.action,
      category: item.category,
      target_ref: item.target_ref,
      payload: item.payload ?? {},
      submitted_by: item.submitted_by,
      submitter_name: item.submitter_name,
      created_at: item.created_at,
      source_message_id: item.source_message_id,
      source_timestamp: item.source_timestamp,
      raw_text: item.raw_text,
      sender_name: senderName,
      sender_mobile: mobile,
      target: item.target_mother_vessel || item.target_lighter_vessel
        ? {
            motherVessel: item.target_mother_vessel,
            lighterVessel: item.target_lighter_vessel,
            masterMobile: item.target_master_mobile,
            destination: item.target_destination,
            escortName: item.target_escort_name,
            escortMobile: item.target_escort_mobile,
            startDate: item.target_start_date,
            startShift: item.target_start_shift,
            endDate: item.target_end_date,
            endShift: item.target_end_shift,
            notes: item.target_notes,
          }
        : null,
    };
  });
}

export type PendingEmployeeReview = {
  id: string;
  action: string;
  target_ref: string | null;
  payload: Record<string, unknown>;
  submitted_by: string;
  submitter_name: string | null;
  created_at: string;
};

/** PENDING EMPLOYEE submissions for the /review employee table. */
export async function listPendingEmployeeReviews(limit = 300): Promise<PendingEmployeeReview[]> {
  return rows<PendingEmployeeReview>(
    `SELECT r.id, r.action, r.target_ref, r.payload, r.submitted_by,
            u.display_name AS submitter_name, r.created_at::text AS created_at
       FROM review_items r
       LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
      WHERE r.domain = 'EMPLOYEE' AND r.state = 'PENDING'
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export type PendingAttendanceReview = {
  id: string;
  action: string;
  target_ref: string | null;
  payload: Record<string, unknown>;
  submitted_by: string;
  submitter_name: string | null;
  created_at: string;
  preferred_name: string | null;
  employee_designation: string | null;
};

/** PENDING ATTENDANCE submissions for the /review attendance table. */
export async function listPendingAttendanceReviews(limit = 300): Promise<PendingAttendanceReview[]> {
  return rows<PendingAttendanceReview>(
    `SELECT r.id, r.action, r.target_ref, r.payload, r.submitted_by,
            u.display_name AS submitter_name, r.created_at::text AS created_at,
            e.preferred_name, e.designation AS employee_designation
       FROM review_items r
       LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
       LEFT JOIN employees e
              ON right(regexp_replace(e.employee_mobile, '[^0-9]', '', 'g'), 10)
               = right(regexp_replace(r.payload->>'employeeMobile', '[^0-9]', '', 'g'), 10)
      WHERE r.domain = 'ATTENDANCE' AND r.state = 'PENDING'
      ORDER BY r.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

export async function decideReview(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  assertCapability(actor, 'review.decide');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const why = optionalText(reason, 'reason', 500);
  return tx(async (client) => {
    const found = await client.query<{
      id: string; domain: Domain; action: Action; target_ref: string | null;
      payload: Record<string, unknown>; submitted_by: string; state: string;
    }>('SELECT id, domain, action, target_ref, payload, submitted_by, state FROM review_items WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('ITEM_NOT_FOUND', 404);
    const item = found.rows[0];
    if (item.state !== 'PENDING') throw new DomainError('ITEM_NOT_PENDING', 409);
    if (item.submitted_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);

    let applied: unknown = null;
    if (decision === 'APPROVED') applied = await applyItem(client, actor, item);

    await client.query(
      `UPDATE review_items SET state = $2, decided_at = now(), updated_at = now() WHERE id = $1`,
      [id, decision],
    );
    await client.query(
      `INSERT INTO review_decisions (id, item_id, decision, reason, actor) VALUES ($1,$2,$3,$4,$5)`,
      [newId('rvd'), id, decision, why, actor.id],
    );
    await recordAudit({actor, action: `REVIEW_${decision}`, entity: 'review_item', entityId: id,
      detail: {domain: item.domain, action: item.action}}, client);
    await portalAudit(actor.id, id, `REVIEW_${decision}`, {domain: item.domain, action: item.action, reason: why}, client);
    return {id, state: decision, applied};
  }).then((result) => {
    emitDomainEvent('REVIEW', `REVIEW_${decision}`, id);
    return result;
  });
}

export async function withdrawReview(actor: Actor, id: string) {
  return tx(async (client) => {
    const found = await client.query<{submitted_by: string; state: string}>(
      'SELECT submitted_by, state FROM review_items WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('ITEM_NOT_FOUND', 404);
    if (found.rows[0].submitted_by !== actor.id) throw new DomainError('NOT_SUBMITTER', 403);
    if (found.rows[0].state !== 'PENDING') throw new DomainError('ITEM_NOT_PENDING', 409);
    await client.query(
      `UPDATE review_items SET state = 'WITHDRAWN', decided_at = now(), updated_at = now() WHERE id = $1`, [id],
    );
    await recordAudit({actor, action: 'REVIEW_WITHDRAWN', entity: 'review_item', entityId: id}, client);
    await portalAudit(actor.id, id, 'REVIEW_WITHDRAWN', {}, client);
    return {id, state: 'WITHDRAWN'};
  }).then((result) => {
    emitDomainEvent('REVIEW', 'REVIEW_WITHDRAWN', id);
    return result;
  });
}

// ── Queue counts (dashboard / navigation badge) ────────────────────────────
export type ReviewQueueCounts = {
  pending: number;
  cashPending: number;
  byCategory: Record<string, number>;
};

export async function reviewQueueCounts(): Promise<ReviewQueueCounts> {
  const [items, cash] = await Promise.all([
    rows<{category: string | null; count: string}>(
      `SELECT category, count(*)::text AS count FROM review_items WHERE state = 'PENDING' GROUP BY category`,
    ),
    row<{count: string}>(
      `SELECT count(*)::text AS count FROM cash_submissions WHERE state = 'PENDING_REVIEW'`,
    ),
  ]);
  const byCategory: Record<string, number> = {};
  let pending = 0;
  for (const item of items) {
    const count = Number(item.count);
    pending += count;
    byCategory[item.category ?? 'UNCATEGORISED'] = count;
  }
  return {pending, cashPending: Number(cash?.count ?? 0), byCategory};
}

export const reviewText = text;
