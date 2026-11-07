# AL-RIFA'I Phase 3 — Project Knowledge Base

**Last verified:** 2026-11-07
**Production runtime:** `local/al-rifai-platform:phase3-ai-rc-86d659a`
**Candidate (not deployed):** `phase3-ai-rc-9e85e49`
**Database schema:** `1.5.0`
**Git `main`:** includes docs merge `9fcc2e7` (runtime release `86d659a`)

This file is the permanent orientation map. It records where things live, what
is verified, what is not, and where the next operator starts. It contains no
secret values. Update it whenever a feature, route, table or deployment fact
changes.

---

## 1. Repository and application layout

| Path | Role |
|---|---|
| `/opt/al-rifai-platform` | Canonical Git checkout on `main` (release merges) |
| `/opt/al-rifai-phase3-test` | Working tree / feature branch `feature/phase3-router-cash-vessel` used to build candidates |
| `/opt/vps/al-rifai-standalone/apps/al-rifai` | Production deploy directory for the `al-rifai-phase3` Compose project |
| `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` | Production configuration (mode 600, root) |
| `/etc/vps/apps/al-rifai/` | TLS key pair and root-only password files |
| `/var/lib/vps/al-rifai/media` | Captured WhatsApp media (read-only in the app) |
| `/var/lib/vps/al-rifai/backups/` | Database backups |
| `/etc/vps/services/whatsapp/` | Bridge consumer-policy JSON files (token hashes only) |

Application structure inside the repo:

| Path | Contents |
|---|---|
| `app/(workspace)/…` | Authenticated business pages (all menu routes) |
| `app/api/…` | Authenticated JSON APIs |
| `app/login/` | Login screen and client form |
| `components/standalone/…` | Phase 3 UI components (server + a few client components) |
| `lib/standalone/…` | Business services and persistence (Cash, Vessel, Employees, Attendance, Review, Users, Audit) |
| `lib/ai/…` | WA-02 AI engine, tools, sender, worker (default disabled) |
| `lib/message-router.ts` | Single canonical WhatsApp → business-record router |
| `lib/phase3-router-worker.ts` | Optional continuous router loop |
| `lib/order-draft-template.ts` | Exact Owner draft layout (pure) |
| `lib/order-draft-from-record.ts` | Program/review record → Owner draft projection (pure) |
| `db/standalone/…` | Incremental SQL migrations |
| `scripts/standalone/…` | Explicit CLI operations (migrate, provision, secrets, grants) |
| `scripts/sync-worker.mjs` | Read-only WhatsApp SQLite → PostgreSQL mirror |
| `tests/standalone/…` | Integration + pure unit tests |
| `docs/…` | Operational and decision documentation |

**Deployment services** (`compose.yaml` + `compose.phase3.yaml`, project
`al-rifai-phase3`):

| Service | Command | Ports | Notes |
|---|---|---|---|
| `app` | `node deploy/tls-entry.mjs` | `0.0.0.0:443→3443`, `127.0.0.1:3001→3000` | TLS entry + Next.js, non-root, read-only FS |
| `sync` | `node scripts/sync-worker.mjs --mode=tail` | none | Root, read-only bridge SQLite access |
| `backend` (infra project) | `postgres:16-alpine` | internal `172.18.0.2:5432` | `vps-infra-postgres-1` |

---

## 2. Feature-to-file and module ownership

| Feature | Primary files | Verified state |
|---|---|---|
| **Dashboard** | `app/(workspace)/dashboard/page.tsx` | Working (production, authenticated check pending credentials) |
| **Cash control** | `app/(workspace)/cash/page.tsx`, `cash/[id]/page.tsx`, `lib/standalone/finance.ts`, `app/api/finance/route.ts` | Working; REVIEW → APPROVED → POSTED → reversal; no new postings created in tests |
| **Cash transactions/archive/submissions** | `components/standalone/cash-transactions-view.tsx`, `cash-submissions-view.tsx`, routes under `app/(workspace)/cash/…` | Candidate pages, 200 authenticated on clone |
| **Vessel register/control** | `app/(workspace)/vessel/page.tsx`, `vessel/[id]/page.tsx`, `lib/standalone/programs.ts`, `app/api/programs/route.ts` | Working; date-rendering bug fixed in `9e85e49` |
| **Vessel order draft** | `lib/order-draft-template.ts`, `lib/order-draft-from-record.ts`, `components/standalone/owner-draft-panel.tsx`, `app/(workspace)/vessel/drafts/page.tsx` | **New in candidate**; copy-only, no outbound |
| **Vessel release** | `lib/release-slip.ts`, `lib/release-scan.ts`, `lib/release-apply.ts`, `lib/message-router.ts` (`handleReleaseSlip`) | Partial: structured slips apply; unstructured slips go to review |
| **Employees** | `app/(workspace)/employees/…`, `employee/…`, `lib/standalone/employees.ts`, `app/api/employees/route.ts` | Working |
| **Attendance** | `app/(workspace)/attendance/page.tsx`, `lib/standalone/attendance.ts`, `app/api/attendance/route.ts` | Working |
| **Payroll** | `app/(workspace)/payroll/page.tsx`, `lib/standalone/payroll.ts`, `app/api/payroll/route.ts` | Read/report working; generation remains explicit |
| **Review Queue** | `app/(workspace)/review/…`, `lib/standalone/review.ts`, `app/api/review/route.ts` | Working; PROGRAM items now show the Owner draft |
| **WhatsApp inbox / mirror / conversations** | `app/(workspace)/messages`, `message-mirror`, `conversations`, `lib/standalone/messages.ts`, `app/api/messages/route.ts` | Read-only mirror working |
| **AI Assistant (Admin)** | `app/(workspace)/assistant/page.tsx`, `components/standalone/assistant-console.tsx`, `app/api/assistant/route.ts` | Working, grounded read-only queries |
| **WA-02 AI worker/sender** | `lib/ai/*`, `app/api/whatsapp/route.ts` | Present but disabled (`AI_WA02_ENABLED=0`, `AI_OUTBOUND_ENABLED=0`) |
| **Auth / users** | `app/api/auth/[...path]/route.ts`, `lib/standalone/session.ts`, `lib/standalone/authz.ts`, `lib/standalone/users.ts`, `scripts/standalone/provision-admin.mjs`, `provision-users.mjs` | Production passwords still unavailable |
| **Health** | `app/api/health/route.ts` | `{"status":"ok","database":"ok","schemaVersion":"1.5.0"}` |

---

## 3. API endpoints

| Endpoint | Purpose | Auth |
|---|---|---|
| `POST /api/auth/login` | Username/password login (PBKDF2) | Public + origin check |
| `/api/auth/[...path]` | Session, logout, current user | Session |
| `GET /api/health` | Liveness + DB + schema version | Public |
| `/api/finance` | Cash instructions, posting, reversal, reconciliation | Capability-checked |
| `/api/programs` | Vessel program create/update/assign/start/release | `vessel.command` / `vessel.release` |
| `/api/employees` | Employee directory/profile | Session |
| `/api/attendance` | Attendance read/write | Session/capability |
| `/api/payroll` | Payroll read/generate | Session/capability |
| `/api/review` | Review decisions/corrections | Reviewer capability |
| `/api/messages` | Message/chat reads | Session |
| `/api/media` | Captured media streaming | Session |
| `/api/reports` | CSV exports | Session |
| `/api/users` | User administration | Super Admin |
| `/api/assistant` | Grounded Admin queries | Admin |
| `/api/whatsapp` | Bridge/AI administration | Admin |

No API endpoint is redirected. No state-changing request is accepted from an
unlisted origin.

---

## 4. Workflows

### Cash
1. WA-01 Admin writes a payout message in the authorized Accountant conversation.
2. Router verifies account, sender, chat purpose, allowlist and cutover rowid.
3. Creates a `cash_instructions` row in `REVIEW` with source evidence.
4. Admin approves → `APPROVED`; posts → `POSTED` + ledger entry; reverse creates an immutable reversal.
5. Nothing posts automatically.

### Vessel order (current + corrected candidate)
1. WA-01 authorized order message above the cutover rowid.
2. `parseEscortOrder` extracts Mother Vessel, Lighter Vessel, Master Mobile, destination, date/shift.
3. Router creates a `programs` row in `DRAFT` (duplicates/missing fields → Review Queue).
4. **Candidate:** `/vessel/drafts` and the program/review detail render the exact Owner draft for the Admin to copy.
5. Admin sends the draft + escort assignment reply from the existing WhatsApp client.
6. Router sees the Admin's outgoing reply and `applyConfirmation()` sets `ASSIGNED`.
7. Release slip later sets `RELEASED`.

**Not implemented:** automatic delivery of the draft to WhatsApp (no approved outbound sender).

### Attendance / Payroll
Attendance rows are recorded per employee/date/shift; payroll reads attendance and
program pay. Neither is generated automatically from WhatsApp.

### WA-02 AI
Identity-read only in production. Worker/sender are disabled; `ai_outbound_messages`
accepts `account_id='wa-02'` only. WA-02 outbound must not be enabled without explicit
Owner authorization.

---

## 5. Database

Phase 3 database: `alrifai_v2_phase3` (46 public base tables).

| Group | Tables |
|---|---|
| Identity/auth | `cash_portal_users`, `cash_portal_sessions`, `cash_portal_audit`, `login_throttle_state`, `identity_aliases` |
| Cash | `cash_accounts`, `cash_instructions`, `cash_postings`, `cash_reversals`, `cash_reconciliations`, `cash_submissions`, `cash_submission_reviews`, `ledger_entries` |
| Vessel | `programs`, `program_assignments`, `program_pay`, `program_events`, `program_source_messages`, `rate_config`, `escort_client_group_authorizations` |
| Employee/attendance | `employees`, `attendance` |
| Review/audit | `review_items`, `review_decisions`, `audit_events` |
| WhatsApp | `whatsapp_accounts`, `whatsapp_chats`, `whatsapp_messages`, `whatsapp_media`, `whatsapp_cursors`, `whatsapp_sync_state`, `whatsapp_import_runs` |
| AI (WA-02) | `ai_contacts`, `ai_conversations`, `ai_messages`, `ai_tool_runs`, `ai_order_drafts`, `ai_applicant_drafts`, `ai_outbound_messages`, `ai_outbound_attempts`, `ai_escalations`, `ai_admin_jids`, `ai_job_catalog` |
| System | `app_settings`, `schema_meta`, `schema_migrations` |

**Hard database constraints relevant to drafts:**
- `ai_order_drafts.account_id` and `ai_outbound_messages.account_id` allow **only `wa-02`**.
  They cannot carry a WA-01 vessel draft.
- `programs.master_mobile` must be a valid `01[3-9]XXXXXXXXX`.
- `programs` unique identity on `(mother, lighter, start_date)` where state ≠ `VOIDED`.
- `review_items.category` is a fixed enum; release payloads currently use
  `EXTRACTION_FAILED` with `payload.releaseCategory` describing the release issue.

Legacy database: `alrifai` (75 public base tables). Legacy mappings and unmapped
tables are recorded in `docs/LEGACY_PHASE3_COMPARISON.md`.

**Migration status:** schema `1.5.0` applied and verified in production. No new
migration was added by the vessel-draft work. Migrations are applied only by an
explicit CLI run, never at application startup.

---

## 6. Production domains, URLs and ports

| Host | Certificate | State |
|---|---|---|
| `https://app.al-rifai.iamazim.com` | SAN `app.al-rifai.iamazim.com` | Canonical; working (HTTP 200 health) |
| `https://alrifai.iamazim.com` | SAN `alrifai.iamazim.com` | Working legacy alias; origin allowed; login returns 401 until credentials exist |
| `https://al-rifai.iamazim.com` | none | **Broken 1014**; CNAME to a foreign Cloudflare account. Requires Owner DNS decision |

- Origin IP `5.189.131.48`; app publishes `0.0.0.0:443` (TLS entry) and `127.0.0.1:3001`.
- Certificates: `/etc/vps/apps/al-rifai/tls/private-entry.{crt,key}`. Certbot uses
  the `standalone` method, so SAN extension needs port 80.
- Do not change DNS, proxy or certificates without Owner approval.

---

## 7. Configuration and credential locations

**Configuration:** `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` (mode 600 root).
Non-secret names are documented in `.env.example`.

Key groups:
- Database: `PGHOST`, `PGPORT`, `PGDATABASE`, `PGUSER`, `PGPASSWORD`, `PGSCHEMA`
- App identity/URLs: `ALRIFAI_APP_NAME`, `ALRIFAI_PUBLIC_BASE_URL`, `ALRIFAI_CANONICAL_HOST`, `ALRIFAI_LEGACY_HOSTS`, `ALRIFAI_INTERNAL_BASE_URL`, `ALRIFAI_UNIFIED_ORIGINS`, `ALRIFAI_CASH_ORIGIN`
- Bootstrap/users: `ALRIFAI_BOOTSTRAP_ADMIN_*`, `ALRIFAI_APP_USER_1_*`, `ALRIFAI_APP_USER_2_*`
- Router/sync: `PHASE3_ROUTER_WORKER_ENABLED`, `ALRIFAI_VESSEL_PROCESSING_ENABLED`, `ALRIFAI_LIVE_CASH_SYNC`, `SYNC_*`, `WA01_*`, `WA02_*`
- AI (disabled): `AI_WA02_ENABLED`, `AI_OUTBOUND_ENABLED`, `AI_AUTO_REPLY_ENABLED`, `AI_LLM_*`

**Credentials:** password files are root-only, mode `400`, currently **0 bytes**
(re-checked 2026-11-07 after the docs update):
- `/etc/vps/apps/al-rifai/admin-bootstrap-password`
- `/etc/vps/apps/al-rifai/user-1-password`
- `/etc/vps/apps/al-rifai/user-2-password`

Authorized operators write them with:
```bash
node --experimental-strip-types scripts/standalone/set-secret-password.mjs \
  --file=/etc/vps/apps/al-rifai/admin-bootstrap-password
```
Then run the check-only provisioners; `--apply` / `--reset-password` only with
explicit Owner approval. Never paste passwords into chat, docs or Git.

Bridge API tokens exist only as SHA-256 hashes in
`/etc/vps/services/whatsapp/*-consumer-policy.json`. Plaintext tokens are not in
the repository or this document.

---

## 8. WhatsApp bridge map (verified 2026-11-07)

| Item | WA-01 | WA-02 |
|---|---|---|
| Container | `vps-whatsapp-wa-01-cap4-20261011` | `vps-whatsapp-wa-02-cap4-20261011` |
| Identity | `8801880446111@s.whatsapp.net` | `8801958122300@s.whatsapp.net` |
| Policy consumer | `wa-01-owner-reader` (messages.read, contacts.read, media.read/download, calls.read); `alrifai-wa-01-native-reader` (native.* read); `alrifai-wa-01-call-agent` | `wa-02-owner-reader` (`native.identity.read` only) |
| Send capability | **none** | **none** |
| Phase 3 business chats | 9 allowlisted chats (orders, cash, release group) | `[]` |
| Cutover rowid | `19634` | `15184` |
| Router | processes messages above watermark only | no business chats |
| AI | not enabled | worker/sender disabled |

The `sync` service reads each bridge `messages.db` read-only. No bridge container,
session, checkpoint or allowlist may be restarted, re-paired or reconfigured.

---

## 9. Current feature status and issue queue

### Verified working
- Health and schema `1.5.0`.
- 218 employees, 94 programs, 439 attendance rows.
- Cash: 1,586 POSTED (85,225,900 minor), 2,221 REVIEW, 1,586 postings.
- 8 live Cash instructions created from 8 real Admin→Accountant messages (335,000 minor), zero postings.
- Router processes above-watermark allowlisted messages.
- All 32 candidate routes return 200 with an authenticated clone Admin session.
- Owner draft renders exactly and blocks on missing fields.

### Active issues by priority

| # | Severity | Issue | Next step |
|---|---|---|---|
| 1 | High | Production Admin/user logins unverified: password files are empty | Owner writes passwords, then run check-only provisioners |
| 2 | High | Vessel draft auto-delivery absent | Owner decision: approve an outbound sender/destination, or keep copy-only |
| 3 | High | Unstructured release/cancel/food-bill messages cannot be parsed | Design a release parser extension; keep them in review until then |
| 4 | Medium | `al-rifai.iamazim.com` returns Cloudflare 1014 | Owner DNS/Cloudflare decision (`docs/DNS_CLOUDFLARE_1014.md`) |
| 5 | Medium | Candidate `9e85e49` not deployed | Owner approval + deploy/rollback plan |
| 6 | Medium | Legacy tables not migrated (site settlements, reconciliation workspace, Excel cashbook, public site) | Separate Owner-approved mapping |
| 7 | Low | Legacy employee typeahead and add-transaction drawer not reproduced | Decide whether to reimplement |
| 8 | Low | Legacy insight/income charts replaced by tables | Accept or reimplement charts |

### Resolved (retained for history)
- Legacy generic redirects replaced by 19 independent pages.
- Nested employee route 500 (`created_at.slice`) fixed.
- Vessel program detail 500 (`[object Date]`) fixed in `9e85e49`.
- Legacy-host `403 ORIGIN_DENIED` fixed by origin allowlist.
- Admin/user login throttles cleared; provisioning is explicit CLI only.
- `provision-admin` / `provision-users` / `set-secret-password` implemented and clone-verified.

---

## 10. Change log (recent)

| Commit | Change |
|---|---|
| `3c653c8` | Explicit Admin provisioning |
| `6a988e6` | Legacy redirects + assistant UI + user provisioning (redirects later replaced) |
| `2e57278` | Independent legacy menu pages |
| `169faa3` | Employee payment date fix |
| `5aa691f` | Legacy vs Phase 3 comparison |
| `1f73709` | Owner order-draft projection + `/vessel/drafts` |
| `9e85e49` | `getProgram` returns ISO dates; program detail 500 fixed |

---

## 11. Exact next starting point

1. Confirm the three password files are non-empty; run:
   `provision-admin.mjs` (check) and `provision-users.mjs` (check).
2. If valid, perform real login/session/role checks and read-only authenticated
   verification of Cash, Vessel, Employee, Attendance and Reports.
3. Obtain Owner approval to deploy candidate `9e85e49`; verify `/vessel/drafts`.
4. Decide the vessel-draft transport: manual copy (current) or approved outbound.
5. Fix release/cancel parsing for unstructured release-group messages.
