# Production UI verification matrix — 2026-11-07

**Hosts:** `https://app.al-rifai.iamazim.com` (canonical),
`https://alrifai.iamazim.com` (legacy alias). `al-rifai.iamazim.com` and all
Cloudflare/DNS settings left unchanged (Cloudflare 1014 / HTTP 403 body).

**Status legend:** VERIFIED = read-only live check passed;
PARTIAL = route/protection verified but rendered functionality not observed;
FAILED = a defect was observed; NOT TESTED = requires an authenticated session.

**Blocking condition:** no plaintext password and no production session cookie
is available to the Agent (see `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`).
Owner selected a root-only VPS credentials file; it does not exist yet. Until
then every authenticated feature is NOT TESTED. No password was reset.

**Migration status:** NO MIGRATION (production schema `1.5.0`).

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
| Login with existing Admin/USER accounts | **NOT TESTED** | no plaintext password / production cookie |
| Logout | **NOT TESTED** | no session (clone-verified separately) |
| Session persistence | **NOT TESTED** | no session (clone-verified separately) |
| Admin/USER role separation, hidden/denied controls | **NOT TESTED** | production credentials unavailable; clone-tested on `7da17f1`/`675a3ef` |
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

1. Owner writes `/etc/vps/apps/al-rifai/verification-credentials.json`
   (`root:root`, `400`) via an interactive, non-echoing method.
2. Agent logs in on both hosts and re-runs this matrix with authenticated
   GET-only requests (no state-changing production action).
3. Agent deletes the credentials file.
4. Any state-changing operation is tested on the isolated clone unless the
   Owner separately authorises a specific production action.
