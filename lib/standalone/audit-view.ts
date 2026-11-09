import {rows, row} from './db.ts';

export type AuditEventView = {
  id: string;
  timestamp: string;
  actor: string;
  actorName: string | null;
  action: string;
  domain: string;
  targetType: string;
  targetId: string | null;
  before: unknown;
  after: unknown;
  metadata: Record<string, unknown>;
  source: string | null;
  sourceRef: string | null;
  sourceMessageId: string | null;
  origin: string;
};

export type AuditFilters = {
  from?: string;
  to?: string;
  domain?: string;
  action?: string;
  actor?: string;
  targetId?: string;
  page?: number;
  limit?: number;
};

const CTE = `
WITH audit AS (
  SELECT a.id::text AS id, a.at, a.actor, u.display_name AS actor_name, a.action,
         a.entity AS target_type, a.entity_id AS target_id,
         a.detail, a.source, a.source_ref, 'audit_events'::text AS origin,
         NULL::text AS source_message_id
    FROM audit_events a
    LEFT JOIN cash_portal_users u ON u.id = a.actor
), program AS (
  SELECT 'pe:' || pe.id::text AS id, pe.created_at AS at, pe.actor, u.display_name AS actor_name,
         'VESSEL:' || pe.action AS action, 'program'::text AS target_type, pe.program_id AS target_id,
         pe.payload AS detail, 'SYSTEM'::text AS source, pe.program_id AS source_ref,
         'program_events'::text AS origin,
         (SELECT psm.message_id FROM program_source_messages psm
           WHERE psm.program_id = pe.program_id ORDER BY psm.created_at LIMIT 1) AS source_message_id
    FROM program_events pe
    LEFT JOIN cash_portal_users u ON u.id = pe.actor
), unified AS (
  SELECT a.*,
         CASE
           WHEN a.origin = 'program_events' THEN 'VESSEL'
           WHEN a.target_type IN ('cash_instruction','instruction','cash_submission','cash_payment_events','ledger','reconciliation','account') THEN 'CASH'
           WHEN a.action LIKE 'CASH%' OR a.action LIKE 'INSTRUCTION%' OR a.action LIKE '%LEDGER%'
                OR a.action LIKE '%RECONCILIATION%' OR a.action LIKE 'ACCOUNT_%' THEN 'CASH'
           WHEN a.target_type = 'program' OR a.action LIKE 'PROGRAM%' OR a.action LIKE 'ESCORT%'
                OR a.action LIKE 'VESSEL%' THEN 'VESSEL'
           WHEN a.target_type = 'review_item' OR a.action LIKE 'REVIEW%' THEN 'REVIEW'
           WHEN a.action LIKE 'AUTH%' OR a.action LIKE 'LOGIN%' OR a.action LIKE 'LOGOUT%'
                OR a.target_type = 'user' THEN 'AUTH'
           ELSE 'SYSTEM'
         END AS domain
    FROM (SELECT * FROM audit UNION ALL SELECT * FROM program) a
)`;

export async function listAuditEvents(filters: AuditFilters) {
  const from = String(filters.from ?? '').trim();
  const to = String(filters.to ?? '').trim();
  const domain = String(filters.domain ?? '').trim().toUpperCase();
  const action = String(filters.action ?? '').trim().toUpperCase();
  const actorFilter = String(filters.actor ?? '').trim();
  const targetId = String(filters.targetId ?? '').trim();
  const page = Math.max(1, Number(filters.page) || 1);
  const limit = Math.min(Math.max(Number(filters.limit) || 50, 1), 200);

  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const where: string[] = [];
  if (from) where.push(`at >= ${bind(from)}::date`);
  if (to) where.push(`at < (${bind(to)}::date + interval '1 day')`);
  if (domain && domain !== 'ALL') where.push(`domain = ${bind(domain)}`);
  if (action && action !== 'ALL') where.push(`action ILIKE ${bind(`%${action}%`)}`);
  if (actorFilter) where.push(`(actor ILIKE ${bind(`%${actorFilter}%`)} OR coalesce(actor_name,'') ILIKE ${bind(`%${actorFilter}%`)})`);
  if (targetId) where.push(`coalesce(target_id,'') ILIKE ${bind(`%${targetId}%`)}`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;
  const listParams = [...params, limit, offset];

  const [eventRows, counted] = await Promise.all([
    rows<{
      id: string; at: string; actor: string; actor_name: string | null; action: string; domain: string;
      target_type: string; target_id: string | null; detail: Record<string, unknown> | null;
      source: string | null; source_ref: string | null; source_message_id: string | null; origin: string;
    }>(
      `${CTE}
       SELECT id, at::text AS at, actor, actor_name, action, domain, target_type, target_id,
              detail, source, source_ref, source_message_id, origin
         FROM unified ${clause}
        ORDER BY at DESC, id DESC
        LIMIT $${listParams.length - 1} OFFSET $${listParams.length}`,
      listParams,
    ),
    row<{count: string}>(`${CTE} SELECT count(*)::text AS count FROM unified ${clause}`, params),
  ]);

  const total = Number(counted?.count ?? 0);
  const events: AuditEventView[] = eventRows.map((event) => {
    const detail = event.detail ?? {};
    return {
      id: event.id,
      timestamp: event.at,
      actor: event.actor,
      actorName: event.actor_name,
      action: event.action,
      domain: event.domain,
      targetType: event.target_type,
      targetId: event.target_id,
      before: (detail.before as unknown) ?? null,
      after: (detail.after as unknown) ?? null,
      metadata: detail,
      source: event.source,
      sourceRef: event.source_ref,
      sourceMessageId: event.source_message_id,
      origin: event.origin,
    };
  });

  return {events, total, page, limit, totalPages: Math.max(1, Math.ceil(total / limit))};
}
