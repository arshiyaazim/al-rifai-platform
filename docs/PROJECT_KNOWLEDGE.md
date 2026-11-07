# AL-RIFA'I Phase 3 — Project Knowledge Base

**Last verified:** 2026-11-07
**Production runtime (deployed):** `local/al-rifai-platform:phase3-ai-rc-86d659a` (`sha256:932ef856…`)
**Superseded candidate (not deployed):** `phase3-ai-rc-9e85e49` (`sha256:cb8de252…`)
**Current candidate (built, clone-tested, not deployed):** `phase3-ai-rc-7da17f1` (`sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa`)
**Database schema:** `1.5.0` (production and clone); no migration added
**Git `main`:** `0861e05` (docs merge); code fixes live on `feature/phase3-router-cash-vessel` at `7da17f1`, pushed

Evidence labels used throughout: **clone-tested**, **production-deployed**,
**live-verified**. Production UI login remains unverified (empty password files).

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
| `lib/message-router.ts` | Single canonical WhatsApp → business-record router, including release-group evidence handling |
| `lib/release-slip.ts` | Pure structured Escort Release parser + unstructured cancellation/replacement/food-bill evidence parser |
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
| **Cash control** | `app/(workspace)/cash/page.tsx`, `cash/[id]/page.tsx`, `lib/standalone/finance.ts`, `app/api/finance/route.ts` | Working; REVIEW → APPROVED → POSTED → reversal; no new postings created in tests. Privileged forms are capability-gated in `7da17f1` |
| **Cash transactions/archive/submissions** | `components/standalone/cash-transactions-view.tsx`, `cash-submissions-view.tsx`, routes under `app/(workspace)/cash/…` | 200 on clone; role-checked |
| **Vessel register/control** | `app/(workspace)/vessel/page.tsx`, `vessel/[id]/page.tsx`, `lib/standalone/programs.ts`, `app/api/programs/route.ts` | Working; date-rendering bug fixed in `9e85e49`; `assignEscort` resolves the directory name in `7da17f1`; list-page forms capability-gated |
| **Vessel order draft** | `lib/order-draft-template.ts`, `lib/order-draft-from-record.ts`, `components/standalone/owner-draft-panel.tsx`, `app/(workspace)/vessel/drafts/page.tsx` | Copy-only, no outbound. Full intake → DRAFT → draft UI → Admin reply → CONFIRMED verified on clone `7da17f1`; production has 8 live DRAFT programs |
| **Vessel release** | `lib/release-slip.ts`, `lib/message-router.ts` (`handleReleaseSlip`, `matchUnstructuredReleaseCandidates`) | Structured slips apply to one match; unstructured release-group traffic is parsed into pending review evidence with read-only candidate matching (`7da17f1`) — never auto-releases |
| **Employees** | `app/(workspace)/employees/…`, `employee/…`, `lib/standalone/employees.ts`, `app/api/employees/route.ts` | Working |
| **Attendance** | `app/(workspace)/attendance/page.tsx`, `lib/standalone/attendance.ts`, `app/api/attendance/route.ts` | Working |
| **Payroll** | `app/(workspace)/payroll/page.tsx`, `lib/standalone/payroll.ts`, `app/api/payroll/route.ts` | Read/report working; generation remains explicit |
| **Review Queue** | `app/(workspace)/review/…`, `lib/standalone/review.ts`, `lib/review-ui.ts`, `app/api/review/route.ts` | Working; PROGRAM items show the Owner draft; `7da17f1` adds cancel date/shift, total days and food-bill (paisa) evidence fields |
| **WhatsApp inbox / mirror / conversations** | `app/(workspace)/messages`, `message-mirror`, `conversations`, `lib/standalone/messages.ts`, `app/api/messages/route.ts` | Read-only mirror working |
| **AI Assistant (Admin)** | `app/(workspace)/assistant/page.tsx`, `components/standalone/assistant-console.tsx`, `app/api/assistant/route.ts` | Working, grounded read-only queries |
| **WA-02 AI worker/sender** | `lib/ai/*`, `app/api/whatsapp/route.ts` | Present but disabled (`AI_WA02_ENABLED=0`, `AI_OUTBOUND_ENABLED=0`) |
| **Settings / integrations** | `app/(workspace)/settings/page.tsx`, `app/api/whatsapp/route.ts` | Account/relay forms capability-gated in `7da17f1` (`cash.account.manage`, `whatsapp.manage`, `whatsapp.route`) |
| **Auth / users** | `app/api/auth/[...path]/route.ts`, `lib/standalone/session.ts`, `lib/standalone/authz.ts`, `lib/standalone/users.ts`, `scripts/standalone/provision-admin.mjs`, `provision-users.mjs` | Production passwords still unavailable (0-byte files); no authenticated production UI verification |
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

### Vessel order (verified end-to-end on clone `7da17f1`)

1. WA-01 authorized order message above the cutover rowid.
2. `parseEscortOrder` extracts Mother Vessel, Lighter Vessel, Master Mobile,
   destination, date/shift.
3. Router creates a `programs` row in `DRAFT` (duplicates/missing fields → Review Queue).
4. `/vessel/drafts` and the program/review detail render the exact Owner draft for
   the Admin to copy (`MANUAL_COPY_ONLY`, blank escort fields).
5. Admin sends the draft + escort assignment reply from the existing WhatsApp client.
6. Router sees the Admin's outgoing reply and `applyConfirmation()` assigns the
   escort, sets state `CONFIRMED` and records `confirmation_message_id`.
7. A structured release slip later sets `RELEASED`; ambiguous/incomplete slips go
   to review and never release a program.

**Not implemented:** automatic delivery of the draft to WhatsApp (no approved outbound sender).
Production has 8 live WHATSAPP `DRAFT` programs created on 2026-11-07, so intake
is active; the missing stage is transport, not parsing or persistence.

### Unstructured release-group evidence (`7da17f1`)

1. A release-group message that is not a structured Escort Release slip.
2. `parseUnstructuredRelease()` classifies `EMPTY`, `CANCELLATION`,
   `REPLACEMENT`, `FOOD_BILL` or `OTHER`, extracting vessel, escort, mobile,
   date/shift, cancel date/shift, total days and food bill (paisa).
3. `matchUnstructuredReleaseCandidates()` matches at most 10 programs read-only
   by escort mobile, then lighter vessel, then mother vessel.
4. A **pending** `EXTRACTION_FAILED` review item is written with
   `extractedFields`, `evidenceKinds`, `matchedTokens`, `candidateProgramIds`,
   `candidateMatchedBy` and reasons; `releaseCategory` becomes
   `RELEASE_CANCELLATION_CANDIDATE`, `RELEASE_REPLACEMENT_CANDIDATE`,
   `RELEASE_FOOD_BILL_CANDIDATE`, `RELEASE_EMPTY_MESSAGE` or
   `RELEASE_UNSTRUCTURED`.
5. **No program is released, voided, completed or otherwise updated**, and no
   cash posting is created. Ambiguous cases stay for manual review.
6. The 7 existing production `RELEASE_UNSTRUCTURED` items are historical and are
   not retroactively rewritten.

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
- `review_items.category` is a fixed enum; release payloads continue to use
  `EXTRACTION_FAILED` with `payload.releaseCategory` describing the release issue.
  `7da17f1` adds `payload.extractedFields`, `payload.evidenceKinds`,
  `payload.matchedTokens`, `payload.candidateProgramIds` and
  `payload.candidateMatchedBy` — all JSON, no new column required.

Legacy database: `alrifai` (75 public base tables). Legacy mappings and unmapped
tables are recorded in `docs/LEGACY_PHASE3_COMPARISON.md`.

**Migration status:** schema `1.5.0` applied and verified in production; the
clone also reports `1.5.0`. The `7da17f1` candidate adds **no migration** and no
SQL/migration file change (`git diff 9e85e49..HEAD` verified). Migrations are
applied only by an explicit CLI run, never at application startup.

---

## 6. Production domains, URLs and ports

| Host | Certificate | State |
|---|---|---|
| `https://app.al-rifai.iamazim.com` | SAN `app.al-rifai.iamazim.com` | Canonical; working (HTTP 200 health) |
| `https://alrifai.iamazim.com` | SAN `alrifai.iamazim.com` | Working legacy alias; origin allowed; login returns 401 until credentials exist |
| `https://al-rifai.iamazim.com` | none | **Broken 1014** (observed as HTTP 403 with body `error code: 1014`); CNAME to a foreign Cloudflare account. Requires Owner DNS decision |

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

**Credentials:** password files are root-only, mode `400`, still **0 bytes**
(re-checked again 2026-11-07; no reset performed):
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
| Cutover rowid (immutable) | `19634` | `15184` |
| Latest observed sync checkpoint (2026-11-07) | `19728` | `15238` |
| Router | processes messages above watermark only | no business chats |
| AI | not enabled | worker/sender disabled |

The `sync` service reads each bridge `messages.db` read-only. No bridge container,
session, checkpoint or allowlist may be restarted, re-paired or reconfigured.

---

## 9. Current feature status and issue queue

### Verified working

- Health and schema `1.5.0` (production-deployed, live-verified).
- Production (read-only, 2026-11-07): 218 employees, 439 attendance,
  **102 programs** (94 imported + 8 live WHATSAPP `DRAFT` created 08:28–10:28 UTC),
  2,231 Cash `REVIEW` instructions, 13 pending review items (7
  `EXTRACTION_FAILED`, 6 `UNMATCHED_VESSEL_ASSIGNMENT`), 1,586 legacy postings,
  **zero non-legacy postings**, zero outbound AI rows.
- Live Cash: two authorized Admin→Accountant batches created 15 REVIEW instructions
  with zero duplicates and zero postings — 8 at 06:05 (335,000 minor) and
  7 at 06:32 (140,000 minor). The unique source identity
  `(source_message_id, source_block_key)` prevents duplicate instructions.
- Router processes above-watermark allowlisted messages; sync checkpoints
  advanced to WA-01 `19728` and WA-02 `15238` during this session.
- All **29** Admin routes and 12 USER routes return 200 with an authenticated
  clone session on `7da17f1`; all 7 CSV exports return `text/csv`.
- Owner draft renders exactly and blocks on missing fields; full WA-01 intake →
  DRAFT → draft UI → Admin reply → `CONFIRMED` verified on the clone.
- Role boundaries: 11 privileged API actions return 403 for USER, legitimate
  staging still works, and the UI no longer offers forms that would 403.
- Release/cancel/food-bill evidence extraction + read-only candidate matching
  verified on the clone; matched programs stayed `CONFIRMED`.
- Unit 110/110, integration 123/123, typecheck clean, lint 0 errors, image build
  passing. Clone fixtures all removed.

### Active issues by priority

| # | Severity | Issue | Next step |
|---|---|---|---|
| 1 | High | Candidate `7da17f1` not deployed; production still lacks `/vessel/drafts`, the date fix and the three 2026-11-07 corrections | Owner GO/NO-GO decision, then deploy/rollback |
| 2 | High | Production Admin/user logins unverified: password files are empty | Owner writes passwords, then run check-only provisioners; never reset |
| 3 | High | Vessel draft auto-delivery absent (`MANUAL_COPY_ONLY`) | Owner decision: approve an outbound sender/destination, or keep copy-only |
| 4 | Medium | 7 existing `RELEASE_UNSTRUCTURED` production items need manual review | Human decision in `/review`; the improved parser applies to future messages only |
| 5 | Medium | `al-rifai.iamazim.com` returns Cloudflare 1014 (HTTP 403 body) | Owner DNS/Cloudflare decision (`docs/DNS_CLOUDFLARE_1014.md`) |
| 6 | Medium | `main` does not yet contain the `7da17f1` code fixes | Merge the feature branch after deployment |
| 7 | Medium | Legacy tables not migrated (site settlements, reconciliation workspace, Excel cashbook, public site) | Separate Owner-approved mapping |
| 8 | Low | Legacy employee typeahead and add-transaction drawer not reproduced | Decide whether to reimplement |
| 9 | Low | Legacy insight/income charts replaced by tables | Accept or reimplement charts |

### Resolved (retained for history)

- Legacy generic redirects replaced by 19 independent pages.
- Nested employee route 500 (`created_at.slice`) fixed.
- Vessel program detail 500 (`[object Date]`) fixed in `9e85e49`.
- Legacy-host `403 ORIGIN_DENIED` fixed by origin allowlist.
- Admin/user login throttles cleared; provisioning is explicit CLI only.
- `provision-admin` / `provision-users` / `set-secret-password` implemented and clone-verified.
- **UI role gaps:** Cash/Settings/Vessel privileged forms hidden from USER
  without removing functionality (`8b9b779`).
- **Escort name** no longer falls back to a mobile number when an employee
  exists in the directory (`ecdd186`).
- **Unstructured release/cancel/food-bill messages** are now parsed into
  structured review evidence with read-only candidate matching; ambiguous cases
  stay pending (`7da17f1`).

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
| `81c376c`, `08b050e`, `76d5d00` | Permanent docs, live Cash evidence and URL matrix |
| `8b9b779` | UI capability gating for Cash, Settings and Vessel forms |
| `ecdd186` | `assignEscort` resolves the employee directory name |
| `7da17f1` | Unstructured release/cancel/food-bill evidence + read-only matching + tests; new candidate image |

---

## 11. Exact next starting point

1. Present the GO/NO-GO report and obtain **explicit Owner approval** before
   deploying `phase3-ai-rc-7da17f1` (see `NEXT-HANDOFF.md` for the exact
   command, rollback target and post-deploy checks).
2. Confirm the three password files are non-empty; run `provision-admin.mjs`
   (check) and `provision-users.mjs` (check), then perform real login/session/
   role checks and read-only authenticated verification of Cash, Vessel, Drafts,
   Employee, Attendance and Reports.
3. Decide the vessel-draft transport: keep manual copy (current) or approve a
   narrow outbound sender.
4. Manually review the 7 legacy `RELEASE_UNSTRUCTURED` items; start from
   `lib/release-slip.ts` (`parseUnstructuredRelease`) and
   `lib/message-router.ts` (`handleVessel` release-group branch) if further
   extraction rules are needed.
5. Merge `feature/phase3-router-cash-vessel` into `main` after deployment.
