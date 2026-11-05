import {createHash, randomUUID} from 'node:crypto';
import {rows, row, type Actor} from './db.ts';

export type AuditInput = {
  actor: Actor | {id: string; role?: string};
  action: string;
  entity: string;
  entityId?: string | null;
  detail?: Record<string, unknown>;
  source?: 'WEB' | 'WHATSAPP' | 'SYSTEM';
  sourceRef?: string | null;
};

/** Append-only audit record. There is no update or delete path anywhere. */
export async function recordAudit(input: AuditInput): Promise<void> {
  await row(
    `INSERT INTO audit_events (actor, actor_role, action, entity, entity_id, detail, source, source_ref)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
    [
      input.actor.id,
      input.actor.role ?? null,
      input.action.slice(0, 80),
      input.entity.slice(0, 60),
      input.entityId ?? null,
      JSON.stringify(input.detail ?? {}),
      input.source ?? 'WEB',
      input.sourceRef ?? null,
    ],
  );
}

export type AuditListRow = {
  id: string;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entity_id: string | null;
  source: string;
};

export async function listAudit(filters: {entity?: string; entityId?: string; limit?: number} = {}) {
  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 500);
  return rows<AuditListRow>(
    `SELECT id::text, at, actor, action, entity, entity_id, source
       FROM audit_events
      WHERE ($1::text IS NULL OR entity = $1)
        AND ($2::text IS NULL OR entity_id = $2)
      ORDER BY at DESC, id DESC
      LIMIT $3`,
    [filters.entity ?? null, filters.entityId ?? null, limit],
  );
}

export const newId = (prefix: string) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export const stableId = (prefix: string, parts: unknown[]) =>
  `${prefix}_${createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 24)}`;
