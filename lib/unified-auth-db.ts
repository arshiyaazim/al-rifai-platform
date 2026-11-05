// Unified session loader — database access only.
//
// This module is importable from both the Node.js proxy entry and React server
// components/routes, so it must NOT import `next/headers`. It reuses the Cash
// Portal's connection pool (`lib/cash-portal.ts` -> cash_portal_sessions
// / cash_portal_users) and never creates a second identity store.
//
// Parity with the Cash Portal session rules (lib/cash-portal.ts):
//   * absolute lifetime 8 hours, idle timeout 30 minutes,
//   * inactive users are refused,
//   * the cookie is an opaque 64-hex token; only its SHA-256 hash is stored.

import {database, hashToken, isCashSuperAdmin} from './cash-portal';
import {
  parseCookieHeader,
  resolveCapabilities,
  sessionCookieName,
  type AuthRole,
  type Capability,
} from './unified-auth-policy';

export const SESSION_MS = 8 * 60 * 60 * 1000;
export const IDLE_MS = 30 * 60 * 1000;

type SessionRow = {
  session_id: string;
  expires_at: Date;
  session_last_seen_at: Date;
  id: string;
  username: string;
  role: AuthRole;
  display_name: string;
  email: string | null;
  mobile: string | null;
  whatsapp_number: string | null;
  must_change_password: boolean;
  active: boolean;
  last_seen_at: Date | null;
  capabilities: unknown;
};

export type UnifiedIdentity = {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  mobile: string | null;
  whatsappNumber: string | null;
  role: AuthRole;
  mustChangePassword: boolean;
  active: boolean;
  lastSeenAt: string | null;
  capabilities: Capability[];
  superAdmin: boolean;
};

function toIdentity(row: SessionRow): UnifiedIdentity {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email,
    mobile: row.mobile,
    whatsappNumber: row.whatsapp_number,
    role: row.role,
    mustChangePassword: row.must_change_password,
    active: row.active,
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    capabilities: resolveCapabilities(row.role, row.capabilities),
    superAdmin: isCashSuperAdmin({id: row.id, role: row.role}),
  };
}

/**
 * Validates an opaque session token against the deployed session table.
 * Returns null for anything unexpected (including database failure) so every
 * caller fails closed. Never throws.
 */
export async function loadSessionIdentity(token: string | null | undefined): Promise<UnifiedIdentity | null> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  let row: SessionRow | undefined;
  try {
    const result = await database().query<SessionRow>(
      `SELECT s.id AS session_id,s.last_seen_at AS session_last_seen_at,s.expires_at,u.*
       FROM cash_portal_sessions s
       JOIN cash_portal_users u ON u.id=s.user_id
       WHERE s.id=$1`,
      [hashToken(token)],
    );
    row = result.rows[0];
  } catch {
    return null;
  }
  if (!row || !row.active) return null;
  const now = Date.now();
  if (now >= new Date(row.expires_at).getTime()) return null;
  if (now - new Date(row.session_last_seen_at).getTime() >= IDLE_MS) return null;
  try {
    await database().query('UPDATE cash_portal_sessions SET last_seen_at=now() WHERE id=$1', [row.session_id]);
    await database().query('UPDATE cash_portal_users SET last_seen_at=now() WHERE id=$1', [row.id]);
  } catch {
    // A failed touch must not invalidate an otherwise valid session.
  }
  return toIdentity(row);
}

/** Convenience wrapper for a raw Cookie header (proxy entry). */
export async function sessionIdentityFromCookieHeader(header: string | null | undefined): Promise<UnifiedIdentity | null> {
  const token = parseCookieHeader(header, sessionCookieName());
  if (!token) return null;
  return loadSessionIdentity(token);
}

export async function revokeSession(token: string | null | undefined): Promise<void> {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return;
  await database().query('DELETE FROM cash_portal_sessions WHERE id=$1', [hashToken(token)]);
}
