import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {rows, tx, text, DomainError, type Actor} from './db.ts';
import {recordAudit} from './audit.ts';
import {assertCapability} from './authz.ts';
import {hashPassword} from '../password-hash.ts';
import {isAcceptablePassword} from '../password-policy.ts';
import {isConfiguredSuperAdmin, type AuthRole} from '../unified-auth-policy.ts';

const USERNAME_RE = /^[A-Za-z0-9._-]{3,80}$/;

export type UserRow = {
  id: string;
  username: string;
  role: AuthRole;
  display_name: string;
  active: boolean;
  must_change_password: boolean;
  capabilities: unknown;
  created_at: string;
  last_seen_at: string | null;
};

function userId(username: string): string {
  return createHash('sha256').update(`cash-user:${username.toLowerCase()}`).digest('hex');
}

function assertSuperAdmin(actor: Actor): void {
  assertCapability(actor, 'user.manage');
  if (actor.superAdmin !== true) throw new DomainError('SUPER_ADMIN_REQUIRED', 403);
}

function configuredIds(): string[] {
  return (process.env.ALRIFAI_CASH_SUPER_ADMIN_IDS ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
}

async function targetBy(client: Pick<PoolClient, 'query'>, idOrUsername: string): Promise<UserRow> {
  const value = text(idOrUsername, 'user', {max: 80});
  // Resolve by exact id first. A username may legitimately look like a 64-hex
  // id; testing both in one OR could select the wrong account.
  const byId = await client.query(
    'SELECT * FROM cash_portal_users WHERE id = $1 FOR UPDATE', [value],
  );
  if (byId.rowCount) return byId.rows[0] as UserRow;
  const byName = await client.query(
    'SELECT * FROM cash_portal_users WHERE lower(username) = lower($1) FOR UPDATE', [value],
  );
  if (!byName.rowCount) throw new DomainError('USER_NOT_FOUND', 404);
  return byName.rows[0] as UserRow;
}

export async function listUsers(): Promise<UserRow[]> {
  return rows<UserRow>(
    `SELECT id, username, role, display_name, active, must_change_password, capabilities,
            created_at, last_seen_at
       FROM cash_portal_users ORDER BY role, username`,
  );
}

export async function createUser(actor: Actor, input: {
  username: string; password: string; displayName?: string; role?: string;
}) {
  assertSuperAdmin(actor);
  const username = text(input.username, 'username', {max: 80});
  if (!USERNAME_RE.test(username)) throw new DomainError('USERNAME_INVALID');
  if (!isAcceptablePassword(input.password)) throw new DomainError('PASSWORD_POLICY');
  const role = (input.role ?? 'USER').toUpperCase();
  if (!['ADMIN', 'USER'].includes(role)) throw new DomainError('INVALID_ROLE');
  const displayName = text(input.displayName ?? username, 'displayName', {max: 150});
  const id = userId(username);
  const hash = await hashPassword(input.password);

  return tx(async (client) => {
    try {
      await client.query(
        `INSERT INTO cash_portal_users
           (id, username, password_hash, role, display_name, must_change_password, active, created_by, capabilities)
         VALUES ($1,$2,$3,$4,$5,true,true,$6,'[]'::jsonb)`,
        [id, username, hash, role, displayName, actor.id],
      );
    } catch (error) {
      if ((error as {code?: string}).code === '23505') throw new DomainError('USERNAME_EXISTS', 409);
      throw error;
    }
    await recordAudit({actor, action: 'USER_CREATED', entity: 'user', entityId: id, detail: {username, role}}, client);
    return {id, username, role, displayName, active: true, mustChangePassword: true};
  });
}

export async function updateUser(actor: Actor, input: {
  user: string; displayName?: string; role?: string; active?: boolean;
}) {
  assertSuperAdmin(actor);
  const targetKey = text(input.user, 'user', {max: 80});
  const nextRole = input.role === undefined ? undefined : input.role.toUpperCase();
  if (nextRole !== undefined && !['ADMIN', 'USER'].includes(nextRole)) throw new DomainError('INVALID_ROLE');
  const nextActive = input.active;
  return tx(async (client) => {
    const target = await targetBy(client, targetKey);
    const role = (nextRole as AuthRole | undefined) ?? target.role;
    const active = nextActive ?? target.active;
    const removesAdmin = target.role === 'ADMIN' && (role !== 'ADMIN' || active === false);
    if (removesAdmin) {
      const count = await client.query<{n: string}>(
        `SELECT count(*)::text AS n FROM cash_portal_users WHERE role='ADMIN' AND active=true`,
      );
      if (Number(count.rows[0]?.n ?? 0) <= 1) throw new DomainError('LAST_ADMIN_PROTECTED', 403);
      const configured = configuredIds();
      if (configured.includes(target.id) && isConfiguredSuperAdmin(target.id, target.role, configured.join(','))) {
        const configuredActive = await client.query<{n: string}>(
          `SELECT count(*)::text AS n FROM cash_portal_users
            WHERE role='ADMIN' AND active=true AND id = ANY($1::text[])`, [configured],
        );
        if (Number(configuredActive.rows[0]?.n ?? 0) <= 1) throw new DomainError('LAST_SUPER_ADMIN_PROTECTED', 403);
      }
    }
    const displayName = input.displayName === undefined
      ? target.display_name
      : text(input.displayName, 'displayName', {max: 150});
    await client.query(
      `UPDATE cash_portal_users
          SET display_name=$2, role=$3, active=$4, version=version+1
        WHERE id=$1`,
      [target.id, displayName, role, active],
    );
    if (!active) await client.query('DELETE FROM cash_portal_sessions WHERE user_id=$1', [target.id]);
    await recordAudit({
      actor, action: 'USER_UPDATED', entity: 'user', entityId: target.id,
      detail: {username: target.username, role, active, displayName},
    }, client);
    return {id: target.id, username: target.username, role, active, displayName};
  });
}

export async function resetUserPassword(actor: Actor, input: {user: string; password: string}) {
  assertSuperAdmin(actor);
  if (!isAcceptablePassword(input.password)) throw new DomainError('PASSWORD_POLICY');
  const hash = await hashPassword(input.password);
  return tx(async (client) => {
    const target = await targetBy(client, input.user);
    await client.query(
      `UPDATE cash_portal_users
          SET password_hash=$2, must_change_password=true, password_changed_at=now(), version=version+1
        WHERE id=$1`,
      [target.id, hash],
    );
    await client.query('DELETE FROM cash_portal_sessions WHERE user_id=$1', [target.id]);
    await recordAudit({
      actor, action: 'USER_PASSWORD_RESET', entity: 'user', entityId: target.id,
      detail: {username: target.username, sessionsRevoked: true},
    }, client);
    return {id: target.id, username: target.username, sessionsRevoked: true};
  });
}
