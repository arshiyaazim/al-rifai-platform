# Production authentication diagnosis — 2026-11-07

**Status:** NO code or configuration defect found. **NO credential was reset,
recreated, rehashed or re-permissioned.** Root cause of the unverified
authenticated UI: the Agent does not possess the plaintext passwords (or a
production session cookie), **not** invalid stored hashes or a broken pipeline.

**Migration status:** NO MIGRATION.

---

## 1. Root cause of the reported `400 CREDENTIALS_REQUIRED`

`lib/unified-auth.ts:110-138` — `loginWithCashCredential()`:

```text
114  if (!isEnabled()) throw UNIFIED_AUTH_DISABLED (404)   <- mode is "on"
115  requireUnifiedOrigin(request)                          <- origin allowlist
116  const username = typeof input.username === 'string' ? ... : ''
117  const password = typeof input.password === 'string' ? ... : ''
118  if (!username || !password) throw CREDENTIALS_REQUIRED (400)   <- EXACT BRANCH
119  checkLoginThrottle(username)
121  const row = await findUser(username)
122  if (!row || !(await verifyPassword(password, row.password_hash))) -> INVALID_CREDENTIALS (401)
126  createSession(request, row)
127  recordLoginSuccess(username)
128  audit(..., 'LOGIN', ...)
```

The earlier diagnostics sent `{"username":"Admin","password":""}` — an **empty
password**. Line 118 fires **before** throttle, user lookup, password
verification or session creation. Those 400 responses therefore prove only that
the request had missing credentials; they were **not genuine credential
submissions** and say nothing about the stored hashes.

The 0-byte files
`/etc/vps/apps/al-rifai/{admin-bootstrap-password,user-1-password,user-2-password}`
are read **only** by the provisioning CLIs (`scripts/standalone/provision-admin.mjs`,
`provision-users.mjs`, via `lib/env.mjs secret()`). No runtime/login path reads
them. They are provisioning inputs, not login credentials, and their emptiness
does **not** invalidate existing database hashes.

## 2. Pipeline trace (read-only evidence)

| Stage | Implementation | Verified |
|---|---|---|
| Browser form | `app/login/login-form.tsx` posts JSON `{username, password}` to `/api/auth/login`, `credentials: same-origin` | Field names correct |
| API route | `app/api/auth/[...path]/route.ts` POST `login` → `loginWithCashCredential()` | Both hosts return 400 for empty password, 403 for bad/missing Origin |
| Request validation | `lib/unified-auth.ts:118` | `CREDENTIALS_REQUIRED` only branch |
| Origin | `requireUnifiedOrigin()` → `originAllowed()` in `lib/unified-auth-policy.ts`; `ALRIFAI_UNIFIED_ORIGINS` contains both working hosts | 403 `ORIGIN_DENIED` for invalid/no Origin |
| Mode | `ALRIFAI_UNIFIED_AUTH_MODE=on` | `/api/auth/session` returns `"mode":"on"` even when unauthenticated |
| Credential lookup | `findUser()` → `SELECT * FROM cash_portal_users WHERE lower(username)=lower($1) AND active=true` | 3 active accounts |
| Password verification | `lib/password-hash.ts` `verifyPassword()` — PBKDF2-SHA256, 600000 iterations, constant-time | Clone: wrong password → 401 `INVALID_CREDENTIALS` |
| Session creation | `createSession()` → `cash_portal_sessions`; cookie `__Host-alrifai_cash` with `HttpOnly; Secure; SameSite=Strict; Max-Age=28800` | Clone: correct password → 200 + cookie + CSRF |
| Session persistence | `currentCsrf()` / `currentSession()` | Clone: session 200; logout → 200; session after logout → 401 |
| CSRF | `x-csrf-token` header vs `cash_portal_sessions.csrf_hash` (timing-safe) | Clone: CSRF present and used for mutations |
| Reverse proxy | `deploy/tls-entry.mjs` spreads all request headers and adds `x-forwarded-proto`/`x-forwarded-for` | Origin/Cookie forwarded intact |

## 3. Existing accounts and hashes are valid (no hash values exposed)

| Account | Role | Active | must_change_password | Hash present | Hash length | Format valid | Effective capabilities |
|---|---|---|---|---|---|---|---|
| `Admin` | ADMIN | yes | no | yes | 118 | yes | 30 (ADMIN defaults + 9 explicit grants) |
| `officeassistant` | USER | yes | no | yes | 118 | yes | 10 (USER defaults + 5 explicit grants) |
| `officeazzistant2` | USER | yes | no | yes | 118 | yes | 10 (USER defaults + 5 explicit grants) |

Format checked with a boolean regex
`^pbkdf2-sha256:600000:[a-f0-9]{32}:[a-f0-9]{64}$`; **no hash value was read,
printed or logged**. Effective capabilities were computed with the pure
`resolveCapabilities()` against the stored grants.

**Historical successful logins (production `cash_portal_audit`, action `LOGIN`,
surface `unified`):** 6 events, most recent **2026-11-07 13:40:16 UTC**;
`cash_portal_sessions` currently holds **2 unexpired sessions**. This is
definitive proof that the existing passwords work end-to-end on production.

## 4. Both hosts route authentication correctly

Controlled, **read-only** requests (empty password or invalid Origin; no throttle
rows created — `login_throttle_state` remained 0 before and after):

| Request | `app.al-rifai.iamazim.com` | `alrifai.iamazim.com` |
|---|---|---|
| valid Origin + empty password | `400 CREDENTIALS_REQUIRED` | `400 CREDENTIALS_REQUIRED` |
| valid Origin + non-empty password + invalid Origin | `403 ORIGIN_DENIED` | `403 ORIGIN_DENIED` |
| no Origin header | `403 ORIGIN_DENIED` | `403 ORIGIN_DENIED` |
| `GET /api/auth/session` without cookie | `401 AUTHENTICATION_REQUIRED`, `mode:on` | `401 AUTHENTICATION_REQUIRED`, `mode:on` |
| `/login` | 200 | 200 |
| `/api/health` | 200, schema 1.5.0 | 200, schema 1.5.0 |

A 400 (rather than 403/404/500) confirms the origin was accepted and the login
route was reached on both hosts.

## 5. Why the Agent still cannot complete authenticated verification

All saved cookie jars in `/tmp` were checked by hashing their token and matching
against `cash_portal_sessions.id`; **14 tokens were found but all 14 match only
the isolated clone DB** (`alrifai_v2_import_test`), **zero** match production.
No production session cookie is available to the Agent, and no plaintext
password is available.

**Conclusion:** no fix is required; no candidate image is required. Preserve the
existing passwords and hashes exactly.

## 6. Approved secure method to supply access (Owner chose this)

The Owner selected **root-only VPS credentials file**. The Agent does **not**
create this file and does **not** know its contents. Expected contract:

- Path: `/etc/vps/apps/al-rifai/verification-credentials.json`
- Owner / mode: `root:root`, `400`
- Format (no secret values in this document):
  ```json
  {"Admin":"<password>","officeassistant":"<password>","officeazzistant2":"<password>"}
  ```
- Owner writes it with an interactive, non-echoing method (e.g.
  `scripts/standalone/set-secret-password.mjs`-style prompt or a secure secret
  manager). **Never** in Git, documentation or ordinary chat.
- Agent reads it into memory only (never printed, never logged), performs the
  login/read-only UI matrix, then deletes the file.
- No reset, no hash change, no role/permission change, no new account.

As of this report the file does **not** exist; Task 3 therefore remains
**NOT TESTED** for all authenticated features.

## 7. Do-not-do list (all honoured)

- No password reset, no `provision-*.mjs --apply --reset-password`.
- No new/replacement account, no hash rewrite, no role or capability change.
- No secret value printed in logs, reports or Git.
- No production schema change or migration for authentication.
