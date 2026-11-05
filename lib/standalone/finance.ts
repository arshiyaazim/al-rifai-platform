import {rows, row, tx, text, optionalText, optionalMobile, isoDate, moneyMinor, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId, newId} from './audit.ts';

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
  const code = text(input.code, 'code', {max: 20}).toUpperCase();
  if (!/^[A-Z0-9_]{2,20}$/.test(code)) throw new DomainError('INVALID_CODE');
  const type = input.type;
  if (!['CASH', 'BANK', 'MOBILE', 'OTHER'].includes(type)) throw new DomainError('INVALID_ACCOUNT_TYPE');
  const id = stableId('acc', [code]);
  const created = await row(
    `INSERT INTO cash_accounts (id, code, name, type, currency, opening_balance_minor)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (code) DO NOTHING RETURNING *`,
    [id, code, text(input.name, 'name', {max: 120}), type,
      (input.currency ?? 'BDT').toUpperCase(), Number(input.openingBalanceMinor ?? 0)],
  );
  if (!created) throw new DomainError('ACCOUNT_EXISTS', 409);
  await recordAudit({actor, action: 'ACCOUNT_CREATED', entity: 'account', entityId: id, detail: {code}});
  return created;
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
};

export async function createInstruction(actor: Actor, input: InstructionInput) {
  if (!['bkash', 'nagad', 'rocket', 'bank', 'cash'].includes(input.method)) throw new DomainError('INVALID_METHOD');
  const amountMinor = moneyMinor(input.amountMinor);
  const employeeMobile = optionalMobile(input.employeeMobile, 'employeeMobile');
  const payoutMobile = optionalMobile(input.payoutMobile, 'payoutMobile');
  const id = newId('ins');
  const created = await row(
    `INSERT INTO cash_instructions
       (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose, account_id, state,
        source_channel, source_message_id, source_block_key, source_hash, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'REVIEW',$9,$10,$11,$12,$13) RETURNING *`,
    [id, employeeMobile, text(input.employeeName, 'employeeName', {max: 150}),
      payoutMobile, input.method, amountMinor,
      optionalText(input.purpose, 'purpose', 500), input.accountId ?? null,
      input.sourceChannel ?? 'WEB',
      input.sourceMessageId ?? null,
      input.sourceBlockKey ?? null,
      input.sourceHash ?? null,
      actor.id],
  );
  await recordAudit({actor, action: 'INSTRUCTION_CREATED', entity: 'instruction', entityId: id,
    detail: {amountMinor, method: input.method, source: input.sourceChannel ?? 'WEB'}});
  return created;
}

export async function listInstructions(filters: {state?: string; q?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  const q = (filters.q ?? '').trim().toLowerCase();
  return rows(
    `SELECT i.*, a.code AS account_code
       FROM cash_instructions i LEFT JOIN cash_accounts a ON a.id = i.account_id
      WHERE ($1::text IS NULL OR i.state = $1)
        AND ($2 = '' OR lower(i.employee_name) LIKE '%' || $2 || '%' OR coalesce(i.employee_mobile,'') LIKE '%' || $2 || '%')
      ORDER BY i.created_at DESC LIMIT $3`,
    [filters.state ?? null, q, limit],
  );
}

export async function approveInstruction(actor: Actor, id: string) {
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  return tx(async (client) => {
    const found = await client.query<{state: string; created_by: string}>(
      'SELECT state, created_by FROM cash_instructions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    const instruction = found.rows[0];
    if (instruction.state !== 'REVIEW') throw new DomainError('INSTRUCTION_NOT_PENDING', 409);
    if (instruction.created_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    await client.query(
      `UPDATE cash_instructions SET state='APPROVED', approved_at=now(), approved_by=$2 WHERE id=$1`,
      [id, actor.id],
    );
    await recordAudit({actor, action: 'INSTRUCTION_APPROVED', entity: 'instruction', entityId: id});
    return {id, state: 'APPROVED'};
  });
}

export async function rejectInstruction(actor: Actor, id: string, reason: string) {
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const why = text(reason, 'reason', {max: 500});
  return tx(async (client) => {
    const found = await client.query<{state: string; created_by: string}>(
      'SELECT state, created_by FROM cash_instructions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('INSTRUCTION_NOT_FOUND', 404);
    if (!['REVIEW', 'APPROVED'].includes(found.rows[0].state)) throw new DomainError('INSTRUCTION_NOT_PENDING', 409);
    if (found.rows[0].created_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    await client.query(
      `UPDATE cash_instructions SET state='REJECTED', rejected_at=now(), rejected_by=$2, reject_reason=$3 WHERE id=$1`,
      [id, actor.id, why],
    );
    await recordAudit({actor, action: 'INSTRUCTION_REJECTED', entity: 'instruction', entityId: id, detail: {reason: why}});
    return {id, state: 'REJECTED'};
  });
}

/**
 * Post an approved instruction: the only path that moves money. Creates the
 * immutable posting row plus the ledger debit in one transaction.
 */
export async function postInstruction(actor: Actor, id: string) {
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
      detail: {postingId, amountMinor: instruction.amount_minor}});
    return {id, state: 'POSTED', postingId};
  });
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
  if (!['DEBIT', 'CREDIT'].includes(input.direction)) throw new DomainError('INVALID_DIRECTION');
  const account = await row('SELECT id, active FROM cash_accounts WHERE id = $1', [input.accountId]);
  if (!account) throw new DomainError('ACCOUNT_NOT_FOUND', 404);
  if (!account.active) throw new DomainError('ACCOUNT_INACTIVE', 409);
  const created = await row(
    `INSERT INTO ledger_entries
       (account_id, entry_date, direction, amount_minor, category, description, source, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'MANUAL',$7) RETURNING id::text, *`,
    [input.accountId, isoDate(input.entryDate, 'entryDate'), input.direction,
      moneyMinor(input.amountMinor), text(input.category, 'category', {max: 60}),
      optionalText(input.description, 'description', 500), actor.id],
  );
  await recordAudit({actor, action: 'LEDGER_ENTRY_CREATED', entity: 'ledger', entityId: String(created?.id),
    detail: {direction: input.direction, amountMinor: input.amountMinor}});
  return created;
}

export async function listLedger(filters: {accountId?: string; from?: string; to?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 500);
  return rows(
    `SELECT l.id::text, l.entry_date::text AS entry_date, l.direction, l.amount_minor::text, l.category, l.description,
            l.source, l.created_by, l.created_at, a.code AS account_code
       FROM ledger_entries l JOIN cash_accounts a ON a.id = l.account_id
      WHERE ($1::text IS NULL OR l.account_id = $1)
        AND ($2::date IS NULL OR l.entry_date >= $2)
        AND ($3::date IS NULL OR l.entry_date <= $3)
      ORDER BY l.entry_date DESC, l.id DESC LIMIT $4`,
    [filters.accountId ?? null, filters.from ?? null, filters.to ?? null, limit],
  );
}

export async function incomeExpense(from: string, to: string) {
  const rowsOut = await rows<{direction: string; category: string; total_minor: string}>(
    `SELECT direction, category, sum(amount_minor)::text AS total_minor
       FROM ledger_entries WHERE entry_date BETWEEN $1 AND $2
      GROUP BY direction, category ORDER BY direction, category`,
    [from, to],
  );
  const income = rowsOut.filter((r) => r.direction === 'CREDIT').reduce((n, r) => n + Number(r.total_minor), 0);
  const expense = rowsOut.filter((r) => r.direction === 'DEBIT').reduce((n, r) => n + Number(r.total_minor), 0);
  return {from, to, income, expense, net: income - expense, breakdown: rowsOut, accounts: await listAccounts()};
}

// ── submissions (staff-raised payment requests) ────────────────────────────
export async function submitCash(actor: Actor, payload: InstructionInput) {
  const canonical = JSON.stringify({
    employeeName: payload.employeeName, employeeMobile: payload.employeeMobile ?? null,
    payoutMobile: payload.payoutMobile ?? null, method: payload.method,
    amountMinor: payload.amountMinor, purpose: payload.purpose ?? null,
  });
  const existing = await row<{id: string}>('SELECT id FROM cash_submissions WHERE payload_hash = $1', [
    stableId('h', [canonical]),
  ]);
  if (existing) return {id: existing.id, duplicate: true, state: 'PENDING_REVIEW'};
  const id = newId('sub');
  const created = await row<{id: string}>(
    `INSERT INTO cash_submissions (id, payload, payload_hash, submitted_by, state)
     VALUES ($1,$2::jsonb,$3,$4,'PENDING_REVIEW') RETURNING id`,
    [id, canonical, stableId('h', [canonical]), actor.id],
  );
  await recordAudit({actor, action: 'CASH_SUBMITTED', entity: 'cash_submission', entityId: id});
  return {id: created?.id, duplicate: false, state: 'PENDING_REVIEW'};
}

export async function decideCashSubmission(actor: Actor, id: string, decision: 'APPROVED' | 'REJECTED', reason?: string) {
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  return tx(async (client) => {
    const found = await client.query<{id: string; submitted_by: string; state: string}>(
      'SELECT id, submitted_by, state FROM cash_submissions WHERE id = $1 FOR UPDATE', [id],
    );
    if (!found.rowCount) throw new DomainError('SUBMISSION_NOT_FOUND', 404);
    if (found.rows[0].state !== 'PENDING_REVIEW') throw new DomainError('SUBMISSION_NOT_PENDING', 409);
    if (found.rows[0].submitted_by === actor.id) throw new DomainError('REVIEWER_IS_SUBMITTER', 403);
    await client.query('UPDATE cash_submissions SET state = $2 WHERE id = $1', [id, decision]);
    await client.query(
      `INSERT INTO cash_submission_reviews (id, submission_id, decision, reason, reviewer)
       VALUES ($1,$2,$3,$4,$5)`,
      [newId('csr'), id, decision, optionalText(reason, 'reason', 500), actor.id],
    );
    await recordAudit({actor, action: `CASH_SUBMISSION_${decision}`, entity: 'cash_submission', entityId: id});
    return {id, state: decision};
  });
}
