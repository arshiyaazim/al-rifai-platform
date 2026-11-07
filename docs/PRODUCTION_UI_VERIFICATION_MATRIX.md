# Production UI verification matrix — 2026-11-07

**Hosts:** `https://app.al-rifai.iamazim.com` (canonical),
`https://alrifai.iamazim.com` (legacy alias). `al-rifai.iamazim.com` and all
Cloudflare/DNS settings left unchanged (Cloudflare 1014 / HTTP 403 body).

**Status legend:** VERIFIED = Agent-side read-only live check passed;
OWNER-CONFIRMED = Owner asserts it works (not independently verified by the
Agent); PARTIAL = route/protection verified but rendered functionality not
observed; FAILED = a defect was observed; NOT TESTED = requires an authenticated
session the Agent does not have.

**OWNER CONFIRMATION (2026-11-07):** the Owner confirms all three existing
accounts — `Admin`, `officeassistant`, `officeazzistant2` — log in successfully
with their **current** passwords. **Authentication is operational, not broken.**
Corroborated by 8 `LOGIN` audit events (2 new at 15:21 / 15:24 UTC) and 4 live
sessions. No reset, replacement account, provisioning, hash/role/capability
change is required or was made.

**Blocking condition for AGENT-VERIFIED UI:** no plaintext password and no
production session cookie is available to the Agent
(`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`). The Owner selected a **root-only
production session cookie jar** as the minimum secure access; it does not exist
yet. Until then every authenticated feature is NOT TESTED (Agent). Keep the
OWNER-CONFIRMED / AGENT-VERIFIED distinction explicit.

**Migration status:** NO MIGRATION (production schema `1.5.0`,
`schema_migrations` max `009`).

---

## 1a. Minimum secure access + Owner-assisted procedure

Owner selected: **root-only session cookie jar** (least exposure, no password
handling).

1. Owner writes ONE valid `__Host-alrifai_cash` cookie for
   `app.al-rifai.iamazim.com` into
   `/etc/vps/apps/al-rifai/verification-session.cookies`
   (`root:root`, mode `400`, Netscape cookie-jar format). Never in chat, Git or
   docs.
2. Agent runs GET-only read-only checks with `curl -b <jar>` on both hosts,
   printing only derived non-secret evidence, then deletes the jar and temp
   output. No POST, no logout (logout revokes a session and requires separate
   explicit authorisation).
3. **Owner-assisted alternative:** Owner runs
   `scripts/owner-assisted-ui-verify.sh` themselves with their own cookie jar
   and shares only its non-secret output. The script is `bash -n` clean, prints
   no cookie/session body, and cleans its temp files with an EXIT trap.
   Run once per role to compare Admin vs USER controls.
4. The script covers: session validity, 27 routes × 2 hosts (status, `h1`,
   `<th>`, `<input>`, `<button>` counts), 4 nested URLs, 7 CSV exports,
   search/filter/pagination row counts, and role-sensitive control counts.
   It does **not** cover logout, approval workflows, form submissions, or
   human-observed dashboard cards/table contents — those need separate
   authorisation or human observation.
5. After verification the Owner deletes the cookie jar and the output file.

No password value is requested, printed, logged or committed at any point.

---

## 1. Unauthenticated surface (VERIFIED on both hosts)

41 routes were checked on each host. No route returned 500; all protected routes
returned `401` or `307 → /login`; `/login` returned 200; `/api/health` returned
`200 {"status":"ok","database":"ok","schemaVersion":"1.5.0"}`.

Routes checked: `/login`, `/dashboard`, `/cash`, `/cash/transactions`,
`/cash/archive`, `/cash/submissions`, `/submissions`, `/vessel`,
`/vessel/drafts`, `/register`, `/vessel-register`, `/vessel/register`,
`/vessel/vessel-register`, `/vessel/<program-id>`, `/employees`,
`/employees/<mobile>`, `/employee`, `/employee/<mobile>`,
`/transactions/employee/<mobile>`, `/transactions`, `/attendance`, `/reports`,
`/review`, `/income-expenditure`, `/archive`, `/conversations`,
`/message-mirror`, `/insights`, `/sources-review`, `/payroll`, `/settings`,
`/assistant`, `/messages`, `/api/health`, `/api/employees`, `/api/programs`,
`/api/reports?type=programs`, `/api/users`.

This proves route presence and protection only — **not** functional correctness.

## 2. Authentication and authorization

| Feature | Status | Evidence / blocker |
|---|---|---|
| Login page renders | VERIFIED | 200 on both hosts |
| Login API origin enforcement | VERIFIED | 403 `ORIGIN_DENIED` for invalid/missing Origin on both hosts |
| Login validation branch | VERIFIED | `400 CREDENTIALS_REQUIRED` for empty password; exact branch `lib/unified-auth.ts:118` |
| Session endpoint without cookie | VERIFIED | 401 `AUTHENTICATION_REQUIRED`, `mode:on` |
| Login with existing Admin/USER accounts | **OWNER-CONFIRMED** (Agent: NOT TESTED) | Owner confirms all three accounts work with current passwords; 8 `LOGIN` audit events, 4 live sessions; no Agent-side session |
| Logout | **NOT TESTED** | no Agent session; also state-changing — needs separate explicit authorisation (clone-verified separately) |
| Session persistence | **NOT TESTED** | no Agent session (clone-verified separately) |
| Admin/USER role separation, hidden/denied controls | **NOT TESTED** | no Agent session; clone-tested on `7da17f1`/`675a3ef` |
| Existing accounts retain original permissions | **VERIFIED** (read-only) | 3 accounts, roles ADMIN/USER/USER, valid hashes, effective capabilities 30/10/10, unchanged |
| CSRF / cookie / reverse-proxy behaviour | PARTIAL | code + read-only checks; cookie flags confirmed on clone |

## 3. Cash

| Feature | Status |
|---|---|
| Dashboard cards | **NOT TESTED** |
| Cash transactions, search, filters, pagination | **NOT TESTED** |
| Submissions and review | **NOT TESTED** |
| Cash archive | **NOT TESTED** |
| CSV exports | **NOT TESTED** (401 unauthenticated; clone returns `text/csv`) |
| Ledger / posting protections | **NOT TESTED** (read-only DB check: 1,586 legacy postings, 0 non-legacy postings) |
| Approval workflows | **NOT TESTED** (production state changes intentionally not attempted) |

## 4. Vessel

| Feature | Status |
|---|---|
| Vessel dashboard / register | **NOT TESTED** |
| Vessel Drafts page | **PARTIAL** — route present on deployed `7da17f1` (401 unauthenticated); content not observed |
| Program details | **NOT TESTED** |
| Escort assignment presentation | **NOT TESTED** |
| Release / confirmation status | **NOT TESTED** |
| DRAFT program records | **VERIFIED** (read-only DB): 8 live WA-01 `DRAFT` programs with source linkage |

## 5. Workforce and reports

| Feature | Status |
|---|---|
| Employees / employee profiles | **NOT TESTED** |
| Attendance | **NOT TESTED** |
| Payroll / payment history | **NOT TESTED** |
| Reports / Income & Expenditure / Historical archive | **NOT TESTED** |

## 6. Legacy compatibility

| Feature | Status |
|---|---|
| Independent nested URLs | PARTIAL — 17 legacy routes return 401/307 (present + protected) on both hosts, no 500; rendered content not observed |
| Navigation / menu links | **NOT TESTED** |
| Table columns, dashboard cards | **NOT TESTED** |
| Search / filters / forms / action buttons | **NOT TESTED** |
| CSV exports | **NOT TESTED** |

## 7. Clone-tested substitute evidence (NOT production)

On the isolated clone (`alrifai_v2_import_test`, images `7da17f1` and
`675a3ef`): 29 Admin routes + 12 USER routes + 17 legacy routes returned 200;
search/filters/pagination worked; 7 CSV exports returned `text/csv`; USER
received 403 for 11 privileged API actions; full WA-01 intake → DRAFT → draft
UI → Admin reply → `CONFIRMED` was verified. **These do not substitute for
production verification.**

## 8. Exact next step

1. Owner writes the root-only session cookie jar
   `/etc/vps/apps/al-rifai/verification-session.cookies` (`root:root`, `400`)
   with one valid production session, or runs
   `scripts/owner-assisted-ui-verify.sh` themselves and shares only its
   non-secret output.
2. Agent (or Owner) re-runs this matrix with authenticated GET-only requests
   on both hosts — no state-changing production action.
3. Jar/temp output deleted afterwards.
4. Logout, approval workflows and any state-changing operation are tested on
   the isolated clone unless the Owner separately authorises a specific
   production action.
5. Record the results as AGENT-VERIFIED (or OWNER-ASSISTED) rather than relying
   on the OWNER-CONFIRMED login statement.
