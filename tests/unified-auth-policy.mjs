// Unified authentication policy regression tests (pure functions only).
//
// Covers the Owner-preservation invariants:
//   * the deployed cookie name is reused (no session invalidation),
//   * unknown configuration fails closed,
//   * Super Admin identity cannot be asserted by a client,
//   * grants can never mint workspace.admin or escalate a USER,
//   * post-login redirects cannot leave the application.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CAPABILITIES,
  DEFAULT_UNIFIED_ORIGINS,
  SESSION_COOKIE_NAME,
  UnifiedAuthError,
  assertCanEditCapabilities,
  assertNotRemovingLastSuperAdmin,
  assertSuperAdminIdentity,
  assertUsernameChange,
  hasCapability,
  isCashPortalPath,
  isConfiguredSuperAdmin,
  isSessionToken,
  isUnifiedAuthPublicPath,
  normalizeCapabilities,
  normalizeUsername,
  originAllowed,
  parseCookieHeader,
  prefersDocumentNavigation,
  resolveCapabilities,
  sanitizeReturnTo,
  signedInRedirectTarget,
  unifiedAuthMode,
  validateCapabilityRequest,
} from '../lib/unified-auth-policy.ts';

const OWNER = 'a'.repeat(64);
const OTHER_ADMIN = 'b'.repeat(64);
const denied = (code) => (error) => error instanceof UnifiedAuthError && error.code === code;

test('the deployed Cash session cookie name is reused verbatim', () => {
  assert.equal(SESSION_COOKIE_NAME, '__Host-alrifai_cash');
});

test('an absent or unknown mode fails closed to off', () => {
  assert.equal(unifiedAuthMode(undefined), 'off');
  assert.equal(unifiedAuthMode(null), 'off');
  assert.equal(unifiedAuthMode(''), 'off');
  assert.equal(unifiedAuthMode('enabled'), 'off');
  assert.equal(unifiedAuthMode('true'), 'off');
  assert.equal(unifiedAuthMode(' OFF '), 'off');
  assert.equal(unifiedAuthMode('shadow'), 'shadow');
  assert.equal(unifiedAuthMode('ON'), 'on');
});

test('session tokens must be the exact 64-hex opaque form', () => {
  assert.equal(isSessionToken('a'.repeat(64)), true);
  assert.equal(isSessionToken('a'.repeat(63)), false);
  assert.equal(isSessionToken('A'.repeat(64)), false);
  assert.equal(isSessionToken(`${'a'.repeat(64)} `), false);
  assert.equal(isSessionToken(123), false);
});

test('cookie parsing never accepts a renamed or malformed cookie', () => {
  const token = 'd'.repeat(64);
  assert.equal(parseCookieHeader(`other=1; __Host-alrifai_cash=${token}; x=2`), token);
  assert.equal(parseCookieHeader(`__Secure-alrifai_cash=${token}`), null);
  assert.equal(parseCookieHeader(`__Host-alrifai_cash=not-a-token`), null);
  assert.equal(parseCookieHeader(null), null);
  assert.equal(parseCookieHeader(''), null);
});

test('only the sign-in surface is public while unified auth is enabled', () => {
  assert.equal(isUnifiedAuthPublicPath('/login'), true);
  assert.equal(isUnifiedAuthPublicPath('/api/auth/login'), true);
  assert.equal(isUnifiedAuthPublicPath('/api/auth/session'), true);
  assert.equal(isUnifiedAuthPublicPath('/loginx'), false);
  assert.equal(isUnifiedAuthPublicPath('/api/authz'), false);
  assert.equal(isUnifiedAuthPublicPath('/dashboard'), false);
  assert.equal(isUnifiedAuthPublicPath('/admin'), false);
  assert.equal(isUnifiedAuthPublicPath('login'), false);
});

test('the Cash portal keeps its own session boundary', () => {
  assert.equal(isCashPortalPath('/cash'), true);
  assert.equal(isCashPortalPath('/cash/submissions'), true);
  assert.equal(isCashPortalPath('/api/cash'), true);
  assert.equal(isCashPortalPath('/api/cash/summary'), true);
  assert.equal(isCashPortalPath('/cashier'), false);
  assert.equal(isCashPortalPath('/dashboard'), false);
});

test('role defaults never imply workspace administration', () => {
  // RBAC-2B gave USER the staging capabilities: a USER may create or edit and
  // send the work to review, while the command capabilities stay Admin-only.
  assert.deepEqual(resolveCapabilities('USER', []),
    ['attendance.submit', 'cash.read', 'cash.submit', 'employee.submit', 'vessel.read', 'vessel.submit']);
  assert.equal(hasCapability({role: 'ADMIN'}, 'workspace.admin'), false);
  assert.equal(hasCapability({role: 'USER'}, 'workspace.admin'), false);
  assert.equal(hasCapability({role: 'USER'}, 'cash.review'), false);
  assert.equal(hasCapability({role: 'ADMIN'}, 'cash.review'), true);
  // Explicit grants are additive and unknown codes are ignored.
  assert.deepEqual(normalizeCapabilities(['cash.read', 'nonsense', 'cash.read', 7]), ['cash.read']);
  assert.equal(hasCapability({role: 'USER', capabilities: ['audit.read']}, 'audit.read'), true);
  // Nothing can grant cash posting: the capability does not exist.
  assert.equal(CAPABILITIES.includes('cash.post'), false);
});

test('Super Admin identity requires an allowlisted id and the ADMIN role', () => {
  assert.equal(isConfiguredSuperAdmin(OWNER, 'ADMIN', OWNER), true);
  assert.equal(isConfiguredSuperAdmin(OWNER, 'ADMIN', ` ${OWNER} , ${OTHER_ADMIN}`), true);
  assert.equal(isConfiguredSuperAdmin(OWNER, 'USER', OWNER), false);
  assert.equal(isConfiguredSuperAdmin(OTHER_ADMIN, 'ADMIN', OWNER), false);
  assert.equal(isConfiguredSuperAdmin(OWNER, 'ADMIN', ''), false);
  assert.equal(isConfiguredSuperAdmin(OWNER, 'ADMIN', undefined), false);
  assert.equal(isConfiguredSuperAdmin(OWNER, 'ADMIN', '*'), false);
  assert.equal(isConfiguredSuperAdmin('not-a-hash', 'ADMIN', 'not-a-hash'), false);
  assert.throws(() => assertSuperAdminIdentity({id: OTHER_ADMIN, role: 'ADMIN'}, OWNER), denied('SUPER_ADMIN_REQUIRED'));
  assert.doesNotThrow(() => assertSuperAdminIdentity({id: OWNER, role: 'ADMIN'}, OWNER));
});

test('capability grants require a Super Admin actor and never mint admin identity', () => {
  assert.throws(
    () => validateCapabilityRequest({role: 'ADMIN', superAdmin: false}, 'USER', ['vessel.read']),
    denied('SUPER_ADMIN_REQUIRED'),
  );
  assert.throws(
    () => validateCapabilityRequest({role: 'USER', superAdmin: true}, 'USER', ['vessel.read']),
    denied('ADMIN_REQUIRED'),
  );
  assert.throws(
    () => validateCapabilityRequest({role: 'ADMIN', superAdmin: true}, 'ADMIN', ['workspace.admin']),
    denied('CAPABILITY_NOT_GRANTABLE'),
  );
  assert.throws(
    () => validateCapabilityRequest({role: 'ADMIN', superAdmin: true}, 'USER', ['cash.review']),
    denied('CAPABILITY_ROLE_CONFLICT'),
  );
  assert.throws(
    () => validateCapabilityRequest({role: 'ADMIN', superAdmin: true}, 'ADMIN', 'vessel.read'),
    denied('CAPABILITIES_INVALID'),
  );
  assert.throws(
    () => validateCapabilityRequest({role: 'ADMIN', superAdmin: true}, 'ADMIN', ['vessel.read', 'made.up']),
    denied('CAPABILITIES_INVALID'),
  );
  assert.deepEqual(
    validateCapabilityRequest({role: 'ADMIN', superAdmin: true}, 'ADMIN', ['vessel.read', 'vessel.read']),
    ['vessel.read'],
  );
  assert.doesNotThrow(() => assertCanEditCapabilities({role: 'ADMIN', superAdmin: true}, 'USER'));
});

test('the configured Super Admin cannot be demoted or disabled, even by another admin', () => {
  const base = {
    targetId: OWNER,
    targetRole: 'ADMIN',
    targetActive: true,
    nextRole: 'ADMIN',
    nextActive: false,
    configuredIds: OWNER,
    activeConfiguredAdmins: 1,
  };
  assert.throws(() => assertNotRemovingLastSuperAdmin(base), denied('LAST_SUPER_ADMIN_PROTECTED'));
  assert.throws(() => assertNotRemovingLastSuperAdmin({...base, nextRole: 'USER', nextActive: true}), denied('LAST_SUPER_ADMIN_PROTECTED'));
  // A second configured Super Admin makes the change permissible.
  assert.doesNotThrow(() => assertNotRemovingLastSuperAdmin({...base, activeConfiguredAdmins: 2}));
  // Non-configured accounts are governed by the existing last-ADMIN policy only.
  assert.doesNotThrow(() => assertNotRemovingLastSuperAdmin({...base, targetId: OTHER_ADMIN}));
  // A no-op edit is always allowed.
  assert.doesNotThrow(() => assertNotRemovingLastSuperAdmin({...base, nextActive: true}));
});

test('username changes are explicit, validated and case-insensitive no-ops are refused', () => {
  assert.equal(normalizeUsername('  owner.one '), 'owner.one');
  assert.equal(normalizeUsername('ab'), undefined);
  assert.equal(normalizeUsername('has space'), undefined);
  assert.equal(normalizeUsername('semi;colon'), undefined);
  assert.equal(normalizeUsername('<script>'), undefined);
  assert.equal(normalizeUsername(42), undefined);
  assert.throws(() => assertUsernameChange('Admin', 'admin'), denied('USERNAME_UNCHANGED'));
  assert.doesNotThrow(() => assertUsernameChange('Admin', 'Owner'));
});

test('post-login redirects cannot leave the application', () => {
  assert.equal(sanitizeReturnTo('/dashboard'), '/dashboard');
  assert.equal(sanitizeReturnTo('/vessel-register?tab=programs#top'), '/vessel-register?tab=programs#top');
  assert.equal(sanitizeReturnTo('/admin'), '/admin');
  for (const hostile of [
    'https://evil.example/login',
    '//evil.example',
    '/\\evil.example',
    'javascript:alert(1)',
    '/dashboard/../../../etc/passwd',
    '/api/cash/summary',
    '/login',
    '/cash',
    'dashboard',
    '',
    null,
    undefined,
    42,
    `/${'a'.repeat(600)}`,
    '/%2e%2e%2f%2e%2e%2fetc',
  ]) {
    assert.equal(sanitizeReturnTo(hostile), '/dashboard', `expected fallback for ${String(hostile)}`);
  }
  assert.equal(sanitizeReturnTo('/vessel', '/dashboard'), '/vessel');
});

test('state-changing unified calls require one of the exact configured HTTPS origins', () => {
  assert.equal(originAllowed('https://alrifai.iamazim.com', undefined), true);
  assert.equal(originAllowed('https://app.al-rifai.iamazim.com', undefined), true);
  assert.equal(originAllowed('https://alrifai.iamazim.com', 'https://app.al-rifai.iamazim.com'), false);
  assert.equal(originAllowed('https://alrifai.iamazim.com/', undefined), false);
  assert.equal(originAllowed('http://alrifai.iamazim.com', undefined), false);
  assert.equal(originAllowed('null', undefined), false);
  assert.equal(originAllowed(undefined, undefined), false);
  assert.equal(originAllowed('https://evil.example', undefined), false);
  assert.deepEqual([...DEFAULT_UNIFIED_ORIGINS], ['https://alrifai.iamazim.com', 'https://app.al-rifai.iamazim.com']);
});

test('only document navigations are redirected to the sign-in page', () => {
  const headers = (value) => ({get: (name) => (name === 'sec-fetch-dest' ? value : null)});
  assert.equal(prefersDocumentNavigation(headers('document')), true);
  assert.equal(prefersDocumentNavigation(headers('empty')), false);
  assert.equal(prefersDocumentNavigation(headers(null)), false);
});

test('a signed-in visitor is only forwarded when the session authorises the workspace', () => {
  // Regression: 2026-10-28 ERR_TOO_MANY_REDIRECTS. Forwarding an authenticated
  // visitor out of /login in shadow mode produced /login 307 -> /dashboard 302
  // -> /login 307 ... because shadow never authorises a protected route.
  assert.equal(signedInRedirectTarget('shadow', '/dashboard'), null);
  assert.equal(signedInRedirectTarget('shadow', '/admin'), null);
  assert.equal(signedInRedirectTarget('off', '/dashboard'), null);
  assert.equal(signedInRedirectTarget('on', '/dashboard'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', '/admin'), '/admin');
  // Destination sanitisation is unchanged in the only mode that redirects.
  assert.equal(signedInRedirectTarget('on', 'https://evil.example/x'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', '//evil.example'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', '/login'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', '/cash'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', '/api/auth/session'), '/dashboard');
  assert.equal(signedInRedirectTarget('on', undefined), '/dashboard');
  // Unknown configuration stays fail-closed.
  assert.equal(signedInRedirectTarget(unifiedAuthMode('unknown'), '/dashboard'), null);
  assert.equal(signedInRedirectTarget(unifiedAuthMode(undefined), '/dashboard'), null);
});
