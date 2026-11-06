import type {PoolClient} from 'pg';
import {rows, row, tx, text, optionalText, optionalMobile, isoDate, moneyMinor, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId, newId} from './audit.ts';
import {assertCapability} from './authz.ts';

type Tx = Pick<PoolClient, 'query'>;

// ── accounts ────────────────────────────────────────────────────────────────
export type AccountRow = {
  id: string; code: string; name: string; type: string; currency: string;
  opening_balance_minor: string; active: boolean; balance_minor: string;
};

export async function listAccounts(): Promise<AccountRow[]> {
  return rows<AccountRow>(
    `SELECT a.id, a.code, a.name, a.type, a.currency, a.opening_balance_minor::text, a.active,
            (a.opening_balance_minor
              + coalesce(sum(CASE WHEN l.direction = 'CREDIT' THEN l.amount_minor ELSE -l.amount_minor END), 0))::text
              AS balance_minor
       FROM cash_accounts a LEFT JOIN ledger_entries l ON l.account_id = a.id
      GROUP BY a.id ORDER BY a.code`,
  );
}

export async function createAccount(actor: Actor, input: {code: string; name: string; type: string; openingBalanceMinor?: number; currency?: string}) {
  assertCapability(actor, 'cash.account.manage');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const code = text(input.code, 'code', {max: 20}).toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new DomainError('INVALID_CODE');
  const type = input.type;
  if (!['CASH', 'BANK', 'MOBILE', 'OTHER'].includes(type)) throw new DomainError('INVALID_ACCOUNT_TYPE');
  const id = stableId('acc', [code]);
  return tx(async (client) => {
    const created = await client.query(
      `INSERT INTO cash_accounts (id, code, name, type, currency, opening_balance_minor)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO NOTHING RETURNING *`,
      [id, code, text(input.name, 'name', {max: 120}), type,
        (input.currency ?? 'BDT').toUpperCase(), Number(input.openingBalanceMinor ?? 0)],
    );
    if (!created.rowCount) throw new DomainError('ACCOUNT_EXISTS', 409);
    await recordAudit({actor, action: 'ACCOUNT_CREATED', entity: 'account', entityId: id, detail: {code}}, client);
    return created.rows[0];
  });
}

// ── instructions (employee payments) ───────────────────────────────────────
export type InstructionInput = {
  employeeMobile?: string | null;
  employeeName: string;
  payoutMobile?: string | null;
  method: string;
  amountMinor: number;
  purpose?: string | null;
  accountId?: string | null;
  // WhatsApp source provenance (optional; web UI omits these).
  sourceChannel?: 'WEB' | 'WHATSAPP' | 'IMPORT' | null;
  sourceMessageId?: string | null;
  sourceBlockKey?: string | null;
  sourceHash?: string | null;
  // Cash review-candidate provenance (stored on cash_submissions, not on the
  // instruction itself; the instruction is only created after approval).
  sourceChatJid?: string | null;
  sourceAccountId?: string | null;
  category?: string | null;
};

/**
 * Insert one instruction on the caller's transaction. The partial unique index
 * `cash_instructions_source_identity` is the concurrency guard: a replay or a
 * concurrent worker loses the insert race and gets no row.
 */
async function insertInstruction(client: Tx, actor: Actor, input: InstructionInput) {
  if (!['bkash', 'nagad', 'rocket', 'bank', 'cash'].includes(input.method)) throw new DomainError('INVALID_METHOD');
  const amountMinor = moneyMinor(input.amountMinor);
  const employeeMobile = optionalMobile(input.employeeMobile, 'employeeMobile');
  const payoutMobile = optionalMobile(input.payoutMobile, 'payoutMobile');
  const id = newId('ins');
  const created = await client.query(
    `INSERT INTO cash_instructions
       (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose, account_id, state,
        source_channel, source_message_id, source_block_key, source_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REVIEW',$9,$10,$11,$12,$13)
     ON CONFLICT (source_message_id, source_block_key)
       WHERE source_message_id IS NOT NULL
     DO NOTHING
     RETURNING *`,
    [id, employeeMobile, text(input.employeeName, 'employeeName', {max: 150}),
      payoutMobile, input.method, amountMinor,
      optionalText(input.purpose, 'purpose', 500), input.accountId ?? null,
      input.sourceChannel ?? 'WEB',
      input.sourceMessageId ?? null,
      input.sourceBlockKey ?? null,
      input.sourceHash ?? null,
      actor.id],
  );
  return created.rows[0] ?? null;
}

export async function createInstruction(actor: Actor, input: InstructionInput) {
  assertCapability(actor, 'cash.submit');
  return tx(async (client) => {
    const created = await insertInstruction(client, actor, input);
    if (created) {
      await recordAudit({
        actor,
        action: 'INSTRUCTION_CREATED',
        entity: 'instruction',
        entityId: created.id,
        detail: {amountMinor: created.amount_minor, method: created.method, source: created.source_channel},
      }, client);
    }
    return created;
  });
}

export async function listInstructions(filters: {state?: string; q?: string; limit?: number; offset?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const q = (filters.q ?? '').trim().toLowerCase();
  return rows(
    `SELECT i.*, a.code AS account_code,
            r.id AS reversal_id, r.reversed_at AS reversal_at, r.reason AS reversal_reason
       FROM cash_instructions i
       LEFT JOIN cash_accounts a ON a.id = i.account_id
       LEFT JOIN cash_reversals r ON r.instruction_id = i.id
      WHERE ($1::text IS NULL OR i.state = $1)
        AND ($2 = '' OR lower(i.employee_name) LIKE '%' || $2 || '%' OR coalesce(i.employee_mobile,'') LIKE '%' || $2 || '%')
      ORDER BY i.created_at DESC LIMIT $3 OFFSET $4`,
    [filters.state ?? null, q, limit, offset],
  );
}

export async function countInstructions(filters: {state?: string; q?: string} = {}) {
  const q = (filters.q ?? '').trim().toLowerCase();
  const result = await row<{n: number}>(
    `SELECT count(*)::int AS n FROM cash_instructions i
      WHERE ($1::text IS NULL OR i.state = $1)
        AND ($2 = '' OR lower(i.employee_name) LIKE '%' || $2 || '%' OR coalesce(i.employee_mobile,'') LIKE '%' || $2 || '%')`,
    [filters.state ?? null, q],
  );
  return Number(result?.n ?? 0);
}

export async function approveInstruction(actor: Actor, id: string) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  return tx(async (client) => {
    const found = await client.query<{state: string; created_by: string; account_id: string | null}>(
      'SELECT state, created_by, account_id FROM cash_instructions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    const instruction = found.rows[0];
    if (instruction.state !== 'REVIEW') throw new DomainError('INSTRUCTION_NOT_PENDING', 409);
    if (!instruction.account_id) throw new DomainError('ACCOUNT_REQUIRED', 400);
    // Owner policy (2026-11-06): the verified Admin may approve a manual
    // instruction they created when they are the sole participating authorized
    // user. General users never reach this branch because of the role and
    // capability checks above. Posting remains a separate explicit action.
    const selfApproval = instruction.created_by === actor.id;
    await client.query(
      `UPDATE cash_instructions SET state='APPROVED', approved_at=now(), approved_by=$2 WHERE id=$1`,
      [id, actor.id],
    );
    await recordAudit({actor, action: 'INSTRUCTION_APPROVED', entity: 'instruction', entityId: id,
      detail: selfApproval ? {selfApproval: true, role: actor.role} : {selfApproval: false}}, client);
    return {id, state: 'APPROVED'};
  });
}

export async function rejectInstruction(actor: Actor, id: string, reason: string) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const why = text(reason, 'reason', {max: 500});
  return tx(async (client) => {
    const found = await client.query<{state: string; created_by: string; account_id: string | null}>(
      'SELECT state, created_by, account_id FROM cash_instructions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    if (!['REVIEW', 'APPROVED'].includes(found.rows[0].state)) throw new DomainError('INSTRUCTION_NOT_PENDING', 409);
    if (found.rows[0].created_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    await client.query(
      `UPDATE cash_instructions SET state='REJECTED', rejected_at=now(), rejected_by=$2, reject_reason=$3 WHERE id=$1`,
      [id, actor.id, why],
    );
    await recordAudit({actor, action: 'INSTRUCTION_REJECTED', entity: 'instruction', entityId: id, detail: {reason: why}}, client);
    return {id, state: 'REJECTED'};
  });
}

/**
 * Post an approved instruction: the only path that moves money. Creates the
 * immutable posting row plus the ledger debit in one transaction.
 */
export async function postInstruction(actor: Actor, id: string) {
  assertCapability(actor, 'cash.post');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  return tx(async (client) => {
    const found = await client.query<{
      id: string; state: string; amount_minor: string; method: string; account_id: string | null;
      employee_name: string; employee_mobile: string | null;
    }>('SELECT * FROM cash_instructions WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    const instruction = found.rows[0];
    if (instruction.state !== 'APPROVED') throw new DomainError('INSTRUCTION_NOT_APPROVED', 409);
    if (!instruction.account_id) throw new DomainError('ACCOUNT_REQUIRED', 400);
    const postingId = stableId('pos', ['posting', id]);
    const entry = await client.query<{id: string}>(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, instruction_id, created_by)
       VALUES ($1, current_date, 'DEBIT', $2, 'PAYROLL', $3, 'INSTRUCTION', $4, $5)
       RETURNING id::text`,
      [instruction.account_id, instruction.amount_minor,
        `Payment ${instruction.employee_name}`.slice(0, 500), id, actor.id],
    );
    await client.query(
      `INSERT INTO cash_postings (id, instruction_id, account_id, amount_minor, method, posted_by, ledger_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [postingId, id, instruction.account_id, instruction.amount_minor, instruction.method, actor.id, entry.rows[0].id],
    );
    await client.query(
      `UPDATE cash_instructions SET state='POSTED', posted_at=now(), posted_by=$2 WHERE id=$1`,
      [id, actor.id],
    );
    await recordAudit({actor, action: 'INSTRUCTION_POSTED', entity: 'instruction', entityId: id,
      detail: {postingId, amountMinor: instruction.amount_minor}}, client);
    return {id, state: 'POSTED', postingId};
  });
}

/**
 * Assign the paying account to a REVIEW instruction. Router-created Cash
 * instructions carry source provenance but not an account; this is the explicit
 * reviewer step that completes the instruction before approval. It never posts
 * or moves money.
 */
export async function setInstructionAccount(actor: Actor, id: string, accountId: string) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const account = text(accountId, 'accountId', {max: 60});
  return tx(async (client) => {
    const found = await client.query<{id: string; state: string; account_id: string | null}>(
      'SELECT id, state, account_id FROM cash_instructions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    if (found.rows[0].state !== 'REVIEW') throw new DomainError('INSTRUCTION_NOT_PENDING', 409);
    const selected = await client.query<{id: string; active: boolean}>(
      'SELECT id, active FROM cash_accounts WHERE id = $1', [account],
    );
    if (!selected.rowCount) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
    if (!selected.rows[0].active) throw new DomainError('ACCOUNT_INACTIVE', 409);
    await client.query(
      'UPDATE cash_instructions SET account_id = $2, updated_at = now() WHERE id = $1', [id, account],
    );
    await recordAudit({actor, action: 'INSTRUCTION_ACCOUNT_ASSIGNED', entity: 'instruction', entityId: id,
      detail: {accountId: account}}, client);
    return {id, state: 'REVIEW', accountId: account};
  });
}

/**
 * Reverse a POSTED instruction. The original posting and ledger entry are never
 * edited: a separate immutable reversal row and a contra CREDIT ledger entry
 * restore the account balance. A second reversal is refused by the unique
 * posting constraint and by the instruction state check.
 */
export async function reversePosting(actor: Actor, id: string, reason: string) {
  assertCapability(actor, 'cash.reverse');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const why = text(reason, 'reason', {max: 500});
  return tx(async (client) => {
    const found = await client.query<{
      id: string; state: string; amount_minor: string; account_id: string | null;
      employee_name: string; reversed_at: string | null;
    }>('SELECT * FROM cash_instructions WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    const instruction = found.rows[0];
    if (instruction.state !== 'POSTED') throw new DomainError('INSTRUCTION_NOT_POSTED', 409);
    if (instruction.reversed_at) throw new DomainError('INSTRUCTION_ALREADY_REVERSED', 409);
    if (!instruction.account_id) throw new DomainError('ACCOUNT_REQUIRED', 400);

    const posting = await client.query<{id: string; account_id: string; amount_minor: string}>(
      'SELECT id, account_id, amount_minor FROM cash_postings WHERE instruction_id = $1', [id],
    );
    if (!posting.rowCount) throw new DomainError('POSTING_NOT_FOUND', 409);
    const reversalId = stableId('rev', ['reversal', id]);
    const entry = await client.query<{id: string}>(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, instruction_id, created_by)
       VALUES ($1, current_date, 'CREDIT', $2, 'REVERSAL', $3, 'REVERSAL', $4, $5)
       RETURNING id::text`,
      [instruction.account_id, instruction.amount_minor,
        `Reversal of payment ${instruction.employee_name}`.slice(0, 500), id, actor.id],
    );
    await client.query(
      `INSERT INTO cash_reversals
         (id, posting_id, instruction_id, account_id, amount_minor, reason, reversed_by, ledger_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [reversalId, posting.rows[0].id, id, instruction.account_id, instruction.amount_minor, why, actor.id, entry.rows[0].id],
    );
    await client.query(
      `UPDATE cash_instructions
          SET state='VOID', reversed_at=now(), reversed_by=$2, reversal_reason=$3
        WHERE id=$1`,
      [id, actor.id, why],
    );
    await recordAudit({actor, action: 'INSTRUCTION_REVERSED', entity: 'instruction', entityId: id,
      detail: {reversalId, amountMinor: instruction.amount_minor, reason: why}}, client);
    return {id, state: 'VOID', reversalId, ledgerEntryId: entry.rows[0].id};
  });
}

/** Full, auditable view of one instruction. Read-only. */
export async function getInstructionDetail(id: string) {
  const instruction = await row(
    `SELECT i.*, a.code AS account_code, a.name AS account_name
       FROM cash_instructions i LEFT JOIN cash_accounts a ON a.id = i.account_id
      WHERE i.id = $1`, [id],
  );
  if (!instruction) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
  const posting = await row('SELECT * FROM cash_postings WHERE instruction_id = $1', [id]);
  const reversal = await row(
    `SELECT r.*, l.entry_date::text AS ledger_date
       FROM cash_reversals r LEFT JOIN ledger_entries l ON l.id = r.ledger_entry_id
      WHERE r.instruction_id = $1`, [id],
  );
  const ledger = await rows(
    `SELECT id::text, entry_date::text AS entry_date, direction, amount_minor::text, category,
            description, source, created_by, created_at
       FROM ledger_entries WHERE instruction_id = $1 ORDER BY id`, [id],
  );
  const audit = await rows(
    `SELECT id::text, at, actor, actor_role, action, detail, source, source_ref
       FROM audit_events WHERE entity = 'instruction' AND entity_id = $1 ORDER BY at, id`, [id],
  );
  const candidates = await rows(
    `SELECT id, state, created_at, decided_at, decided_by, decision_reason
       FROM cash_submissions WHERE instruction_id = $1 ORDER BY created_at`, [id],
  );
  return {instruction, posting, reversal, ledger, audit, candidates};
}

// ── manual ledger (income / expense / transfer) ────────────────────────────
export type LedgerInput = {
  accountId: string;
  entryDate: string;
  direction: 'DEBIT' | 'CREDIT';
  amountMinor: number;
  category: string;
  description?: string | null;
};

export async function createLedgerEntry(actor: Actor, input: LedgerInput) {
  assertCapability(actor, 'cash.ledger');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  if (!['DEBIT', 'CREDIT'].includes(input.direction)) throw new DomainError('INVALID_DIRECTION');
  return tx(async (client) => {
    const account = await client.query<{id: string; active: boolean}>(
      'SELECT id, active FROM cash_accounts WHERE id = $1 FOR UPDATE', [input.accountId],
    );
    if (!account.rowCount) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
    if (!account.rows[0].active) throw new DomainError('ACCOUNT_INACTIVE', 409);
    const created = await client.query(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'MANUAL',$7) RETURNING id::text, *`,
      [input.accountId, isoDate(input.entryDate, 'entryDate'), input.direction,
        moneyMinor(input.amountMinor), text(input.category, 'category', {max: 60}),
        optionalText(input.description, 'description', 500), actor.id],
    );
    await recordAudit({actor, action: 'LEDGER_ENTRY_CREATED', entity: 'ledger', entityId: String(created.rows[0]?.id),
      detail: {direction: input.direction, amountMinor: input.amountMinor}}, client);
    return created.rows[0];
  });
}

export async function listLedger(filters: {accountId?: string; from?: string; to?: string; limit?: number; offset?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  return rows(
    `SELECT l.id::text, l.entry_date::text AS entry_date, l.direction, l.amount_minor::text, l.category, l.description,
            l.source, l.created_by, l.created_at, a.code AS account_code
       FROM ledger_entries l JOIN cash_accounts a ON a.id = l.account_id
      WHERE ($1::text IS NULL OR l.account_id = $1)
        AND ($2::date IS NULL OR l.entry_date >= $2)
        AND ($3::date IS NULL OR l.entry_date <= $3)
      ORDER BY l.entry_date DESC, l.id DESC LIMIT $4 OFFSET $5`,
    [filters.accountId ?? null, filters.from ?? null, filters.to ?? null, limit, offset],
  );
}

export async function countLedger(filters: {accountId?: string; from?: string; to?: string} = {}) {
  const result = await row<{n: number}>(
    `SELECT count(*)::int AS n FROM ledger_entries l
      WHERE ($1::text IS NULL OR l.account_id = $1)
        AND ($2::date IS NULL OR l.entry_date >= $2)
        AND ($3::date IS NULL OR l.entry_date <= $3)`,
    [filters.accountId ?? null, filters.from ?? null, filters.to ?? null],
  );
  return Number(result?.n ?? 0);
}

export async function incomeExpense(from: string, to: string) {
  const rowsOut = await rows<{direction: string; category: string; source: string; total_minor: string}>(
    `SELECT direction, category, source, sum(amount_minor)::text AS total_minor
       FROM ledger_entries WHERE entry_date BETWEEN $1 AND $2
      GROUP BY direction, category, source ORDER BY direction, category, source`,
    [from, to],
  );
  const sum = (predicate: (row: {direction: string; source: string}) => boolean) =>
    rowsOut.filter(predicate).reduce((n, r) => n + Number(r.total_minor), 0);
  // A reversal is a contra-credit against an expense, not new income. Keeping
  // it separate prevents the income and expense cards from overstating both.
  const income = sum((r) => r.direction === 'CREDIT' && r.source !== 'REVERSAL' && r.source !== 'RECONCILIATION');
  const expense = sum((r) => r.direction === 'DEBIT');
  const reversals = sum((r) => r.direction === 'CREDIT' && r.source === 'REVERSAL');
  const reconciliation = sum((r) => r.direction === 'CREDIT' && r.source === 'RECONCILIATION');
  return {
    from, to, income, expense, reversals, reconciliation,
    net: income + reversals + reconciliation - expense,
    breakdown: rowsOut,
    accounts: await listAccounts(),
  };
}

// ── submissions (staff-raised payment requests) ────────────────────────────
export async function submitCash(actor: Actor, payload: InstructionInput) {
  assertCapability(actor, 'cash.submit');
  const canonical = JSON.stringify({
    employeeName: payload.employeeName, employeeMobile: payload.employeeMobile ?? null,
    payoutMobile: payload.payoutMobile ?? null, method: payload.method,
    amountMinor: payload.amountMinor, purpose: payload.purpose ?? null,
    accountId: payload.accountId ?? null,
    sourceBlockKey: payload.sourceBlockKey ?? null,
    sourceHash: payload.sourceHash ?? null,
  });
  return tx(async (client) => {
    const existing = await client.query<{id: string; state: string}>(
      'SELECT id, state FROM cash_submissions WHERE payload_hash = $1', [stableId('h', [canonical])],
    );
    if (existing.rowCount) {
      return {id: existing.rows[0].id, duplicate: true, state: existing.rows[0].state};
    }
    const id = newId('sub');
    const created = await client.query<{id: string}>(
      `INSERT INTO cash_submissions
         (id, payload, payload_hash, submitted_by, state,
          source_message_id, source_chat_jid, source_account_id, category)
       VALUES ($1,$2::jsonb,$3,$4,'PENDING_REVIEW',$5,$6,$7,$8) RETURNING id`,
      [id, canonical, stableId('h', [canonical]), actor.id,
        payload.sourceMessageId ?? null, payload.sourceChatJid ?? null,
        payload.sourceAccountId ?? null, payload.category ?? null],
    );
    await recordAudit({actor, action: 'CASH_SUBMITTED', entity: 'cash_submission', entityId: id}, client);
    return {id: created.rows[0]?.id, duplicate: false, state: 'PENDING_REVIEW'};
  });
}

/**
 * Review a cash candidate. APPROVED atomically creates a linked instruction in
 * REVIEW state; it never posts, approves or settles funds by itself. The
 * instruction then follows the normal REVIEW → APPROVED → POSTED path.
 */
export async function decideCashSubmission(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const why = optionalText(reason, 'reason', 500);
  return tx(async (client) => {
    const found = await client.query<{
      id: string; submitted_by: string; state: string; payload: InstructionInput;
      source_message_id: string | null; source_chat_jid: string | null; source_account_id: string | null;
      category: string | null;
    }>('SELECT * FROM cash_submissions WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('SUBMISSION_NOT_FOUND', 404);
    const submission = found.rows[0];
    if (submission.state !== 'PENDING_REVIEW') throw new DomainError('SUBMISSION_NOT_PENDING', 409);
    if (submission.submitted_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);

    let instructionId: string | null = null;
    if (decision === 'APPROVED') {
      const payload = (submission.payload ?? {}) as Record<string, unknown>;
      const payloadFields = (payload.fields && typeof payload.fields === 'object')
        ? payload.fields as Record<string, unknown>
        : {};
      const field = (key: string) => payload[key] ?? payloadFields[key];
      // Attribute the instruction to the candidate's originator, not to the
      // reviewer. Otherwise a sole human Admin would be blocked by the
      // self-review rule immediately after approving the candidate.
      const originator = {...actor, id: submission.submitted_by, displayName: undefined};
      const instruction = await insertInstruction(client, originator, {
        employeeName: String(field('employeeName') ?? 'Unknown'),
        employeeMobile: (field('employeeMobile') as string | null | undefined) ?? null,
        payoutMobile: (field('payoutMobile') as string | null | undefined) ?? null,
        method: String(field('method') ?? 'cash'),
        amountMinor: Number(field('amountMinor')),
        purpose: (field('purpose') as string | null | undefined) ?? null,
        accountId: (field('accountId') as string | null | undefined) ?? null,
        sourceChannel: submission.source_message_id ? 'WHATSAPP' : 'WEB',
        sourceMessageId: submission.source_message_id ?? (payload.sourceMessageId as string | null | undefined) ?? null,
        sourceBlockKey: (payload.sourceBlockKey as string | null | undefined)
          ?? (payload.blockKey as string | null | undefined)
          ?? (payloadFields.blockKey as string | null | undefined)
          ?? null,
        sourceHash: (payload.sourceHash as string | null | undefined) ?? null,
        sourceChatJid: submission.source_chat_jid,
        sourceAccountId: submission.source_account_id,
        category: submission.category,
      });
      if (!instruction) throw new DomainError('INSTRUCTION_ALREADY_EXISTS', 409);
      instructionId = instruction.id;
      await recordAudit({actor, action: 'INSTRUCTION_CREATED_FROM_CANDIDATE', entity: 'instruction',
        entityId: instruction.id, detail: {submissionId: id}}, client);
      await client.query(
        `UPDATE cash_submissions
            SET state='APPROVED', instruction_id=$2, decided_at=now(), decided_by=$3, decision_reason=$4,
                updated_at=now()
          WHERE id=$1`,
        [id, instructionId, actor.id, why],
      );
    } else {
      await client.query(
        `UPDATE cash_submissions
            SET state='REJECTED', decided_at=now(), decided_by=$2, decision_reason=$3, updated_at=now()
          WHERE id=$1`,
        [id, actor.id, why],
      );
    }
    await client.query(
      `INSERT INTO cash_submission_reviews (id, submission_id, decision, reason, reviewer)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId('csr'), id, decision, why, actor.id],
    );
    await recordAudit({actor, action: `CASH_SUBMISSION_${decision}`, entity: 'cash_submission', entityId: id,
      detail: {instructionId, reason: why}}, client);
    return {id, state: decision, instructionId, instructionState: instructionId ? 'REVIEW' : null};
  });
}

// ── reconciliation ─────────────────────────────────────────────────────────
export type ReconciliationInput = {
  accountId: string;
  periodStart: string;
  periodEnd: string;
  countedBalanceMinor: number;
  note?: string | null;
};

function safeInteger(value: unknown, field: string): number {
  const raw = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isSafeInteger(raw)) throw new DomainError(`INVALID_${field.toUpperCase()}`);
  return raw;
}

export async function createReconciliation(actor: Actor, input: ReconciliationInput) {
  assertCapability(actor, 'cash.reconcile');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const start = isoDate(input.periodStart, 'periodStart');
  const end = isoDate(input.periodEnd, 'periodEnd');
  if (end < start) throw new DomainError('INVALID_PERIOD');
  const counted = safeInteger(input.countedBalanceMinor, 'countedBalanceMinor');
  return tx(async (client) => {
    const account = await client.query<{id: string; opening_balance_minor: string; active: boolean}>(
      'SELECT id, opening_balance_minor, active FROM cash_accounts WHERE id = $1', [input.accountId],
    );
    if (!account.rowCount) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
    if (!account.rows[0].active) throw new DomainError('ACCOUNT_INACTIVE', 409);

    const before = await client.query<{total: string}>(
      `SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0)::text AS total
         FROM ledger_entries WHERE account_id = $1 AND entry_date < $2`,
      [input.accountId, start],
    );
    const period = await client.query<{total: string}>(
      `SELECT coalesce(sum(CASE WHEN direction='CREDIT' THEN amount_minor ELSE -amount_minor END),0)::text AS total
         FROM ledger_entries WHERE account_id = $1 AND entry_date BETWEEN $2 AND $3`,
      [input.accountId, start, end],
    );
    const opening = Number(account.rows[0].opening_balance_minor) + Number(before.rows[0]?.total ?? 0);
    const movement = Number(period.rows[0]?.total ?? 0);
    const expected = opening + movement;
    const variance = counted - expected;
    const id = newId('rec');
    await client.query(
      `INSERT INTO cash_reconciliations
         (id, account_id, period_start, period_end, opening_balance_minor, movement_minor,
          expected_balance_minor, counted_balance_minor, variance_minor, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, input.accountId, start, end, opening, movement, expected, counted, variance,
        optionalText(input.note, 'note', 1000), actor.id],
    );
    await recordAudit({actor, action: 'RECONCILIATION_CREATED', entity: 'reconciliation', entityId: id,
      detail: {accountId: input.accountId, periodStart: start, periodEnd: end,
        expected, counted, variance}}, client);
    return {id, state: 'OPEN', opening, movement, expected, counted, variance};
  });
}

export async function closeReconciliation(actor: Actor, id: string, note?: string | null) {
  assertCapability(actor, 'cash.reconcile');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  return tx(async (client) => {
    const found = await client.query<{id: string; state: string; variance_minor: string; note: string | null}>(
      'SELECT id, state, variance_minor, note FROM cash_reconciliations WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('RECONCILIATION_NOT_FOUND', 404);
    if (found.rows[0].state !== 'OPEN') throw new DomainError('RECONCILIATION_ALREADY_CLOSED', 409);
    const supplied = optionalText(note, 'note', 1000) ?? found.rows[0].note;
    if (Number(found.rows[0].variance_minor) !== 0 && (!supplied || supplied.trim().length < 5)) {
      throw new DomainError('RECONCILIATION_NOTE_REQUIRED', 400);
    }
    await client.query(
      `UPDATE cash_reconciliations
          SET state='CLOSED', note=coalesce($2, note), closed_by=$3, closed_at=now()
        WHERE id=$1`,
      [id, supplied, actor.id],
    );
    await recordAudit({actor, action: 'RECONCILIATION_CLOSED', entity: 'reconciliation', entityId: id,
      detail: {varianceMinor: Number(found.rows[0].variance_minor), note: supplied}}, client);
    return {id, state: 'CLOSED'};
  });
}

export async function listReconciliations(limit = 50) {
  const bounded = Math.min(Math.max(Number(limit) || 50, 1), 200);
  return rows(
    `SELECT r.*, a.code AS account_code, a.name AS account_name
       FROM cash_reconciliations r JOIN cash_accounts a ON a.id = r.account_id
      ORDER BY r.period_end DESC, r.created_at DESC LIMIT $1`, [bounded],
  );
}
