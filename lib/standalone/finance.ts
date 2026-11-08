import type {PoolClient} from 'pg';
import {rows, row, tx, text, optionalText, optionalMobile, mobile, isoDate, moneyMinor, DomainError, type Actor} from './db.ts';
import {recordAudit, stableId, newId} from './audit.ts';
import {assertCapability} from './authz.ts';
import {cleanEmployeeName} from '../display-name.ts';

type Tx = Pick<PoolClient, 'query'>;

const PAYMENT_METHODS = ['bkash', 'nagad', 'rocket', 'bank', 'cash'] as const;
type PaymentMethod = typeof PAYMENT_METHODS[number];

/** Business Paid Events are opt-in and default disabled. */
export function paidEventsEnabled(): boolean {
  return process.env.PHASE3_PAID_EVENTS_ENABLED === '1';
}

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
  if (!PAYMENT_METHODS.includes(input.method as PaymentMethod)) throw new DomainError('INVALID_METHOD');
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

/**
 * Append one Business Paid Event. This is the only business-layer writer and
 * it is called inside the caller's transaction. It never touches cash_postings
 * or ledger_entries.
 */
type BusinessPaidEventInput = {
  instructionId: string | null;
  sourceSubmissionId?: string | null;
  employeeMobile: string;
  payoutMobile: string;
  employeeName: string;
  amountMinor: number | string;
  method: string;
  sourceCategory: 'WHATSAPP' | 'OFFICE';
  sourceMessageId?: string | null;
  sourceBlockKey?: string | null;
  paidAt?: string | null;
  createdBy: string;
};

export async function insertBusinessPaidEvent(client: Tx, input: BusinessPaidEventInput): Promise<string | null> {
  const employeeMobile = mobile(input.employeeMobile, 'employeeMobile');
  const payoutMobile = mobile(input.payoutMobile, 'payoutMobile');
  const employeeName = text(input.employeeName, 'employeeName', {max: 150});
  const amountMinor = moneyMinor(input.amountMinor, 'amountMinor');
  if (!PAYMENT_METHODS.includes(input.method as PaymentMethod)) throw new DomainError('INVALID_METHOD');
  if (!['WHATSAPP', 'OFFICE'].includes(input.sourceCategory)) throw new DomainError('INVALID_SOURCE_CATEGORY');
  if (input.sourceCategory === 'WHATSAPP') {
    if (!input.sourceMessageId || !input.sourceBlockKey) {
      throw new DomainError('PAID_EVENT_WHATSAPP_PROVENANCE_REQUIRED', 409);
    }
  } else if (!input.sourceSubmissionId) {
    throw new DomainError('PAID_EVENT_OFFICE_SUBMISSION_REQUIRED', 409);
  }
  const registered = await client.query(
    'SELECT 1 FROM employees WHERE employee_mobile = $1', [employeeMobile],
  );
  const id = newId('pe');
  const created = await client.query<{id: string}>(
    `INSERT INTO cash_payment_events
       (id, event_type, instruction_id, source_submission_id, employee_mobile, payout_mobile,
        employee_name, employee_link_status, amount_minor, method, source_category,
        source_message_id, source_block_key, status, paid_at, created_by)
     VALUES ($1,'PAYMENT',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'PAID',$13,$14)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [id, input.instructionId, input.sourceSubmissionId ?? null, employeeMobile, payoutMobile,
      employeeName, registered.rowCount ? 'REGISTERED' : 'UNREGISTERED',
      amountMinor, input.method, input.sourceCategory,
      input.sourceMessageId ?? null, input.sourceBlockKey ?? null,
      input.paidAt ?? new Date().toISOString(), input.createdBy],
  );
  return created.rows[0]?.id ?? null;
}

export async function createInstruction(actor: Actor, input: InstructionInput, options: {
  /** True only after the WA-01 Admin -> Accountant eligibility checks passed. */
  whatsAppVerified?: boolean;
  /** Business payment timestamp (message source time), never a posting time. */
  paidAt?: string | null;
} = {}) {
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
      if (options.whatsAppVerified && paidEventsEnabled()) {
        if (!created.employee_mobile || !created.payout_mobile) {
          // A WhatsApp payment without both identities is not a verified
          // single-mobile payment; never invent a payout destination.
          throw new DomainError('PAID_EVENT_IDENTITY_UNRESOLVED', 409);
        }
        const paidEventId = await insertBusinessPaidEvent(client, {
          instructionId: created.id,
          employeeMobile: created.employee_mobile,
          payoutMobile: created.payout_mobile,
          employeeName: created.employee_name,
          amountMinor: created.amount_minor,
          method: created.method,
          sourceCategory: 'WHATSAPP',
          sourceMessageId: created.source_message_id,
          sourceBlockKey: created.source_block_key,
          paidAt: options.paidAt ?? null,
          createdBy: actor.id,
        });
        if (paidEventId) {
          await recordAudit({actor, action: 'CASH_PAYMENT_EVENT_CREATED', entity: 'cash_payment_events',
            entityId: paidEventId, detail: {instructionId: created.id, sourceCategory: 'WHATSAPP',
              sourceMessageId: created.source_message_id, sourceBlockKey: created.source_block_key}}, client);
        }
      }
    }
    return created;
  });
}

/**
 * Correct a POSTED transaction without touching the original posting.
 *
 * A new append-only `cash_transaction_adjustments` row records the corrected
 * amount and the signed difference; the original instruction, posting and
 * ledger entry remain untouched. A contra ledger entry records the difference.
 * The effective displayed amount is original + sum(adjustments).
 */
export async function correctCashTransaction(
  actor: Actor,
  id: string,
  input: {correctedAmount: number | string; reason: string},
) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 10 || reason.length > 500) throw new DomainError('REASON_INVALID', 400);
  const correctedAmount = Number(input.correctedAmount);
  if (!Number.isSafeInteger(correctedAmount) || correctedAmount <= 0) throw new DomainError('INVALID_AMOUNT', 400);
  const adjustmentId = newId('adj');
  await tx(async (client) => {
    const found = await client.query<{
      id: string; state: string; amount_minor: string; account_id: string | null; employee_name: string;
    }>('SELECT id, state, amount_minor, account_id, employee_name FROM cash_instructions WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('CASH_TRANSACTION_NOT_FOUND', 404);
    const original = found.rows[0];
    if (original.state !== 'POSTED') throw new DomainError('CORRECTION_REQUIRES_POSTED', 409);
    if (!original.account_id) throw new DomainError('ACCOUNT_REQUIRED', 400);
    const posting = await client.query<{id: string}>('SELECT id FROM cash_postings WHERE instruction_id=$1', [id]);
    if (!posting.rowCount) throw new DomainError('POSTING_NOT_FOUND', 409);
    const adjustmentMinor = correctedAmount - Number(original.amount_minor);
    if (adjustmentMinor === 0) throw new DomainError('CORRECTION_NO_CHANGE', 409);
    await client.query(
      `INSERT INTO cash_transaction_adjustments
         (id, instruction_id, correction_of, posting_id, adjustment_type, amount_minor,
          adjustment_minor, reason, state, created_by)
       VALUES ($1,$2,$2,$3,'CORRECTION',$4,$5,$6,'CORRECTION',$7)`,
      [adjustmentId, id, posting.rows[0].id, correctedAmount, adjustmentMinor, reason, actor.id],
    );
    const magnitude = Math.abs(adjustmentMinor);
    await client.query(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, instruction_id, created_by)
       VALUES ($1, current_date, $2, $3, 'CORRECTION', $4, 'INSTRUCTION', $5, $6)`,
      [original.account_id, adjustmentMinor > 0 ? 'DEBIT' : 'CREDIT', magnitude,
        `Correction of ${original.employee_name}`.slice(0, 500), id, actor.id],
    );
    await recordAudit({
      actor, action: 'CASH:CORRECTION', entity: 'cash_instruction', entityId: id,
      detail: {before: {amountMinor: original.amount_minor, state: original.state},
        after: {correctedAmountMinor: correctedAmount, adjustmentMinor, adjustmentId}, reason},
      source: 'WEB', sourceRef: id,
    }, client);
  });
  return getCashTransaction(id);
}

/**
 * Reverse a POSTED transaction by marking the original REVERSED and creating a
 * new POSTED replacement. The original posting/ledger entry stays immutable;
 * a contra CREDIT restores its balance and the replacement gets a new DEBIT.
 */
export async function reverseCashTransaction(
  actor: Actor,
  id: string,
  input: {amount: number | string; method?: string; notes?: string | null; reason: string},
) {
  assertCapability(actor, 'cash.reverse');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  const reason = String(input.reason ?? '').trim();
  if (reason.length < 10 || reason.length > 500) throw new DomainError('REASON_INVALID', 400);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError('INVALID_AMOUNT', 400);
  const replacementId = newId('ins');
  const replacementPostingId = newId('pos');
  await tx(async (client) => {
    const found = await client.query<{
      id: string; state: string; amount_minor: string; method: string; account_id: string | null;
      employee_mobile: string | null; employee_name: string; payout_mobile: string | null;
      purpose: string | null;
    }>('SELECT * FROM cash_instructions WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('CASH_TRANSACTION_NOT_FOUND', 404);
    const original = found.rows[0];
    if (original.state !== 'POSTED') throw new DomainError('REVERSAL_REQUIRES_POSTED', 409);
    if (!original.account_id) throw new DomainError('ACCOUNT_REQUIRED', 400);
    const posting = await client.query<{id: string}>('SELECT id FROM cash_postings WHERE instruction_id=$1', [id]);
    if (!posting.rowCount) throw new DomainError('POSTING_NOT_FOUND', 409);
    const method = PAYMENT_METHODS.includes(String(input.method) as PaymentMethod)
      ? String(input.method) : original.method;
    const notes = input.notes === undefined ? original.purpose : (String(input.notes ?? '').trim() || null);
    // Reverse the original posting with a contra ledger entry.
    const contra = await client.query<{id: string}>(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, instruction_id, created_by)
       VALUES ($1, current_date, 'CREDIT', $2, 'REVERSAL', $3, 'REVERSAL', $4, $5) RETURNING id::text`,
      [original.account_id, original.amount_minor,
        `Reversal of ${original.employee_name}`.slice(0, 500), id, actor.id],
    );
    await client.query(
      `INSERT INTO cash_reversals
         (id, posting_id, instruction_id, account_id, amount_minor, reason, reversed_by, ledger_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [newId('rev'), posting.rows[0].id, id, original.account_id, original.amount_minor, reason, actor.id, contra.rows[0].id],
    );
    await client.query(
      `UPDATE cash_instructions
          SET state='REVERSED', reversed_at=now(), reversed_by=$2, reversal_reason=$3
        WHERE id=$1`,
      [id, actor.id, reason],
    );
    // New POSTED replacement instruction.
    await client.query(
      `INSERT INTO cash_instructions
         (id, employee_mobile, employee_name, payout_mobile, method, amount_minor, purpose,
          account_id, state, source_channel, posted_at, posted_by, created_by, reversal_of)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'POSTED','WEB',now(),$9,$9,$10)`,
      [replacementId, original.employee_mobile, original.employee_name, original.payout_mobile,
        method, amount, notes, original.account_id, actor.id, id],
    );
    const debit = await client.query<{id: string}>(
      `INSERT INTO ledger_entries
         (account_id, entry_date, direction, amount_minor, category, description, source, instruction_id, created_by)
       VALUES ($1, current_date, 'DEBIT', $2, 'PAYROLL', $3, 'INSTRUCTION', $4, $5) RETURNING id::text`,
      [original.account_id, amount, `Reversal re-post ${original.employee_name}`.slice(0, 500), replacementId, actor.id],
    );
    await client.query(
      `INSERT INTO cash_postings
         (id, instruction_id, account_id, amount_minor, method, posted_by, ledger_entry_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [replacementPostingId, replacementId, original.account_id, amount, method, actor.id, debit.rows[0].id],
    );
    await recordAudit({
      actor, action: 'CASH:REVERSAL', entity: 'cash_instruction', entityId: id,
      detail: {before: {id, amountMinor: original.amount_minor, method: original.method, state: original.state},
        after: {id: replacementId, amountMinor: amount, method, state: 'POSTED'}, reason},
      source: 'WEB', sourceRef: id,
    }, client);
  });
  return {original: await getCashTransaction(id), replacement: await getCashTransaction(replacementId)};
}

export async function getCashTransaction(id: string): Promise<CashTransactionRow | null> {
  const items = await rows<CashTransactionRow>(
    `WITH adjustments AS (
       SELECT correction_of,
              sum(adjustment_minor) AS adjustment_minor,
              count(*)::int AS correction_count,
              max(id) AS last_correction_id
         FROM cash_transaction_adjustments
        GROUP BY correction_of
     ), adjusted AS (
       SELECT i.*,
              coalesce(a.adjustment_minor, 0) AS adjustment_minor,
              i.amount_minor + coalesce(a.adjustment_minor, 0) AS effective_amount_minor,
              coalesce(a.correction_count, 0) AS correction_count,
              a.last_correction_id
         FROM cash_instructions i
         LEFT JOIN adjustments a ON a.correction_of = i.id
     ), ordered AS (
       SELECT i.*,
              row_number() OVER (
                PARTITION BY coalesce(i.employee_mobile, lower(i.employee_name))
                ORDER BY i.created_at, i.id
              )::text AS payout_number,
              sum(CASE WHEN i.state = 'REVERSED' THEN 0 ELSE i.effective_amount_minor END) OVER (
                PARTITION BY coalesce(i.employee_mobile, lower(i.employee_name))
                ORDER BY i.created_at, i.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )::text AS total_paid_minor
         FROM adjusted i
     )
     SELECT i.id, coalesce(i.employee_mobile, e.employee_mobile) AS employee_id,
            coalesce(e.preferred_name, i.employee_name) AS name_of_employee,
            e.designation, e.joined_on::text AS date_of_join, i.payout_number,
            i.effective_amount_minor::text AS amount_minor,
            i.amount_minor::text AS original_amount_minor,
            i.adjustment_minor::text AS adjustment_minor,
            i.total_paid_minor, i.correction_count, i.last_correction_id, i.reversal_of,
            i.method, i.state, i.created_at::text AS created_at,
            i.source_channel, i.source_message_id, i.purpose AS notes
       FROM ordered i LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
      WHERE i.id = $1`,
    [id],
  );
  const found = items[0];
  return found ? {...found, name_of_employee: cleanEmployeeName(found.name_of_employee)} : null;
}

/** One employee's Cash summary for the history page header. */
export async function getCashEmployeeSummary(employeeId: string) {
  const mobile = normalizedMobile(employeeId) ?? employeeId;
  const summary = await row<{
    employee_mobile: string | null; name_of_employee: string; designation: string | null;
    date_of_join: string | null; total_payouts: number; total_paid_minor: string;
  }>(
    `SELECT coalesce(i.employee_mobile, e.employee_mobile) AS employee_mobile,
            coalesce(e.preferred_name, max(i.employee_name)) AS name_of_employee,
            max(e.designation) AS designation,
            max(e.joined_on)::text AS date_of_join,
            count(*) FILTER (WHERE i.state <> 'REVERSED')::int AS total_payouts,
            coalesce(sum(CASE WHEN i.state = 'REVERSED' THEN 0 ELSE i.amount_minor + coalesce(a.adjustment_minor, 0) END), 0)::text AS total_paid_minor
       FROM cash_instructions i
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       LEFT JOIN (
         SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
           FROM cash_transaction_adjustments GROUP BY correction_of
       ) a ON a.correction_of = i.id
      WHERE i.employee_mobile = $1 AND i.state NOT IN ('VOID','REJECTED')
      GROUP BY coalesce(i.employee_mobile, e.employee_mobile), e.preferred_name, e.designation`,
    [mobile],
  );
  return summary ? {...summary, name_of_employee: cleanEmployeeName(summary.name_of_employee)} : null;
}

/**
 * Editable Cash transaction fields. Financial state and source identity are
 * immutable here: amount cannot change once POSTED, and designation is stored
 * in the employee registry (the existing source of truth).
 */
export async function updateCashTransaction(
  actor: Actor,
  id: string,
  input: {designation?: string | null; amount?: number | string | null; notes?: string | null},
) {
  assertCapability(actor, 'cash.review');
  await tx(async (client) => {
    const found = await client.query<{
      id: string; employee_mobile: string | null; employee_name: string; amount_minor: string;
      purpose: string | null; state: string;
    }>('SELECT id, employee_mobile, employee_name, amount_minor, purpose, state FROM cash_instructions WHERE id=$1 FOR UPDATE', [id]);
    if (!found.rowCount) throw new DomainError('CASH_TRANSACTION_NOT_FOUND', 404);
    const current = found.rows[0];
    if (['POSTED','REVERSED'].includes(current.state) && input.amount !== undefined && input.amount !== null) {
      throw new DomainError('POSTED_FINANCIAL_FIELDS_LOCKED', 409);
    }
    if (input.amount !== undefined && input.amount !== null) {
      const paidEvent = await client.query('SELECT 1 FROM cash_payment_events WHERE instruction_id=$1 LIMIT 1', [id]);
      if (paidEvent.rowCount) throw new DomainError('CASH_AMOUNT_LOCKED_AFTER_PAID_EVENT', 409);
    }
    const before = {designation: null as string | null, amountMinor: current.amount_minor, notes: current.purpose};
    if (input.designation !== undefined && input.designation !== null) {
      if (!current.employee_mobile) throw new DomainError('EMPLOYEE_NOT_REGISTERED', 409);
      const designation = optionalText(input.designation, 'designation', 100);
      const employee = await client.query('SELECT designation FROM employees WHERE employee_mobile=$1', [current.employee_mobile]);
      before.designation = employee.rows[0]?.designation ?? null;
      await client.query('UPDATE employees SET designation=$2, updated_at=now() WHERE employee_mobile=$1', [current.employee_mobile, designation]);
    }
    if (input.amount !== undefined && input.amount !== null) {
      const amount = Number(input.amount);
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new DomainError('INVALID_AMOUNT', 400);
      await client.query('UPDATE cash_instructions SET amount_minor=$2 WHERE id=$1', [id, amount]);
    }
    if (input.notes !== undefined) {
      const notes = optionalText(input.notes, 'notes', 500);
      await client.query('UPDATE cash_instructions SET purpose=$2 WHERE id=$1', [id, notes]);
    }
    await recordAudit({
      actor,
      action: 'CASH_TRANSACTION_UPDATED',
      entity: 'cash_instruction',
      entityId: id,
      detail: {before, after: {designation: input.designation ?? before.designation, amountMinor: input.amount ?? before.amountMinor, notes: input.notes ?? before.notes}},
      source: 'WEB',
      sourceRef: id,
    }, client);
  });
  return getCashTransaction(id);
}

export async function listInstructions(filters: {state?: string; q?: string; limit?: number; offset?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 200, 1), 10000);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const q = (filters.q ?? '').trim().toLowerCase();
  const items = await rows<Record<string, unknown>>(
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
  return items.map((item): Record<string, unknown> => ({...item, employee_name: cleanEmployeeName(item.employee_name)}));
}

export type CashTransactionFilters = {
  q?: string;
  state?: string;
  employeeId?: string;
  from?: string;
  to?: string;
  amountMin?: number;
  amountMax?: number;
  limit?: number;
  offset?: number;
};

function normalizedMobile(value: string | undefined): string | null {
  const digits = String(value ?? '').replace(/\D/g, '');
  if (/^01[3-9][0-9]{8}$/.test(digits)) return `+88${digits}`;
  if (/^8801[3-9][0-9]{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export type CashTransactionRow = {
  id: string;
  employee_id: string | null;
  name_of_employee: string;
  designation: string | null;
  date_of_join: string | null;
  payout_number: string;
  amount_minor: string;
  original_amount_minor: string;
  adjustment_minor: string;
  total_paid_minor: string;
  correction_count: number;
  last_correction_id: string | null;
  reversal_of: string | null;
  method: string;
  state: string;
  created_at: string;
  source_channel: string | null;
  source_message_id: string | null;
  notes: string | null;
};

/**
 * Live Cash transaction ledger derived from parsed WhatsApp instructions.
 *
 * Source of truth: `cash_instructions` (the existing parser output for the
 * Accountant ↔ Admin direct conversation), joined to the employee registry for
 * designation and joining date. `payout_number` is the sequential payout
 * number for that employee; `total_paid_minor` is the cumulative instructed
 * amount up to and including this row. VOID and REJECTED rows are excluded.
 *
 * Amounts remain integer minor units (paisa) exactly as stored. No upload,
 * image, OCR or bridge write is involved.
 */
export async function listCashTransactions(filters: CashTransactionFilters = {}): Promise<CashTransactionRow[]> {
  const limit = Math.min(Math.max(Number(filters.limit) || 20, 1), 100);
  const offset = Math.max(Number(filters.offset) || 0, 0);
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = [];
  if (filters.q) {
    const like = bind(`%${filters.q.trim()}%`);
    where.push(`(coalesce(i.employee_mobile,'') ILIKE ${like}
      OR i.employee_name ILIKE ${like}
      OR coalesce(e.preferred_name,'') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(e.name_aliases) AS alias WHERE alias ILIKE ${like})
      OR right(regexp_replace(coalesce(i.employee_mobile,''), '\\D', '', 'g'), 11)
         = right(regexp_replace(${bind(filters.q)}, '\\D', '', 'g'), 11))`);
  }
  if (filters.state) where.push(`i.state = ${bind(filters.state)}`);
  const employeeMobile = normalizedMobile(filters.employeeId);
  if (employeeMobile) where.push(`i.employee_mobile = ${bind(employeeMobile)}`);
  if (Number.isFinite(Number(filters.amountMin)) && filters.amountMin !== undefined) where.push(`i.effective_amount_minor >= ${bind(Number(filters.amountMin))}`);
  if (Number.isFinite(Number(filters.amountMax)) && filters.amountMax !== undefined) where.push(`i.effective_amount_minor <= ${bind(Number(filters.amountMax))}`);
  if (filters.from) where.push(`(i.created_at AT TIME ZONE 'Asia/Dhaka')::date >= ${bind(filters.from)}::date`);
  if (filters.to) where.push(`(i.created_at AT TIME ZONE 'Asia/Dhaka')::date <= ${bind(filters.to)}::date`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  params.push(limit, offset);
  return rows<CashTransactionRow>(
    `WITH adjustments AS (
       SELECT correction_of,
              sum(adjustment_minor) AS adjustment_minor,
              count(*)::int AS correction_count,
              max(id) AS last_correction_id
         FROM cash_transaction_adjustments
        GROUP BY correction_of
     ), adjusted AS (
       SELECT i.*,
              coalesce(a.adjustment_minor, 0) AS adjustment_minor,
              i.amount_minor + coalesce(a.adjustment_minor, 0) AS effective_amount_minor,
              coalesce(a.correction_count, 0) AS correction_count,
              a.last_correction_id
         FROM cash_instructions i
         LEFT JOIN adjustments a ON a.correction_of = i.id
        WHERE i.state NOT IN ('VOID','REJECTED')
     ), ordered AS (
       SELECT i.*,
              row_number() OVER (
                PARTITION BY coalesce(i.employee_mobile, lower(i.employee_name))
                ORDER BY i.created_at, i.id
              )::text AS payout_number,
              sum(CASE WHEN i.state = 'REVERSED' THEN 0 ELSE i.effective_amount_minor END) OVER (
                PARTITION BY coalesce(i.employee_mobile, lower(i.employee_name))
                ORDER BY i.created_at, i.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
              )::text AS total_paid_minor
         FROM adjusted i
     )
     SELECT i.id,
            coalesce(i.employee_mobile, e.employee_mobile) AS employee_id,
            coalesce(e.preferred_name, i.employee_name) AS name_of_employee,
            e.designation,
            e.joined_on::text AS date_of_join,
            i.payout_number,
            i.effective_amount_minor::text AS amount_minor,
            i.amount_minor::text AS original_amount_minor,
            i.adjustment_minor::text AS adjustment_minor,
            i.total_paid_minor,
            i.correction_count,
            i.last_correction_id,
            i.reversal_of,
            i.method,
            i.state,
            i.created_at::text AS created_at,
            i.source_channel,
            i.source_message_id,
            i.purpose AS notes
       FROM ordered i
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       ${clause}
      ORDER BY i.created_at DESC, i.id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );
}

/** 1:1 camelCase projection for the Cash transaction API and table. */
export function cashTransactionView(row: CashTransactionRow) {
  return {
    id: row.id,
    employeeId: row.employee_id,
    nameOfEmployee: cleanEmployeeName(row.name_of_employee),
    designation: row.designation,
    dateOfJoin: row.date_of_join,
    payoutNumber: Number(row.payout_number),
    amount: row.amount_minor,
    originalAmount: row.original_amount_minor,
    originalAmountMinor: row.original_amount_minor,
    adjustment: row.adjustment_minor,
    adjustmentMinor: row.adjustment_minor,
    correctionCount: row.correction_count,
    lastCorrectionId: row.last_correction_id,
    reversalOf: row.reversal_of,
    totalPaid: row.total_paid_minor,
    amountMinor: row.amount_minor,
    totalPaidMinor: row.total_paid_minor,
    method: row.method,
    state: row.state,
    source: row.source_channel,
    sourceMessageId: row.source_message_id,
    notes: row.notes,
    createdAt: row.created_at,
  };
}

export async function countCashTransactions(filters: Omit<CashTransactionFilters, 'limit' | 'offset'> = {}) {
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = [`i.state NOT IN ('VOID','REJECTED')`];
  if (filters.q) {
    const like = bind(`%${filters.q.trim()}%`);
    where.push(`(coalesce(i.employee_mobile,'') ILIKE ${like}
      OR i.employee_name ILIKE ${like}
      OR coalesce(e.preferred_name,'') ILIKE ${like}
      OR EXISTS (SELECT 1 FROM unnest(e.name_aliases) AS alias WHERE alias ILIKE ${like})
      OR right(regexp_replace(coalesce(i.employee_mobile,''), '\\D', '', 'g'), 11)
         = right(regexp_replace(${bind(filters.q)}, '\\D', '', 'g'), 11))`);
  }
  if (filters.state) where.push(`i.state = ${bind(filters.state)}`);
  const employeeMobile = normalizedMobile(filters.employeeId);
  if (employeeMobile) where.push(`i.employee_mobile = ${bind(employeeMobile)}`);
  if (Number.isFinite(Number(filters.amountMin)) && filters.amountMin !== undefined) where.push(`i.amount_minor + coalesce(a.adjustment_minor,0) >= ${bind(Number(filters.amountMin))}`);
  if (Number.isFinite(Number(filters.amountMax)) && filters.amountMax !== undefined) where.push(`i.amount_minor + coalesce(a.adjustment_minor,0) <= ${bind(Number(filters.amountMax))}`);
  if (filters.from) where.push(`(i.created_at AT TIME ZONE 'Asia/Dhaka')::date >= ${bind(filters.from)}::date`);
  if (filters.to) where.push(`(i.created_at AT TIME ZONE 'Asia/Dhaka')::date <= ${bind(filters.to)}::date`);
  const result = await row<{n: number}>(
    `SELECT count(*)::int AS n
       FROM cash_instructions i
       LEFT JOIN employees e ON e.employee_mobile = i.employee_mobile
       LEFT JOIN (
         SELECT correction_of, sum(adjustment_minor) AS adjustment_minor
           FROM cash_transaction_adjustments GROUP BY correction_of
       ) a ON a.correction_of = i.id
      WHERE ${where.join(' AND ')}`,
    params,
  );
  return Number(result?.n ?? 0);
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
    // A Business Paid Event and a financial posting are separate records. When
    // both genuinely exist, append the immutable link. This never creates a
    // Business Paid Event and never posts anything by itself.
    if (paidEventsEnabled()) {
      const event = await client.query<{id: string}>(
        `SELECT id FROM cash_payment_events
          WHERE instruction_id = $1 AND event_type = 'PAYMENT'`, [id],
      );
      if (event.rowCount) {
        await client.query(
          `INSERT INTO cash_payment_event_postings
             (payment_event_id, instruction_id, posting_id, posted_at, created_by)
           VALUES ($1,$2,$3,now(),$4)
           ON CONFLICT DO NOTHING`,
          [event.rows[0].id, id, postingId, actor.id],
        );
      }
    }
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

export type BusinessPaidEventDetail = {
  event: Record<string, unknown>;
  rootEventId: string;
  employee: Record<string, unknown> | null;
  instruction: Record<string, unknown> | null;
  submission: Record<string, unknown> | null;
  corrections: Array<Record<string, unknown>>;
  reversal: Record<string, unknown> | null;
  postingLink: Record<string, unknown> | null;
  audit: Array<Record<string, unknown>>;
};

/**
 * Full, auditable view of one Business Paid Event chain. Read-only.
 * A correction/reversal id resolves to its root PAYMENT event so the UI always
 * shows the complete history.
 */
export async function getBusinessPaidEventDetail(eventId: string): Promise<BusinessPaidEventDetail> {
  const id = text(eventId, 'eventId', {max: 80});
  const requested = await row<Record<string, unknown>>(
    'SELECT * FROM cash_payment_events WHERE id = $1', [id],
  );
  if (!requested) throw new DomainError('PAYMENT_EVENT_NOT_FOUND', 404);
  let root = requested;
  if (requested.event_type !== 'PAYMENT') {
    const rootId = (requested.corrects_event_id ?? requested.reverses_event_id) as string | null;
    if (!rootId) throw new DomainError('PAYMENT_EVENT_ROOT_NOT_FOUND', 409);
    const foundRoot = await row<Record<string, unknown>>(
      "SELECT * FROM cash_payment_events WHERE id = $1 AND event_type = 'PAYMENT'", [rootId],
    );
    if (!foundRoot) throw new DomainError('PAYMENT_EVENT_ROOT_NOT_FOUND', 409);
    root = foundRoot;
  }
  const rootId = String(root.id);
  const employee = await row<Record<string, unknown>>(
    `SELECT employee_mobile, preferred_name, name_aliases, designation, state,
            joined_on::text AS joined_on
       FROM employees WHERE employee_mobile = $1`, [root.employee_mobile],
  );
  const instruction = root.instruction_id
    ? await row<Record<string, unknown>>(
      `SELECT i.*, a.code AS account_code, a.name AS account_name,
              p.id AS posting_id, p.posted_at AS financial_posted_at, p.posted_by
         FROM cash_instructions i
         LEFT JOIN cash_accounts a ON a.id = i.account_id
         LEFT JOIN cash_postings p ON p.instruction_id = i.id
        WHERE i.id = $1`, [root.instruction_id],
    )
    : null;
  const submission = root.source_submission_id
    ? await row<Record<string, unknown>>(
      `SELECT id, state, submitted_by, created_at, decided_at, decided_by, decision_reason,
              source_message_id, source_chat_jid, source_account_id, category
         FROM cash_submissions WHERE id = $1`, [root.source_submission_id],
    )
    : null;
  const corrections = await rows<Record<string, unknown>>(
    `SELECT * FROM cash_payment_events
      WHERE event_type = 'CORRECTION' AND corrects_event_id = $1
      ORDER BY created_at DESC, id DESC`, [rootId],
  );
  const reversal = await row<Record<string, unknown>>(
    `SELECT * FROM cash_payment_events
      WHERE event_type = 'REVERSAL' AND reverses_event_id = $1
      ORDER BY created_at DESC, id DESC LIMIT 1`, [rootId],
  );
  const postingLink = await row<Record<string, unknown>>(
    `SELECT l.*, p.posted_at AS financial_posted_at, p.posted_by, p.amount_minor::text AS posted_amount_minor
       FROM cash_payment_event_postings l
       JOIN cash_postings p ON p.id = l.posting_id
      WHERE l.payment_event_id = $1`, [rootId],
  );
  const eventIds = [rootId, ...corrections.map((entry) => String(entry.id)), ...(reversal ? [String(reversal.id)] : [])];
  const audit = await rows<Record<string, unknown>>(
    `SELECT id::text, at, actor, actor_role, action, detail, source, source_ref
       FROM audit_events
      WHERE entity = 'cash_payment_events' AND entity_id = ANY($1::text[])
      ORDER BY at, id`, [eventIds],
  );
  return {event: root, rootEventId: rootId, employee, instruction, submission,
    corrections, reversal, postingLink, audit};
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
    let paidEventId: string | null = null;
    if (decision === 'APPROVED') {
      const payload = (submission.payload ?? {}) as Record<string, unknown>;
      const payloadFields = (payload.fields && typeof payload.fields === 'object')
        ? payload.fields as Record<string, unknown>
        : {};
      const field = (key: string) => payload[key] ?? payloadFields[key];
      const employeeName = typeof field('employeeName') === 'string' ? String(field('employeeName')).trim() : '';
      if (!employeeName) throw new DomainError('EMPLOYEE_NAME_UNRESOLVED', 409);
      // Final Owner rule: one mobile is both employee identity and payout.
      const employeeMobile = optionalMobile(field('employeeMobile') ?? field('employeeId'), 'employeeMobile');
      if (!employeeMobile) throw new DomainError('EMPLOYEE_MOBILE_UNRESOLVED', 409);
      const payoutMobile = optionalMobile(field('payoutMobile'), 'payoutMobile') ?? employeeMobile;
      const method = field('method');
      if (typeof method !== 'string' || !PAYMENT_METHODS.includes(method as PaymentMethod)) {
        throw new DomainError('PAYMENT_METHOD_UNRESOLVED', 409);
      }
      const amountMinor = moneyMinor(field('amountMinor'), 'amountMinor');
      const sourceBlockKey = (payload.sourceBlockKey as string | null | undefined)
        ?? (payload.blockKey as string | null | undefined)
        ?? (payloadFields.blockKey as string | null | undefined)
        ?? null;
      // Attribute the instruction to the candidate's originator, not to the
      // reviewer. Otherwise a sole human Admin would be blocked by the
      // self-review rule immediately after approving the candidate.
      const originator = {...actor, id: submission.submitted_by, displayName: undefined};
      const instruction = await insertInstruction(client, originator, {
        employeeName,
        employeeMobile,
        payoutMobile,
        method,
        amountMinor,
        purpose: (field('purpose') as string | null | undefined) ?? null,
        accountId: (field('accountId') as string | null | undefined) ?? null,
        sourceChannel: submission.source_message_id ? 'WHATSAPP' : 'WEB',
        sourceMessageId: submission.source_message_id ?? (payload.sourceMessageId as string | null | undefined) ?? null,
        sourceBlockKey,
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
      // Office verification is its own source category even when the
      // candidate originated from a WhatsApp message. It must never be
      // presented as an independently verified WhatsApp automatic payment.
      if (paidEventsEnabled()) {
        paidEventId = await insertBusinessPaidEvent(client, {
          instructionId,
          sourceSubmissionId: submission.id,
          employeeMobile: instruction.employee_mobile ?? employeeMobile,
          payoutMobile: instruction.payout_mobile ?? payoutMobile,
          employeeName: instruction.employee_name,
          amountMinor: instruction.amount_minor,
          method: instruction.method,
          sourceCategory: 'OFFICE',
          sourceMessageId: submission.source_message_id,
          sourceBlockKey,
          paidAt: null,
          createdBy: actor.id,
        });
        if (paidEventId) {
          await recordAudit({actor, action: 'CASH_PAYMENT_EVENT_CREATED', entity: 'cash_payment_events',
            entityId: paidEventId, detail: {instructionId, sourceCategory: 'OFFICE', submissionId: id}}, client);
        }
      }
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
    return {id, state: decision, instructionId, instructionState: instructionId ? 'REVIEW' : null, paidEventId};
  });
}

// ── Business Paid corrections / reversals (append-only, no ledger writes) ──
export type PaymentEventCorrectionInput = {
  amountMinor: number;
  employeeName?: string | null;
  method?: string | null;
  reason: string;
};

async function originalPaymentEvent(client: Tx, eventId: string) {
  const found = await client.query<{
    id: string; instruction_id: string | null; source_submission_id: string | null;
    employee_mobile: string; payout_mobile: string; employee_name: string;
    amount_minor: string; method: string; source_category: 'WHATSAPP' | 'OFFICE';
    source_message_id: string | null; source_block_key: string | null; status: string;
  }>(`SELECT id, instruction_id, source_submission_id, employee_mobile, payout_mobile, employee_name,
             amount_minor::text, method, source_category, source_message_id, source_block_key, status
        FROM cash_payment_events
       WHERE id = $1 AND event_type = 'PAYMENT'`, [eventId]);
  if (!found.rowCount) throw new DomainError('PAYMENT_EVENT_NOT_FOUND', 404);
  return found.rows[0];
}

/**
 * Append a CORRECTION event. It never changes the original row, never posts
 * and never writes a ledger entry. Reporting uses the latest correction as the
 * effective business amount.
 */
export async function correctBusinessPaidEvent(actor: Actor, eventId: string, input: PaymentEventCorrectionInput) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  if (!paidEventsEnabled()) throw new DomainError('PAID_EVENTS_DISABLED', 409);
  const reason = text(input.reason, 'reason', {max: 500});
  const amountMinor = moneyMinor(input.amountMinor, 'amountMinor');
  return tx(async (client) => {
    const original = await originalPaymentEvent(client, eventId);
    const reversed = await client.query(
      `SELECT 1 FROM cash_payment_events WHERE event_type='REVERSAL' AND reverses_event_id=$1`, [eventId],
    );
    if (reversed.rowCount) throw new DomainError('PAYMENT_EVENT_REVERSED', 409);
    const method = input.method ?? original.method;
    if (!PAYMENT_METHODS.includes(method as PaymentMethod)) throw new DomainError('INVALID_METHOD');
    const employeeName = input.employeeName?.trim() || original.employee_name;
    const id = newId('pe');
    await client.query(
      `INSERT INTO cash_payment_events
         (id, event_type, instruction_id, source_submission_id, employee_mobile, payout_mobile,
          employee_name, employee_link_status, amount_minor, method, source_category,
          source_message_id, source_block_key, status, paid_at, reason, corrects_event_id, created_by)
       SELECT $1,'CORRECTION',instruction_id,source_submission_id,employee_mobile,payout_mobile,
              $2,employee_link_status,$3,$4,source_category,source_message_id,source_block_key,
              'CORRECTED',now(),$5,$6,$7
         FROM cash_payment_events WHERE id=$6`,
      [id, employeeName, amountMinor, method, reason, eventId, actor.id],
    );
    await recordAudit({actor, action: 'CASH_PAYMENT_EVENT_CORRECTED', entity: 'cash_payment_events',
      entityId: id, detail: {correctsEventId: eventId, amountMinor, reason}}, client);
    return {id, eventType: 'CORRECTION', correctsEventId: eventId, amountMinor};
  });
}

/**
 * Append a REVERSAL event. The original event and any financial posting are
 * untouched; this is business-layer audit only and never creates a ledger
 * reversal.
 */
export async function reverseBusinessPaidEvent(actor: Actor, eventId: string, reason: string) {
  assertCapability(actor, 'cash.review');
  if (actor.role !== 'ADMIN') throw new DomainError('ADMIN_REQUIRED', 403);
  if (!paidEventsEnabled()) throw new DomainError('PAID_EVENTS_DISABLED', 409);
  const why = text(reason, 'reason', {max: 500});
  return tx(async (client) => {
    await originalPaymentEvent(client, eventId);
    const existing = await client.query(
      `SELECT 1 FROM cash_payment_events WHERE event_type='REVERSAL' AND reverses_event_id=$1`, [eventId],
    );
    if (existing.rowCount) throw new DomainError('PAYMENT_EVENT_ALREADY_REVERSED', 409);
    const id = newId('pe');
    await client.query(
      `INSERT INTO cash_payment_events
         (id, event_type, instruction_id, source_submission_id, employee_mobile, payout_mobile,
          employee_name, employee_link_status, amount_minor, method, source_category,
          source_message_id, source_block_key, status, paid_at, reason, reverses_event_id, created_by)
       SELECT $1,'REVERSAL',instruction_id,source_submission_id,employee_mobile,payout_mobile,
              employee_name,employee_link_status,amount_minor,method,source_category,
              source_message_id,source_block_key,'REVERSED',now(),$2,$3,$4
         FROM cash_payment_events WHERE id=$3`,
      [id, why, eventId, actor.id],
    );
    await recordAudit({actor, action: 'CASH_PAYMENT_EVENT_REVERSED', entity: 'cash_payment_events',
      entityId: id, detail: {reversesEventId: eventId, reason: why}}, client);
    return {id, eventType: 'REVERSAL', reversesEventId: eventId};
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
