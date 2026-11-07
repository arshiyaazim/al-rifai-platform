# Production authentication diagnosis — 2026-11-07

**Status:** NO code or configuration defect found. **NO credential was reset,
recreated, rehashed or re-permissioned.** Root cause of the unverified
authenticated UI: the Agent does not possess the plaintext passwords (or a
production session cookie), **not** invalid stored hashes or a broken pipeline.

**OWNER-CONFIRMED (2026-11-07):** the Owner confirms all three existing
accounts — `Admin`, `officeassistant`, `officeazzistant2` — successfully log in
with their **current** passwords. Authentication is operational from the
Owner's perspective. No reset, replacement account, provisioning, hash/role or
capability change is required. This is **OWNER-CONFIRMED**, distinct from
**AGENT-VERIFIED** authenticated UI functionality, which remains pending until
the Agent independently completes it with a session.

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
surface `unified`):** **8 events** — 6 earlier plus 2 new ones at
**2026-11-07 15:21:51 UTC** and **15:24:28 UTC** matching the Owner's
confirmation logins. `cash_portal_sessions` holds **4 unexpired sessions**.
Together with the Owner's explicit confirmation this is definitive proof that
the existing passwords work end-to-end on production.

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

## 5. Why AGENT-VERIFIED authenticated UI is still pending

**Authentication itself is NOT broken** — the Owner has confirmed all three
accounts work and the audit evidence (§3) proves it. What is missing is only
Agent-side access to an authenticated session:

- All saved cookie jars in `/tmp` were checked by hashing their token and
  matching against `cash_portal_sessions.id`; **15 tokens were found but all 15
  match only the isolated clone DB** (`alrifai_v2_import_test`), **zero** match
  production, even after the Owner's 2 new logins.
- No plaintext password is available to the Agent, and no credentials file or
  session cookie jar has been placed on the VPS.

**Conclusion:** no fix, no reset, no candidate image is required. Preserve the
existing passwords and hashes exactly. Keep the status distinction:
**OWNER-CONFIRMED login** (done) vs **AGENT-VERIFIED authenticated UI**
(pending).

## 6. Minimum secure access requested (Owner chose this)

The Owner selected **root-only production session cookie jar** — least exposure,
no password handling. The Agent does **not** create this file and never sees the
cookie value in any output.

- Path: `/etc/vps/apps/al-rifai/verification-session.cookies`
- Owner / mode: `root:root`, `400`; Netscape cookie-jar format with ONE valid
  `__Host-alrifai_cash` cookie for `app.al-rifai.iamazim.com`.
- Owner writes it from their already-authenticated browser session; **never** in
  Git, documentation or ordinary chat.
- Agent uses `curl -b <jar>` for **GET-only** read-only checks, prints only
  derived non-secret evidence (status codes, headings, table/input/button
  counts, CSV content-type/size), then deletes the jar and all temp output.
- No reset, no hash change, no role/permission change, no new account, no POST,
  no logout (logout revokes a session and needs separate explicit authorisation).

**Structured Owner-assisted alternative:** if the Owner prefers not to hand over
even a cookie jar, they can run
`scripts/owner-assisted-ui-verify.sh` themselves with their own cookie jar and
share only its non-secret output. The script is `bash -n` clean and contains no
secret values. Both paths are documented in
`docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` §1.

As of this report the jar does **not** exist; all authenticated features remain
**NOT TESTED (Agent)** while login is **OWNER-CONFIRMED**.

## 7. Do-not-do list (all honoured)

- No password reset, no `provision-*.mjs --apply --reset-password`.
- No new/replacement account, no hash rewrite, no role or capability change.
- No secret value printed in logs, reports or Git.
- No production schema change or migration for authentication.
