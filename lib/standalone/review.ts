import {rows, row, tx, text, optionalText, DomainError, type Actor} from './db.ts';
import {recordAudit, newId} from './audit.ts';
import {createEmployee, updateEmployee} from './employees.ts';
import {createProgram} from './programs.ts';
import {recordAttendance} from './attendance.ts';

export type Domain = 'EMPLOYEE' | 'PROGRAM' | 'ATTENDANCE' | 'CASH';
export type Action = 'CREATE' | 'UPDATE' | 'DELETE';

const DOMAINS: Domain[] = ['EMPLOYEE', 'PROGRAM', 'ATTENDANCE', 'CASH'];

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
  const created = await row(
    `INSERT INTO review_items (id, domain, action, target_ref, payload, submitted_by)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT DO NOTHING RETURNING *`,
    [id, domain, input.action, input.targetRef ?? null, JSON.stringify(input.payload), actor.id],
  );
  if (!created) throw new DomainError('PENDING_REVIEW_EXISTS', 409);
  await recordAudit({actor, action: 'REVIEW_SUBMITTED', entity: 'review_item', entityId: id, detail: {domain}});
  return created;
}

export async function listReview(filters: {state?: string; mine?: boolean; actor?: Actor; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 300);
  return rows(
    `SELECT r.*, u.display_name AS submitter_name
       FROM review_items r LEFT JOIN cash_portal_users u ON u.id = r.submitted_by
      WHERE ($1::text IS NULL OR r.state = $1)
        AND ($2::boolean IS NOT TRUE OR r.submitted_by = $3)
      ORDER BY r.created_at DESC LIMIT $4`,
    [filters.state ?? 'PENDING', filters.mine ?? false, filters.actor?.id ?? '', limit],
  );
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
      `UPDATE review_items SET state = $2, decided_at = now() WHERE id = $1`,
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
  await row(`UPDATE review_items SET state = 'WITHDRAWN', decided_at = now() WHERE id = $1 RETURNING id`, [id]);
  await recordAudit({actor, action: 'REVIEW_WITHDRAWN', entity: 'review_item', entityId: id});
  return {id, state: 'WITHDRAWN'};
}

export const reviewText = text;
