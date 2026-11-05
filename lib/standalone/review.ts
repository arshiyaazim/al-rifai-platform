import {rows, row, tx, text, optionalText, optionalMobile, isoDate, shift, DomainError, type Actor} from './db.ts';
import {recordAudit, newId} from './audit.ts';
import {createEmployee, updateEmployee} from './employees.ts';
import {createProgram} from './programs.ts';
import {recordAttendance} from './attendance.ts';

export type Domain = 'EMPLOYEE' | 'PROGRAM' | 'ATTENDANCE' | 'CASH';
export type Action = 'CREATE' | 'UPDATE' | 'DELETE';

const DOMAINS: Domain[] = ['EMPLOYEE', 'PROGRAM', 'ATTENDANCE', 'CASH'];

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
  return rows<SourceMessageRow>(
    `SELECT m.id::text, m.account_id, m.chat_jid, m.message_id, m.direction, m.sender_jid,
            m.source_timestamp::text, m.text_content, m.media_type,
            wm.status AS media_status, m.processing_status, m.classification
       FROM whatsapp_messages m
       LEFT JOIN whatsapp_media wm
              ON wm.account_id = m.account_id AND wm.chat_jid = m.chat_jid AND wm.message_id = m.message_id
      WHERE m.message_id = $1 ${accountClause}
      ORDER BY m.source_timestamp DESC
      LIMIT 10`,
    params,
  );
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
        ? ['preferredName', 'employeeMobile', 'dutyType']
        : domain === 'ATTENDANCE'
          ? ['employeeMobile', 'dutyDate', 'state', 'hours']
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
    if (key === 'startShift' || key === 'endShift') {
      clean[key] = shift(value, key);
      continue;
    }
    if (key === 'startDate' || key === 'endDate' || key === 'dutyDate') {
      clean[key] = isoDate(value, key);
      continue;
    }
    if (key === 'employeeMobile' || key === 'payoutMobile' || key === 'escortMobile') {
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
    });
    return {id, corrected: true, fields: Object.keys(clean), state: 'PENDING'};
  });
}

/**
 * Correct supported fields on a pending cash review candidate. This updates
 * the candidate payload only. It does not approve, post or settle funds and
 * does not create a cash instruction.
 */
export async function correctCashSubmission(actor: Actor, id: string, corrections: Record<string, unknown>) {
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
    });
    return {id, corrected: true, fields: Object.keys(clean), state: 'PENDING_REVIEW'};
  });
}

// ── Submit / decide / withdraw (existing state machines) ───────────────────
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
  return created;
}

async function applyItem(actor: Actor, item: {domain: Domain; action: Action; target_ref: string | null; payload: Record<string, unknown>}) {
  if (item.domain === 'EMPLOYEE' && item.action === 'CREATE') return createEmployee(actor, item.payload as never);
  if (item.domain === 'EMPLOYEE' && item.action === 'UPDATE') {
    if (!item.target_ref) throw new DomainError('TARGET_REQUIRED');
    return updateEmployee(actor, item.target_ref, item.payload as never);
  }
  if (item.domain === 'PROGRAM' && item.action === 'CREATE') return createProgram(actor, item.payload as never);
  if (item.domain === 'ATTENDANCE' && item.action === 'CREATE') return recordAttendance(actor, item.payload as never);
  throw new DomainError(`DOMAIN_NOT_IMPLEMENTED:${item.domain}:${item.action}`, 501);
}

export async function decideReview(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
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
    if (decision === 'APPROVED') applied = await applyItem(actor, item);

    await client.query(
      `UPDATE review_items SET state = $2, decided_at = now(), updated_at = now() WHERE id = $1`,
      [id, decision],
    );
    await client.query(
      `INSERT INTO review_decisions (id, item_id, decision, reason, actor) VALUES ($1,$2,$3,$4,$5)`,
      [newId('rvd'), id, decision, why, actor.id],
    );
    await recordAudit({actor, action: `REVIEW_${decision}`, entity: 'review_item', entityId: id,
      detail: {domain: item.domain, action: item.action}});
    return {id, state: decision, applied};
  });
}

export async function withdrawReview(actor: Actor, id: string) {
  const found = await row<{submitted_by: string; state: string}>('SELECT submitted_by, state FROM review_items WHERE id = $1', [id]);
  if (!found) throw new DomainError('ITEM_NOT_FOUND', 404);
  if (found.submitted_by !== actor.id) throw new DomainError('NOT_SUBMITTER', 403);
  if (found.state !== 'PENDING') throw new DomainError('ITEM_NOT_PENDING', 409);
  await row(`UPDATE review_items SET state = 'WITHDRAWN', decided_at = now(), updated_at = now() WHERE id = $1 RETURNING id`, [id]);
  await recordAudit({actor, action: 'REVIEW_WITHDRAWN', entity: 'review_item', entityId: id});
  return {id, state: 'WITHDRAWN'};
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
