# DEVELOPER_START_HERE.md — AL-RIFA'I Platform

**Last Updated**: 2026-11-09
**Current Version**: v1.10.0
**Schema Version**: 1.10.0 (52 tables, 14 migrations)
**Main HEAD**: `bc5b17f62f8e04bb3a25684ef535ae920ff91780`
**Status**: Production deployed, healthy

This document describes the **current** application. It supersedes the older
Phase 2 / early Phase 3 guide. Values below were read from the repository,
the production schema and the running containers — do not guess replacements.

---

## 1. Quick Start

### Prerequisites

| Tool | Required / tested |
|---|---|
| Node.js | `>=22.13.0`; tested on **v22.23.4** (`/opt/node22/bin/node`) |
| pnpm | **11.25.0** (`packageManager: pnpm@11.25.0`) |
| PostgreSQL | **16** (production: `postgres:16-alpine`) |
| Docker + Compose | required for production; VPS uses Docker Compose v2 |
| Next.js | **16.4.1** (App Router, standalone output) |
| React | **19.2.6** |

### Local development

```bash
# Clone the repository
git clone git@github.com:arshiyaazim/al-rifai-platform.git
cd al-rifai-platform
git checkout main

# Install dependencies
pnpm install

# Configure a disposable database in .env (never production credentials)
# PGHOST, PGPORT, PGDATABASE, PGSCHEMA, PGUSER, PGPASSWORD,
# ALRIFAI_REVIEW_DB_USER, ALRIFAI_REVIEW_PASSWORD

# Fresh schema + all migrations
pnpm db:install

# Or apply pending migrations only
pnpm db:migrate
pnpm db:preflight             # read-only migration preflight

# Development server
pnpm dev                      # http://127.0.0.1:3000
```

Production build:

```bash
pnpm build
pnpm start                    # only for non-standalone use; production uses the image
```

Never point local commands at the production database. The disposable test
database convention in this repository is `alrifai_v2_test` with
`ALRIFAI_ENV_FILE=/opt/al-rifai-phase3-test/.env`; production is
`alrifai_v2_phase3` and is only touched by an approved deployment.

---

## 2. Architecture Overview

```
WhatsApp bridges (WA-01, WA-02)
  │  SQLite stores, read-only
  ▼
scripts/sync-worker.mjs
  │  messages, media metadata, calls, contact evidence, identity aliases
  ▼
PostgreSQL (whatsapp_messages, whatsapp_media, whatsapp_calls,
            identity_aliases, whatsapp_chats, ...)
  │
  ├─ message classifier + Live Router (PHASE3_ROUTER_WORKER_ENABLED=1)
  │    ├─ Cash instructions  → cash_instructions → review/approval/posting
  │    ├─ Vessel orders     → programs (DRAFT) → Admin confirmation
  │    └─ Release slips     → existing program end date/release shift
  │
  ├─ Next.js App Router (app/) + server read models (lib/standalone/)
  └─ PostgreSQL ledger, review queue, audit history, AI foundation
```

Two processes, one image:

| Compose service | Container (production) | Command |
|---|---|---|
| `app` | `al-rifai-phase3-app-1` | `node deploy/tls-entry.mjs` (Next.js + TLS entry) |
| `sync` | `al-rifai-phase3-sync-1` | `node scripts/sync-worker.mjs --mode=tail` |

One image, no separate worker image:
`local/al-rifai-platform:<tag>`.

---

## 3. Repository, Branches and Release

### Current release

| Item | Value |
|---|---|
| Branch merged | `feature/phase3-010-011-activation` |
| Merge commit / main HEAD | `bc5b17f62f8e04bb3a25684ef535ae920ff91780` |
| Merge strategy | `--no-ff` merge commit, full history preserved |
| Tag | **`v1.10.0`** (annotated) |
| Feature branch | retained for reference; **not deleted** |
| Merge status | pushed to `origin/main`; tag pushed |

The production image was built from the feature commit `5d780b1`; `main` at
`bc5b17f` is the merge commit of that same code, so runtime code is identical.

### Last 10 commits on `main`

```
bc5b17f Merge feature/phase3-010-011-activation: Escort workflow, Cash & Vessel UI overhaul, correction/reversal workflow
5d780b1 feat(cash): add posted-transaction correction and reversal workflow
1df0b4b fix(cash): lock transaction amount after a paid event
54d2ebd feat(ui): cash & vessel table overhaul with action sidebar, employee history, manual program creation, legacy-aligned layout
771ea18 fix(cash): align transaction table columns, add pagination, wire live data
8825b7f feat(ui): vessel register, drafts, messages provenance surfacing for production
cd679f5 fix(vessel): enforce authorized escort order and release workflows
ab94f65 feat(whatsapp): complete unified message identity and traceability
ed27802 fix(sync): reconcile late edits and make media mirror status explicit
16deebe docs(vessel): align deployed image tag and digest with b379dd2
```

### Branch inventory

Local branches in the shared repository:

- `main`
- `feature/phase3-010-011-activation`
- `feature/phase3-010-011-release`
- `feature/phase3-cash-paid-events`
- `feature/phase3-docs-audit`
- `feature/phase3-integration`
- `feature/phase3-router-cash-vessel`

Remote branches additionally include `origin/main`, all of the above feature
branches, `origin/arena/e574efa6-al-rifai-platform`, and the historical
`origin/feature/phase3-router-cash-vesture` typo branch.

### Worktree note

The repository uses multiple Git worktrees. The `main` branch is checked out at
`/opt/al-rifai-platform`; that worktree contains unrelated uncommitted
deployment files and must not be reset. The v1.10.0 merge was performed in a
clean temporary clone and pushed to `origin/main`. `origin/main` is the
authoritative main branch; do not force-update or delete the dirty deployment
worktree.

---

## 4. Environments, URLs and Ports

### Production

| Item | Value |
|---|---|
| Public URL | `https://app.al-rifai.iamazim.com` |
| TLS entry | container port `3443` → host `443` |
| Internal app | `127.0.0.1:3001` → container `3000` |
| Health endpoint | `GET /api/health` (public) |
| Database host | `vps-infra-postgres-1:5432` (Docker network `vps-backend`) |
| Database name | `alrifai_v2_phase3` |
| Schema | `public` |
| Compose project | `al-rifai-phase3` |
| Compose files | `/opt/al-rifai-platform/compose.yaml` + `compose.phase3.yaml` |
| Environment file | `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` |
| Compose interpolation file | `/opt/al-rifai-platform/.env` (tag and worker flags) |

The sync service has no HTTP port. It reads the bridge SQLite stores through
read-only bind mounts and writes only to PostgreSQL and `/media`.

### Local

| Item | Value |
|---|---|
| Dev URL | `http://127.0.0.1:3000` (`pnpm dev`) |
| Test database convention | `alrifai_v2_test` |
| Test env file | `/opt/al-rifai-phase3-test/.env` |
| Standalone test server | `PORT=3000 HOSTNAME=127.0.0.1 node .next/standalone/server.js` |

### API base

All application APIs are under `/api`. Authentication uses the
`__Host-alrifai_cash` session cookie; mutations require the `X-CSRF-Token`
returned by `GET /api/auth/session`.

---

## 5. Database

**Current production schema: 1.10.0 — 52 base tables — 14 migrations.**

### 5.1 Tables by domain

**Core, configuration and authentication (8)**
`schema_meta`, `schema_migrations`, `app_settings`, `cash_portal_users`,
`cash_portal_sessions`, `cash_portal_audit`, `login_throttle_state`,
`rate_config`

**Employees, attendance and payroll (4)**
`employees`, `attendance`, `program_pay`, `rate_config` (shared with core)

**Vessel programs (6)**
`programs`, `program_assignments`, `program_events`, `program_source_messages`,
`program_pay`, `vessel_draft_deliveries`

**Cash and ledger (11)**
`cash_accounts`, `cash_instructions`, `cash_postings`,
`cash_transaction_adjustments`, `cash_reversals`, `cash_reconciliations`,
`cash_payment_events`, `cash_payment_event_postings`, `cash_submissions`,
`cash_submission_reviews`, `ledger_entries`

**Review and audit (3)**
`review_items`, `review_decisions`, `audit_events`

**WhatsApp ingestion, mirror and intelligence (9)**
`whatsapp_accounts`, `whatsapp_chats`, `whatsapp_messages`, `whatsapp_media`,
`whatsapp_cursors`, `whatsapp_import_runs`, `whatsapp_sync_state`,
`whatsapp_calls`, `whatsapp_message_intelligence`

**Identity and source authorization (2)**
`identity_aliases`, `escort_client_group_authorizations`

**AI foundation (11)**
`ai_contacts`, `ai_admin_jids`, `ai_conversations`, `ai_applicant_drafts`,
`ai_job_catalog`, `ai_order_drafts`, `ai_outbound_messages`,
`ai_outbound_attempts`, `ai_escalations`, `ai_messages`, `ai_tool_runs`

### 5.2 Migration order and purpose

| File | Version | Purpose |
|---|---|---|
| `schema.sql` | 1.1.0 baseline | Core schema: users, employees, programs, cash, review, WhatsApp staging, audit, ledger |
| `002_raw_import.sql` | — | Raw bridge import columns and source identity |
| `003_phase2_identity_media.sql` | — | Identity evidence and media capture metadata |
| `004_phase3_router_state.sql` | — | Router processing state, sync state, cursors |
| `005_phase3_vessel_correlation.sql` | — | Multi-message vessel program source links |
| `006_phase3_review_queue.sql` | 1.3.2 | Review queue + escort group participant authorization |
| `007_phase3_review_queue_ui.sql` | 1.3.3 | Review queue UI fields and supporting indexes/columns |
| `008_phase3_cash_lifecycle.sql` | 1.4.0 | Cash lifecycle: reversals, reconciliations, accounts |
| `009_phase3_ai_assistant.sql` | 1.5.0 | WA-02 AI conversation/tool/outbound foundation |
| `010_vessel_draft_delivery.sql` | — | Durable WA-01 Vessel Draft delivery queue (worker disabled) |
| `011_cash_payment_events.sql` | 1.6.0 | Business Paid Events, separate from financial POSTED |
| `012_whatsapp_message_intelligence.sql` | 1.7.0 | `mirrored_at`, `whatsapp_calls`, review metadata, message-intelligence view |
| `013_escort_workflow_authorization.sql` | 1.8.0 | Source roles, confirmation/release provenance |
| `014_manual_programs.sql` | 1.9.0 | `programs.master_name`, `programs.source_type` |
| `015_cash_corrections.sql` | 1.10.0 | Append-only Cash adjustments, `REVERSED` state, `reversal_of` |

Canonical message identity is `(account_id, chat_jid, message_id)`.
Event time (`source_timestamp`), ingestion time (`created_at`) and mirror time
(`mirrored_at`) are separate and must never be substituted for each other.

### 5.3 Financial integrity rules

- `cash_postings` and `ledger_entries` are immutable (triggers).
- A POSTED Cash transaction is never directly UPDATEd for amount/state.
- A correction is a new append-only `cash_transaction_adjustments` row:
  original + signed `adjustment_minor` = effective amount.
- A reversal marks the original `REVERSED` and creates a new `POSTED`
  instruction/posting linked by `reversal_of`; contra and replacement ledger
  entries are written.
- `cash_payment_events` are Business Paid Events, separate from financial
  POSTED. Corrections/reversals there are append-only event chains.
- Every correction/reversal is written to `audit_events`:
  `CASH:CORRECTION` and `CASH:REVERSAL`.

---

## 6. Authentication, Roles and Capabilities

- Unified auth mode: `ALRIFAI_UNIFIED_AUTH_MODE=on`.
- Session cookie: `__Host-alrifai_cash`.
- Login: `POST /api/auth/login`; session: `GET /api/auth/session`;
  logout: `POST /api/auth/logout`; password: `POST /api/auth/password`.
- Roles: `ADMIN` and `USER`; capabilities are resolved in
  `lib/unified-auth-policy.ts` and enforced by `assertCapability`.
- All `app/(workspace)` pages require a session (`pageUser()` redirects to
  `/login`). APIs require a session and, for mutations, CSRF.
- Key capabilities:
  `cash.read`, `cash.submit`, `cash.review`, `cash.post`, `cash.reverse`,
  `cash.ledger`, `cash.reconcile`, `vessel.read`, `vessel.submit`,
  `vessel.command`, `vessel.release`, `whatsapp.read`, `whatsapp.manage`,
  `whatsapp.route`, `employee.read`, `employee.submit`, `employee.manage`,
  `attendance.*`, `payroll.*`, `review.decide`, `audit.read`, `user.manage`,
  `ai.*`, `workspace.admin`.
- Corrections and reversals are **ADMIN-only** and additionally require
  `cash.review` / `cash.reverse`.

---

## 7. API Reference

All routes are under `app/api`; all are `nodejs`, force-dynamic. Unless marked
public, they require a valid session. Mutation routes require
`X-CSRF-Token`.

| Method(s) | Path | Capability | Purpose / response |
|---|---|---|---|
| GET | `/api/health` | public | `{status, database, schemaVersion}` |
| POST | `/api/auth/login` | public | `{user, csrf}` + session cookie |
| GET | `/api/auth/session` | session | `{user, csrf, mode}` |
| POST | `/api/auth/logout` | session | clears cookie |
| POST | `/api/auth/password` | session | changes own password |
| GET | `/api/messages` | `whatsapp.read` | Message list; filters `account`, `chat`, `direction`, `kind`, `q`, `role`, `domain`, `identity`, `mediaStatus`, `messageType`, `reviewStatus`, `sourceRole`, `sort`, `limit`, `offset`; response `{items,total,limit,offset}`. `view=stats|chats|calls` |
| POST | `/api/messages` | `whatsapp.manage` | Identity/domain/review classification; audited |
| GET | `/api/media` | `whatsapp.read` | Stream one stored attachment by `account,chat,message` |
| GET | `/api/cash/transactions` | `cash.read` | Live parsed Cash list; `{transactions,total,page,limit,totalPages}`. Params `page,limit,search,state,from,to` |
| GET | `/api/cash/transactions/{id}` | `cash.read` | One transaction, effective amount and provenance |
| PATCH | `/api/cash/transactions/{id}` | `cash.review` | Edits designation/notes; amount on POSTED/REVERSED → **409 `POSTED_FINANCIAL_FIELDS_LOCKED`** |
| POST | `/api/cash/transactions/{id}/correct` | `cash.review` (ADMIN) | `{correctedAmount,reason}`; append-only adjustment; original untouched |
| POST | `/api/cash/transactions/{id}/reverse` | `cash.reverse` (ADMIN) | `{amount,method,notes,reason}`; original `REVERSED`, new `POSTED` replacement |
| GET | `/api/cash/employees/{employeeId}/transactions` | `cash.read` | `{employee,transactions,total,page,limit,totalPages}`; `from,to,amountMin,amountMax` |
| GET | `/api/programs` | `vessel.read` | Program list; `q,state,escort,mother,from,to,limit,offset`; `{rows,total,...}` |
| POST | `/api/programs` | `vessel.submit` / `vessel.command` | Create/update/assign/release/void/start/complete actions |
| GET | `/api/programs/{id}` | `vessel.read` | Program detail |
| GET | `/api/vessel` | `vessel.read` | Vessel register alias; same filters as `/api/programs` |
| POST | `/api/vessel` | `vessel.command` | Manual program create (`source_type=MANUAL`); audit `VESSEL:MANUAL_PROGRAM_CREATED` |
| GET | `/api/vessel/{id}` | `vessel.read` | Detail + source messages + confirmation/release evidence |
| PATCH | `/api/vessel/{id}` | `vessel.command`; `vessel.release` for end dates | Edit master/escort/dates/notes; audit `VESSEL:PROGRAM_UPDATED` |
| GET/POST | `/api/finance` | `cash.read` / action-specific | `resource=summary|payments|business-paid|business-paid-event|accounts|instruction|reconciliations|ledger|submissions|report`; POST instruction/ledger/submission/reconciliation actions |
| GET/POST | `/api/review` | `review.decide` | Review queue and decisions |
| GET/POST/PATCH | `/api/employees` | `employee.read` / `employee.submit` / `employee.manage` | Employee directory and edits |
| GET/POST/DELETE | `/api/attendance` | `attendance.*` | Attendance records |
| GET/POST | `/api/payroll` | `payroll.*` | Payroll read/write |
| GET | `/api/reports` | `audit.read` + domain read caps | CSV/JSON report exports |
| GET/POST | `/api/users` | `user.manage` | Admin user management |
| GET/POST | `/api/whatsapp` | `whatsapp.read` / management | Account/chat/sync/route operations |
| GET/POST | `/api/assistant` | `ai.*` | AI assistant read/tool actions |

### Cash transaction response keys

`id, employeeId, nameOfEmployee, designation, dateOfJoin, payoutNumber, amount,
originalAmount, originalAmountMinor, adjustment, adjustmentMinor,
correctionCount, lastCorrectionId, reversalOf, totalPaid, amountMinor,
totalPaidMinor, method, state, source, sourceMessageId, notes, createdAt`

Amounts are integer minor units (paisa); the UI formats them as BDT. Effective
amount = `originalAmountMinor + adjustmentMinor`.

---

## 8. UI Inventory

### Navigation (`app/(workspace)/layout.tsx`)

Dashboard · Insights · AI Assistant · Employees / Escorts · Vessel Register ·
Order Drafts · Attendance · Cash & Accounts · Business Paid · Payroll ·
Review Queue · WhatsApp Inbox · Reports & Archive · Settings / Integrations

The sidebar is collapsible (240px expanded / 72px collapsed) and becomes a
mobile drawer at ≤900px.

### Page routes

| Path | Purpose |
|---|---|
| `/dashboard` | Business overview, Vessel pipeline, review counts, recent activity, quick actions |
| `/insights` | Operational insights |
| `/assistant` | Admin AI assistant |
| `/employees` | Employee/escort directory |
| `/employees/{mobile}` | Employee detail |
| `/employee`, `/employee/{phone}` | Legacy employee/escort views (kept for old URLs) |
| `/vessel` | **Vessel Register** (primary) |
| `/vessel/{id}` | Program detail + Mother-Vessel program history |
| `/vessel/drafts` | Order Drafts, assignment, delivery status, unresolved order reviews |
| `/vessel/register`, `/vessel/vessel-register`, `/vessel-register` | Legacy Vessel Register URL aliases |
| `/attendance` | Attendance |
| `/cash` | **Cash & Accounts** (primary) |
| `/cash/employee/{employeeId}` | Employee Cash transaction history |
| `/cash/transactions` | Financial POSTED payments table |
| `/cash/paid` | Business Paid Events |
| `/cash/paid/{id}` | Business Paid Event detail |
| `/cash/{id}` | Cash instruction detail |
| `/cash/archive` | Posted Cash archive/history |
| `/cash/submissions` | Cash submissions & review |
| `/transactions` | Source-linked Cash instructions/ledger |
| `/transactions/employee/{phone}` | Employee transaction view |
| `/payroll` | Payroll |
| `/review` | Review Queue |
| `/review/{id}` | Review item detail |
| `/messages` | **WhatsApp Message Intelligence** |
| `/conversations` | Conversation browser |
| `/message-mirror` | Raw message mirror |
| `/sources-review` | Sources & identity review |
| `/submissions` | My submissions |
| `/archive` | Archive |
| `/reports` | Reports & Archive |
| `/income-expenditure` | Income & expenditure |
| `/register` | Legacy/compat register |
| `/settings` | Settings / integrations |
| `/login` | Login (public) |
| `/` | Root redirect to `/dashboard` |

### Key tables, columns and forms

**`/vessel` — Vessel Register table**
Columns in order: `Sl | Mother Vessel | Lighter Vessel | Escort Name | Start |
End | Status | Updated | Actions`. Lighter shows Master Mobile beneath; Escort
shows Escort Mobile beneath. Status badges: DRAFT gray, CONFIRMED/ASSIGNED/
IN_DUTY blue, RELEASED/COMPLETED green, VOIDED red.
Controls: search, state filter, 10/20/50 rows, Previous/Next, “Updated just
now”, `+ New Program`.
Row action: three-dot → right sidebar (program details, order/confirmation/
release provenance, events, Edit/Save/Cancel, All Programs, Close).
New Program fields: Mother Vessel (autocomplete), Lighter Name, Master Name,
Master Mobile, Start Date, Start Shift D/N, optional Escort, Notes.

**`/vessel/{id}`**
Includes the same Mother-Vessel program history table, program details,
confirmation/release provenance, lifecycle timeline, chronological events,
duplicate warning, edit/assign/release/complete/void forms.

**`/vessel/drafts`**
Stats cards; delivery status table; Admin assignment form (`Draft program`,
`Escort (searchable list)`, `Escort name override`, `Start date`, `Shift`,
`Assign escort`); DRAFT table `Mother | Lighter | Master | Start | Order
timestamp | Client chat | Duplicates | Open`; separate
`CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN` review list.

**`/cash` — Cash & Accounts**
Summary cards: Total Paid Amount, Current Month Paid, Today's Paid Amount,
Yesterday Paid, Paid Via WA, Paid By Office, Number of Employee, Last Month
Paid.
Live Cash table: `Sl | Employee ID | Name of Employee | Designation | Date of
Join | Payouts | Amount | Total Paid | Actions`.
Controls: search Employee ID/Name, 10/20/50 rows, Previous/Next, “Updated just
now”.
Row action: three-dot → right sidebar.
- REVIEW/APPROVED: Edit → Save/Cancel.
- POSTED: “This transaction is posted and cannot be directly edited. Use
  Correction or Reversal to make changes.” with `Create Correction`
  (Corrected Amount + Reason min 10) and `Reverse & Re-post` (New Amount,
  Method, Notes, Reason min 10).
- Corrected rows show effective amount + `(corrected)`; reversed rows are
  muted/struck through.
Other sections retained: New payment instruction, income/expense, Instruction
workflow table (`Instruction | Payee | Account | Method | Amount | State |
Source | Actions`), Ledger (`Date | Account | Category | Amount`), Staff
submissions, Reconciliation.
The Cash review-candidates block is intentionally hidden from `/cash`; the
Review Queue still owns that workflow.

**`/cash/employee/{employeeId}`**
Summary cards: Employee ID, Name, Designation, Date of Join, Total Payouts,
Total Paid.
Filters: From, To, Min amount, Max amount.
History columns: `Sl | Date | Payouts | Amount | Method | State | Source |
Actions`; pagination 10/20/50; same three-dot sidebar; 30s polling.

**`/cash/transactions`**
Financial POSTED table: `Sl | Employee ID | Name of Employee | Designation |
Date of Join | Payout Number | Amount | Total Paid | Actions`; date/employee/
source filters; pagination.

**`/cash/paid`**
Business Paid table: `Sl | Employee ID | Name of Employee | Payout Number |
Amount | Source | Business Paid | Financial | Actions`.

**`/messages`**
Sync status table: `Account | Messages | Chats | In/Out | Group | Checkpoint |
Identities | Media | Calls | Latest | Last sync | Error`.
Conversations table; filters (search, account, chat type, direction, identity
role, business domain, identity confidence, media status, message type, review
status, source role, sort).
Message Intelligence table has 60+ columns with a Columns control and row
detail. Default visible: Message Time, Account/Bridge, Direction, Sender Name,
My Contact Name, Mobile Number, Source Role, Identity Role, Group Name,
Message Content, Media Status, Business Domain.
Call trace panel columns: `Call ID | Time (Dhaka) | Direction | Type | Status |
Duration | Chat`.

**`/dashboard`**
Cards: Active employees, Programs, Payable, Cash awaiting approval, Pending
reviews, Present today. Vessel pipeline: DRAFT/CONFIRMED/RELEASED, new orders
today/week (Asia/Dhaka), awaiting confirmation, confirmed open,
REVIEW_REQUIRED. Review Queue, recent activity (`When | Action | Entity |
Actor`), quick actions.

**`/review`**
Review queue tables and filters; `/review/{id}` shows source evidence,
duplicate comparison, audit history/decision form.

**`/employees` / employee detail**
Directory tables, employee forms, aliases, attendance/program lookups.

**`/attendance`, `/payroll`, `/reports`, `/settings`, `/assistant`,
`/sources-review`, `/conversations`, `/message-mirror`, `/archive`,
`/income-expenditure`, `/submissions`, `/transactions`**
Existing phase 2/3 management pages, retained and working. They use the same
layout, session and capability checks.

---

## 9. WhatsApp Ingestion, Identity and Message Intelligence

### Sync worker

`scripts/sync-worker.mjs` is the only process that reads the bridge SQLite
stores. It mirrors:

- messages (`whatsapp_messages`), preserving original WhatsApp event time;
- media metadata and explicit status (`whatsapp_media`: STORED/MISSING/
  FAILED/SKIPPED/NOT_APPLICABLE);
- bridge `calls` → `whatsapp_calls` (calls have no `message_id`);
- contact evidence from `whatsapp.db` (`whatsmeow_contacts`,
  `whatsmeow_lid_map`) into `identity_aliases` metadata: saved name, Owner
  contact name, push name, PN↔LID link;
- late edits/revocations via reconcile.

Checkpoint advances only after the PostgreSQL transaction commits. Stable
identity is `(account_id, chat_jid, message_id)`.

### Identity

`identity_aliases` is the canonical alias registry: PN JID, LID, group,
canonical JID, person key, confidence (`EXACT`/`VARIANT`/`UNRESOLVED`).
A LID is never converted to a phone number without a verified bridge PN link.
Display names are not identity proof. Mobile formatting uses Bangladesh
`+8801XXXXXXXXX` when verified; other numbers retain their international form.

### Message Intelligence

- Event time = `source_timestamp` (authoritative).
- Ingestion time = `created_at`.
- Mirror time = `mirrored_at`.
- UI displays event time in Asia/Dhaka.
- `whatsapp_message_intelligence` stores manual role/domain/review metadata,
  audited in `audit_events`.
- `whatsapp_message_intelligence_view` is a read-only projection; it is not a
  second message table.
- Message API/table expose all identity, contact, conversation, media, call,
  business-domain and provenance fields.

### Source roles

| Role | Meaning | Order Draft | Release |
|---|---|---|---|
| `ORDER_INTAKE` | Verified direct Escort Client conversation | Allowed | No |
| `CASH_ONLY` | Authorized Accountant/Cash direct chat | Blocked | Blocked |
| `SUPPORT_ONLY` | Support/Office group — evidence only | Blocked | Blocked |
| `RELEASE_ONLY` | Release Information group | Blocked | Allowed |
| `OTHER_APPROVED` | Approved vessel context group | Blocked | Blocked |
| `REVIEW_REQUIRED` | Unresolved role | Blocked | Blocked |

Group roles are explicit (`whatsapp_chats.source_role` or approved group-JID
map), never derived from display names. WA-02 remains identity-only.

### Live Router

`PHASE3_ROUTER_WORKER_ENABLED=1` in production. The router claims only messages
above the per-account cutover watermark and inside the explicit business-chat
allowlist. It writes Cash instructions in REVIEW and Vessel Drafts in DRAFT; it
never posts money or sends WhatsApp.

---

## 10. Vessel Workflow

```
Verified client WhatsApp order (WA-01, direct ORDER_INTAKE, INCOMING)
  → parser: Mother + Lighter + Master Mobile required
  → programs row DRAFT (one per lighter)
  → Admin assignment (/vessel/drafts)
  → verified Admin OUTGOING reply in the SAME client chat
  → vessel-match: normalized names, Master Mobile, shift, bounded chronology
  → programs CONFIRMED + confirmation provenance
  → Release Information group structured slip
  → exact existing program: end_date + end_shift, state RELEASED
  → audit_events + program_events + program_source_messages
```

Rules:

- Groups never create Order Drafts; Support group is support-only; other group
  is context-only; unclassified groups fail closed.
- Mandatory order fields: Mother, Lighter, Master Mobile. Missing fields go to
  review, not a fabricated Draft.
- Multiple lighters create separate Drafts.
- A bounded 30-minute, same-conversation merge can combine complementary
  fragments; nothing merges across clients/accounts/conversations.
- Client-supplied Escort assignment is reviewed, never drafted.
- Confirmation must be OUTGOING WA-01 from a configured Admin in the same
  original direct client chat, linked to exactly one Draft.
- Release updates only the exact existing program; never creates one; Start
  Date/Shift are preserved; End Date/Release Shift are separate; replays are
  idempotent.
- Duplicate rule: same Mother + Lighter + Start Date ±1 day warns; exact same
  start date is a hard duplicate; different Lighter is separate.
- Manual programs: `POST /api/vessel` or `+ New Program`; `source_type=MANUAL`,
  `master_name` optional, initial state DRAFT (optional escort assignment makes
  it ASSIGNED), duplicate check applies, audit
  `VESSEL:MANUAL_PROGRAM_CREATED`.

`vessel_draft_deliveries` / Bridge-2 delivery remains deliberately disabled
and is not part of the active workflow.

---

## 11. Cash Workflow

### Intake

Authorized WA-01 Admin outgoing messages in the Accountant/Cash direct
conversation are parsed into `cash_instructions` in REVIEW. The parser never
posts money and never writes the ledger. Incoming Accountant messages do not
create instructions.

Each instruction has employee, payout mobile, method, amount, purpose, source
message/block and state:

`REVIEW → APPROVED → POSTED` (or `REJECTED`, `VOID`, `REVERSED`).

### Posting

`postInstruction` is a separate explicit admin action; it creates an immutable
`cash_postings` row and a DEBIT `ledger_entries` row. Business Paid Events are
a separate business-layer record when `PHASE3_PAID_EVENTS_ENABLED=1` (currently
not enabled in production).

### Correction (POSTED)

`POST /api/cash/transactions/{id}/correct` with `{correctedAmount, reason}`:

- Original instruction, posting and ledger remain untouched.
- New append-only `cash_transaction_adjustments` row:
  `correction_of`, corrected `amount_minor`, signed `adjustment_minor`,
  `reason`, `state='CORRECTION'`, `created_by`, `created_at`.
- Contra ledger entry for the difference.
- Effective amount = original + adjustment.
- Audit `CASH:CORRECTION`.

### Reversal (POSTED)

`POST /api/cash/transactions/{id}/reverse` with
`{amount, method, notes, reason}`:

- Original becomes `REVERSED` (not deleted); original amount is unchanged.
- A new POSTED instruction + posting is inserted with `reversal_of=<original>`.
- Original contra CREDIT and replacement DEBIT ledger entries are written.
- Audit `CASH:REVERSAL` with before/after.
- Reversed rows are excluded from effective totals; the replacement is included.

### Edit restrictions

- `PATCH /api/cash/transactions/{id}`:
  - REVIEW/APPROVED: designation, amount, notes.
  - POSTED/REVERSED: designation/notes only.
  - Attempting amount on POSTED/REVERSED → **409
    `POSTED_FINANCIAL_FIELDS_LOCKED`**.
- Amount edits are also blocked if a Business Paid Event exists for the
  instruction (`CASH_AMOUNT_LOCKED_AFTER_PAID_EVENT`).

---

## 12. Review Queue, AI, Payroll and Reports

- `review_items` / `review_decisions` / `audit_events` are the shared review
  and audit layer. Pending reviews are counted in the sidebar badge.
- Cash review candidates (`cash_submissions`, `cash_submission_reviews`) remain
  available at `/review` and `/cash/submissions`; they are intentionally not
  shown on `/cash`.
- AI foundation tables and `/assistant` are available to authorized AI
  capabilities; WA-02 AI worker is disabled (`AI_WA02_ENV_DISABLED`).
- Payroll uses employees, attendance, programs and `program_pay`; `/payroll`.
- Reports export CSV/JSON through `/api/reports`; `/reports`, `/archive`,
  `/income-expenditure`, `/transactions` provide the reporting views.

---

## 13. Responsive Behaviour

The app uses a custom CSS shell plus Tailwind/shadcn components.

| Range | Behaviour |
|---|---|
| **>1250px** | Full desktop: 240px expanded sidebar, multi-column filters, wide tables |
| **1100–1250px** | Compact filters, reduced card padding, table columns still visible |
| **900–1100px** | Sidebar still visible but filters/tables compress; some grids stack |
| **≤900px** | Sidebar becomes an off-canvas drawer with hamburger/overlay; tables use horizontal scroll |
| **≤750/700/650px** | Multi-column forms/cards stack; dialogs/sidebars become full-width |
| **≤600px** | Mobile paddings, single-column forms, reduced type sizes, horizontal table scroll |

Container: legacy `.workspace` max-width **1680px**; the authenticated shell uses
a 240px/72px sidebar grid and fluid content. Wide tables are wrapped in
horizontal-scroll containers (`cash-table-scroll`, `overflowX:auto`) and keep
the header visible. The sidebars are 480px on desktop (`sm:max-w-[480px]`) and
full width on mobile; Escape/backdrop/X closes them.

---

## 14. Configuration and Feature Flags

Read from production containers and `compose.phase3.yaml`:

| Flag | Current | Meaning |
|---|---|---|
| `ALRIFAI_TAG` | `phase3-cash-corr-prod-5d780b1` | Image tag |
| `ALRIFAI_VESSEL_PROCESSING_ENABLED` | `1` | Vessel intake/release routing enabled |
| `PHASE3_ROUTER_WORKER_ENABLED` | `1` | Live Router worker runs every 5s |
| `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED` | `0` | Draft delivery worker disabled |
| `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED` | `1` | Outbound capability present but worker off |
| `ALRIFAI_MESSAGE_MIRROR_ENABLED` | `0` | Optional mirror flag; sync container still tails |
| `PHASE3_PAID_EVENTS_ENABLED` | unset/`0` | Business Paid Event creation off |
| `ALRIFAI_UNIFIED_AUTH_MODE` | `on` | Unified session auth |
| `AI_WA02_ENV_DISABLED` | present in logs | WA-02 AI worker not started |

`compose.phase3.yaml` interpolates `PHASE3_ROUTER_WORKER_ENABLED` and
`ALRIFAI_VESSEL_PROCESSING_ENABLED` from the **shell** (or
`/opt/al-rifai-platform/.env`). Always pass the current values explicitly when
deploying; an unset value defaults to `0` and would disable vessel processing.

Never enable the draft worker or outbound sending without the exact Owner
approval and one-message verification.

---

## 15. Deployment, Backup and Rollback

### Current production images

| Service | Image | Digest |
|---|---|---|
| app | `local/al-rifai-platform:phase3-cash-corr-prod-5d780b1` | `sha256:6b60ddc6d7d1bab616296fdb8b1276c4e153bc6b3ddb4bc6f08b9e5ad58e9bf2` |
| sync | `local/al-rifai-platform:phase3-cash-corr-prod-5d780b1` | same |

Image tag pattern: `phase3-<feature>-prod-<short-sha>` (older releases:
`phase3-overhaul-prod-54d2ebd`, `phase3-cash-prod-771ea18`, etc.).

### Backup pattern

Full logical backups are written outside the repository:

```
/opt/al-rifai-backups/<database>_<UTC timestamp>.sql.gz
/opt/al-rifai-backups/<database>_<UTC timestamp>.pre-<migration>.sql.gz
/opt/al-rifai-backups/deployment-<sha>.txt
```

Backups are `chmod 600`; use `pg_dump --no-owner --no-privileges | gzip -9`.
Never commit dumps, `.env` files or media.

### Build and deploy

```bash
cd /opt/al-rifai-phase3-activation
git checkout main && git pull
docker build -t local/al-rifai-platform:phase3-<name>-prod-<sha> .

cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-<name>-prod-<sha> \
ALRIFAI_VESSEL_PROCESSING_ENABLED=1 \
PHASE3_ROUTER_WORKER_ENABLED=1 \
  docker compose -p al-rifai-phase3 \
    -f compose.yaml -f compose.phase3.yaml \
    up -d --force-recreate app sync
```

The release record is `schema_version`, image tag, digest, migration count and
health output. Update `/opt/al-rifai-platform/.env` and the production env file
`ALRIFAI_TAG` after a deploy so a plain restart does not roll back.

### Migrations

Run from the repository with the target DB environment:

```bash
pnpm db:preflight
pnpm db:migrate
```

Migration 015 is the current head. Migrations are additive and checksum-locked
by `schema_migrations`. Applied migration files must not be edited without the
explicit `--allow-checksum-change` review.

### Rollback

- Code: redeploy the previous image tag; containers are recreated only.
- Database: migrations are additive; the previous image tolerates the extra
  tables/columns. For a disposable rollback, restore the pre-migration dump or
  run the migration-specific rollback SQL documented in the migration header.
- Never delete production tables, message rows or audit/financial history.

---

## 16. Verification Commands

Always use a disposable database for integration tests:

```bash
export PATH=/opt/node22/bin:$PATH
export ALRIFAI_ENV_FILE=/opt/al-rifai-phase3-test/.env

pnpm typecheck        # tsc --noEmit
pnpm lint             # scripts/lint.mjs, 0 errors
pnpm test:unit        # 149 tests (current)
pnpm test:standalone  # 241 tests (current, includes Escort E2E)
pnpm build            # Next.js standalone build
pnpm db:preflight     # read-only migration check
```

Runtime smoke test:

```bash
PORT=3000 HOSTNAME=127.0.0.1 node .next/standalone/server.js
curl -s http://127.0.0.1:3000/api/health
```

Production:

```bash
curl -s https://app.al-rifai.iamazim.com/api/health
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}'
docker logs --since 10m al-rifai-phase3-app-1
docker logs --since 10m al-rifai-phase3-sync-1
```

Current production evidence: health `200`, schema `1.10.0`, app/sync healthy,
0 restarts, 0 error log lines after deployment.

---

## 17. Troubleshooting

| Symptom | Check |
|---|---|
| Login loop / 401 | `ALRIFAI_UNIFIED_AUTH_MODE=on`; session cookie `__Host-alrifai_cash`; `/api/auth/session` |
| CSRF failure on mutation | Fetch fresh `csrf` from `/api/auth/session`; send `X-CSRF-Token` |
| `/cash` empty or stale | `cash_instructions` count; `/api/cash/transactions`; router flag and cutover watermark |
| POSTED amount edit blocked | Expected: use Correction/Reversal, not PATCH |
| Correction/reversal 403 | Requires ADMIN + `cash.review`/`cash.reverse` |
| Vessel Drafts not appearing | WA-01 business chats/allowlist, cutover rowid, `ALRIFAI_VESSEL_PROCESSING_ENABLED=1`, source role `ORDER_INTAKE` |
| Group message creates no Draft | Expected: groups are support/release/context, never order intake |
| Confirmation not matched | Must be Admin OUTGOING in the **same** direct client chat; vessel/master/shift evidence must match one Draft |
| Release not applied | Only the approved Release group; exact existing program; ambiguous/missing evidence goes to review |
| Sync stale | `whatsapp_sync_state` rowid, sync container logs, bridge store mounts read-only |
| Media missing | `whatsapp_media.status` (MISSING/FAILED/SKIPPED); never report STORED without a verified file |
| Migration refused | `schema_migrations` checksum; use preflight; never edit an applied file |
| `EADDRINUSE :3000` | A local Next server is already running; stop it or use another port |
| Compose restarts disabled vessel processing | Pass `ALRIFAI_VESSEL_PROCESSING_ENABLED=1` and `PHASE3_ROUTER_WORKER_ENABLED=1`; check `/opt/al-rifai-platform/.env` |

---

## 18. Known Limitations and Deferred Work

- **OCR is not implemented.** Release slips are parsed from text only. Image
  release slips go to review; no OCR dependency or OCR columns exist.
- **No `release_point`, `duty_count`, `release_salary`, `release_conveyance`,
  `release_notes` columns.** These are deliberately deferred.
- Bridge-2 → Bridge-1 draft delivery is not active. `vessel_draft_deliveries`
  exists but the worker is disabled and outbound sending requires explicit
  Owner approval.
- WA-02 is identity-only; it does not create Cash or Vessel business records.
- Historical media files are not recovered; metadata-only rows remain visible
  with `MISSING`/`SKIPPED` status.
- Corrections/reversals are append-only. A correction after a Business Paid
  Event is blocked for amount edits; future paid-event correction requires a
  separate approved workflow.
- Legacy Vessel Register URL aliases exist; `/vessel` is the primary page.
- Some historical employee rows have no designation/joining date; the UI shows
  an em dash rather than inventing values.
- Production interactive UI verification requires an Owner login; automated
  checks cover health, auth enforcement, APIs/read models, schema and logs.

---

## 19. Key Data Contracts

### Message identity

`(account_id, chat_jid, message_id)` is unique. `source_timestamp` is the
authoritative WhatsApp event time; `created_at` is ingestion; `mirrored_at` is
mirror time. Dhaka display uses `Asia/Dhaka`.

### Vessel program

`programs` row is the register row. `DRAFT` is the order draft; `CONFIRMED` is
the verified Admin confirmation; `RELEASED` carries End Date/Release Shift,
confirmation provenance and release provenance. `source_type` is `MANUAL` or
`WHATSAPP_ORDER`.

### Cash transaction

`cash_instructions` is the parsed instruction. `cash_postings` is the immutable
financial posting. `cash_transaction_adjustments` is the append-only correction
ledger. `cash_reversals` records reverse-and-repost. Effective amount is
original + adjustments; reversed originals are retained but excluded from
effective totals.

### Audit

`audit_events` records actor, role, action, entity, entity id, JSON detail,
source and source ref. Critical actions include `PROGRAM_CONFIRMED`,
`PROGRAM_RELEASED`, `VESSEL:MANUAL_PROGRAM_CREATED`, `VESSEL:PROGRAM_UPDATED`,
`CASH:CORRECTION`, `CASH:REVERSAL`, `INSTRUCTION_POSTED`,
`INSTRUCTION_REVERSED`.

---

## 20. Change History (recent releases)

| Version | Commit | Summary |
|---|---|---|
| v1.10.0 | `bc5b17f` | Merge: Escort workflow, source roles, Cash/Vessel UI overhaul, manual programs, employee/vessel history, Cash correction/reversal |
| pre-merge | `5d780b1` | Cash correction/reversal workflow, schema 1.10.0 |
| pre-merge | `1df0b4b` | Block amount edits after a paid event |
| pre-merge | `54d2ebd` | Cash/Vessel table overhaul, shared sidebar, employee history, manual program creation |
| pre-merge | `771ea18` | Cash transaction table alignment/pagination/live data |
| pre-merge | `8825b7f` | Vessel/Message provenance UI for production |
| pre-merge | `cd679f5` | Authorized Escort order/release enforcement |
| pre-merge | `ab94f65` | Unified WhatsApp message identity/traceability, schema 1.7.0 |

---

## 21. Safety Rules for Developers

1. Never run migrations, deployments, WhatsApp sends or production writes
   without explicit Owner approval.
2. Never reset, clean or overwrite the dirty deployment worktree
   `/opt/al-rifai-platform`; use a clean clone/worktree.
3. Never edit an applied migration; add a new additive migration.
4. Never fabricate names, phone numbers, JIDs, waits, media status or
   financial values.
5. Never edit a POSTED Cash row; use correction/reversal.
6. Never create Order Drafts from groups or WA-02.
7. Never enable the Vessel Draft worker or outbound sender without the exact
   approved sender/recipient and one-message verification.
8. Keep Cash, Ledger, Vessel lifecycle, Message Intelligence and Mirror
   independent; classification and source roles never grant permission.
9. Run typecheck, lint, unit, standalone and build before merge/deploy.
10. Record image tag, digest, migration result, health output and backup path
    for every production release.

---

**End of current developer guide.**
