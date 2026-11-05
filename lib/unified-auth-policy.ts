// Unified authentication policy — pure functions only.
//
// No database, no sessions, no secrets, no framework imports. Everything here
// is unit-testable and is shared by:
//   * release/proxy entry guard (proxy.ts),
//   * app/chatgpt-auth.ts (server component / route identity),
//   * app/api/auth/** and app/api/cash/** (self-service and admin actions).
//
// Non-negotiable invariants encoded below:
//   1. The Cash Portal credential store (public.cash_portal_users) and its
//      session table are the single identity source. No second password store.
//   2. The session cookie name is the already-deployed `__Host-alrifai_cash`
//      name, so existing production Cash sessions stay valid.
//   3. The Super Admin identity remains the established allowlist policy
//      (role ADMIN AND id listed in ALRIFAI_CASH_SUPER_ADMIN_IDS). A client
//      cannot assert it; it is resolved from the stored row plus config.
//   4. Capabilities may only widen feature access for a verified actor and
//      can never be granted into a super-admin-only slot.

export type AuthRole = 'ADMIN' | 'USER';
export type UnifiedAuthMode = 'off' | 'shadow' | 'on';

/**
 * The exact cookie name already issued by the Cash Portal. Reusing it is what
 * makes Cash, Vessel, Dashboard and Admin Panel sessions compatible without
 * invalidating a single production session.
 */
export const SESSION_COOKIE_NAME = '__Host-alrifai_cash';
export const SESSION_TOKEN_PATTERN = /^[a-f0-9]{64}$/;

export const UNIFIED_AUTH_MODES: readonly UnifiedAuthMode[] = ['off', 'shadow', 'on'];

/**
 * Feature capabilities. `cash.post` is intentionally absent: posting remains
 * prohibited and must never be expressible as a grantable permission.
 */
export const CAPABILITIES = [
  'cash.read',
  'cash.submit',
  'cash.review',
  'vessel.read',
  'vessel.submit',
  'employee.submit',
  'attendance.submit',
  'vessel.command',
  'audit.read',
  'workspace.admin',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

/** Capabilities that only make sense for an ADMIN account. */
export const ADMIN_ONLY_CAPABILITIES: readonly Capability[] = ['cash.review'];

/**
 * Capabilities that are never grantable through the Admin Panel. Workspace
 * administration is derived from the configured Super Admin identity only.
 */
export const SUPER_ADMIN_ONLY_CAPABILITIES: readonly Capability[] = ['workspace.admin'];

const ROLE_CAPABILITIES: Record<AuthRole, readonly Capability[]> = {
  ADMIN: ['cash.read', 'cash.submit', 'cash.review', 'vessel.read', 'vessel.command', 'vessel.submit', 'employee.submit', 'attendance.submit', 'audit.read'],
  // USER may stage work for review but never write it directly: vessel.command and
  // cash.review stay admin-only, and cash.post is absent entirely.
  USER: ['cash.read', 'cash.submit', 'vessel.read', 'vessel.submit', 'employee.submit', 'attendance.submit'],
};

export class UnifiedAuthError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 403) {
    super(code);
    this.name = 'UnifiedAuthError';
    this.code = code;
    this.status = status;
  }
}

const deny = (code: string, status = 403): never => {
  throw new UnifiedAuthError(code, status);
};

/** Unknown/absent mode never enables the new path: it fails closed to `off`. */
export function unifiedAuthMode(value: string | null | undefined): UnifiedAuthMode {
  const mode = String(value ?? '').trim().toLowerCase();
  return (UNIFIED_AUTH_MODES as readonly string[]).includes(mode) ? (mode as UnifiedAuthMode) : 'off';
}

export function sessionCookieName(): string {
  return SESSION_COOKIE_NAME;
}

export function isSessionToken(value: unknown): value is string {
  return typeof value === 'string' && SESSION_TOKEN_PATTERN.test(value);
}

/** Reads one cookie from a raw Cookie header without touching the request. */
export function parseCookieHeader(header: string | null | undefined, name = SESSION_COOKIE_NAME): string | null {
  if (typeof header !== 'string' || !header) return null;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed.startsWith(`${name}=`)) continue;
    const value = trimmed.slice(name.length + 1);
    return isSessionToken(value) ? value : null;
  }
  return null;
}

/**
 * Paths that must be reachable without an existing session while unified auth
 * is enabled: the sign-in page, its API, and the sign-out endpoint. Everything
 * else keeps the legacy guard.
 */
const PUBLIC_AUTH_PATHS = ['/login', '/api/auth/'] as const;

export function isUnifiedAuthPublicPath(pathname: string): boolean {
  if (typeof pathname !== 'string' || !pathname.startsWith('/')) return false;
  return PUBLIC_AUTH_PATHS.some(rule => (rule.endsWith('/') ? pathname.startsWith(rule) : pathname === rule));
}

/**
 * The Cash Portal keeps its own session boundary and is never redirected to
 * the unified login — it already authenticates against the same user store.
 */
export function isCashPortalPath(pathname: string): boolean {
  return pathname === '/cash' || pathname.startsWith('/cash/')
    || pathname === '/api/cash' || pathname.startsWith('/api/cash/');
}

export function normalizeCapabilities(value: unknown): Capability[] {
  const raw = Array.isArray(value) ? value : [];
  const seen = new Set<Capability>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const code = entry.trim();
    if ((CAPABILITIES as readonly string[]).includes(code)) seen.add(code as Capability);
  }
  return [...seen].sort();
}

/** Role defaults plus explicit grants. Grants never subtract and never elevate the role. */
export function resolveCapabilities(role: AuthRole, stored: unknown): Capability[] {
  const granted = new Set<Capability>(ROLE_CAPABILITIES[role]);
  for (const capability of normalizeCapabilities(stored)) granted.add(capability);
  return [...granted].sort();
}

export function hasCapability(user: {role: AuthRole; capabilities?: unknown}, capability: Capability): boolean {
  return resolveCapabilities(user.role, user.capabilities).includes(capability);
}

/** The established Super Admin policy, kept identical to lib/cash-portal.ts. */
export function isConfiguredSuperAdmin(id: string, role: AuthRole, configured: string | null | undefined): boolean {
  if (role !== 'ADMIN' || !isSessionToken(id)) return false;
  if (typeof configured !== 'string') return false;
  return configured.split(',').some(entry => entry.trim() === id);
}

export function assertSuperAdminIdentity(
  user: {id: string; role: AuthRole},
  configured: string | null | undefined,
): void {
  if (!isConfiguredSuperAdmin(user.id, user.role, configured)) deny('SUPER_ADMIN_REQUIRED');
}

/**
 * Capability editing is a Super Admin action. `workspace.admin` is config-bound
 * and can never be handed out, and ADMIN-only capabilities cannot be attached
 * to a USER account (the guarded routes would ignore them and the UI would lie).
 */
export function assertCanEditCapabilities(
  actor: {role: AuthRole; superAdmin: boolean},
  targetRole: AuthRole,
): void {
  if (actor.role !== 'ADMIN') deny('ADMIN_REQUIRED');
  if (actor.superAdmin !== true) deny('SUPER_ADMIN_REQUIRED');
  void targetRole;
}

export function validateCapabilityRequest(
  actor: {role: AuthRole; superAdmin: boolean},
  targetRole: AuthRole,
  requested: unknown,
): Capability[] {
  assertCanEditCapabilities(actor, targetRole);
  if (!Array.isArray(requested)) return deny('CAPABILITIES_INVALID', 400);
  const entries: unknown[] = requested;
  for (const entry of entries) {
    if (typeof entry !== 'string' || !(CAPABILITIES as readonly string[]).includes(entry.trim())) {
      deny('CAPABILITIES_INVALID', 400);
    }
  }
  const next = normalizeCapabilities(entries);
  for (const capability of next) {
    if (SUPER_ADMIN_ONLY_CAPABILITIES.includes(capability)) deny('CAPABILITY_NOT_GRANTABLE');
    if (targetRole !== 'ADMIN' && ADMIN_ONLY_CAPABILITIES.includes(capability)) deny('CAPABILITY_ROLE_CONFLICT', 400);
  }
  return next;
}

/**
 * Lockout guard for the configured Super Admin identity. Deactivating or
 * demoting the last *configured* Super Admin is refused even when other
 * ordinary admins exist, because those accounts cannot recover the panel.
 */
export function assertNotRemovingLastSuperAdmin(input: {
  targetId: string;
  targetRole: AuthRole;
  targetActive: boolean;
  nextRole: AuthRole;
  nextActive: boolean;
  configuredIds: string | null | undefined;
  activeConfiguredAdmins: number;
}): void {
  const {targetId, targetRole, targetActive, nextRole, nextActive, configuredIds} = input;
  if (!isConfiguredSuperAdmin(targetId, targetRole, configuredIds)) return;
  const removes = targetActive === true && (nextRole !== 'ADMIN' || nextActive === false);
  if (!removes) return;
  if (Number(input.activeConfiguredAdmins) <= 1) deny('LAST_SUPER_ADMIN_PROTECTED');
}

/** Username change is explicit, self-service and never automatic. */
export function normalizeUsername(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const username = value.trim();
  if (!/^[A-Za-z0-9._-]{3,80}$/.test(username)) return undefined;
  return username;
}

export function assertUsernameChange(current: string, next: string): void {
  if (current.toLowerCase() === next.toLowerCase()) deny('USERNAME_UNCHANGED', 400);
}

/**
 * Post-login redirect must stay on this application. Absolute URLs, protocol
 * relative URLs, encoded separators and traversal are all rejected.
 */
export function sanitizeReturnTo(value: unknown, fallback = '/dashboard'): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.length > 512) return fallback;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.includes('//') || decoded.includes('\\') || /(^|\/)\.\.?(\/|$)/.test(decoded)) return fallback;
  if (decoded.startsWith('/api/') || isUnifiedAuthPublicPath(decoded) || isCashPortalPath(decoded)) return fallback;
  return decoded;
}

/**
 * Whether a visitor who already holds a validated session may skip the form.
 *
 * Only `on` mode lets a Cash session authorise workspace routes. In `shadow`
 * the session is deliberately *not* sufficient, so sending the browser to a
 * protected page would bounce straight back to /login — the 2026-10-28
 * ERR_TOO_MANY_REDIRECTS cycle. The destination is sanitised in every mode.
 */
export function signedInRedirectTarget(mode: UnifiedAuthMode, next: unknown): string | null {
  if (mode !== 'on') return null;
  return sanitizeReturnTo(next);
}

export const DEFAULT_UNIFIED_ORIGINS = [
  'https://alrifai.iamazim.com',
  'https://app.al-rifai.iamazim.com',
] as const;

/**
 * Origin allowlist for state-changing unified-auth calls. Exact HTTPS match
 * only: no wildcard, no credentials, no path, no inherited Cash origin.
 */
export function originAllowed(origin: string | null | undefined, configured: string | null | undefined): boolean {
  if (typeof origin !== 'string' || !origin) return false;
  const list = (configured && configured.trim() ? configured : DEFAULT_UNIFIED_ORIGINS.join(','))
    .split(',')
    .map(entry => entry.trim())
    .filter(Boolean);
  return list.includes(origin);
}

/** True when a non-browser caller must receive 401 JSON rather than a redirect. */
export function prefersDocumentNavigation(headers: {get(name: string): string | null}): boolean {
  return headers.get('sec-fetch-dest') === 'document';
}

export function describeUnifiedAuthError(code: string): string {
  switch (code) {
    case 'SUPER_ADMIN_REQUIRED':
      return 'Only the configured Super Admin may perform this action.';
    case 'LAST_SUPER_ADMIN_PROTECTED':
      return 'The configured Super Admin account cannot be removed, demoted or deactivated.';
    case 'CAPABILITY_NOT_GRANTABLE':
      return 'That capability is bound to the configured Super Admin identity.';
    case 'CAPABILITY_ROLE_CONFLICT':
      return 'That capability requires an administrative role.';
    case 'CAPABILITIES_INVALID':
      return 'The capability list is not valid.';
    case 'USERNAME_UNCHANGED':
      return 'The new username is identical to the current username.';
    default:
      return 'Unified authentication action denied.';
  }
}
