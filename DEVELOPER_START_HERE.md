# DEVELOPER_START_HERE.md — AL-RIFA'I Platform

**Last Updated**: 2026-11-09
**Current Version**: v1.11.0 (15-task roadmap)
**Schema Version**: 1.11.0 (52 tables, 15 migrations)
**Main Release HEAD**: `v1.11.0` (release merge `510f105`; release tag points to the final documentation commit)
**Status**: Production deployed, healthy

### v1.11.0 delivered (15-task roadmap)

Tasks 1–12 are implemented and locally verified:

1. End-to-end form audit (Cash, Vessel, Employee, Review, Settings, Login) with new service/runtime tests.
2. CSV + Print export for the Vessel Register and Cash Transactions tables (current view or all filtered pages; UTF-8 BOM; DD-MM-YYYY; A4 landscape print).
3. Cash state filter (`POSTED`, `DRAFT`, `PENDING_REVIEW`, `APPROVED`, `REVERSED`, `CORRECTION`, `REJECTED`) with URL persistence.
4. Mother Vessel facets with dynamic counts, desktop pill list and mobile select.
5. Sticky/condensed program summary on `/vessel/{id}`.
6. Employee statement export (CSV + A4 PDF via jsPDF/autotable).
7. Inline Escort assignment on `/vessel/drafts` (full detail sidebar retained).
8. SSE real-time refreshes with a 15s heartbeat and automatic 30s polling fallback after three failures.
9. Saved Message Intelligence column presets in `localStorage`.
10. Review Queue bulk rejection with per-item audit, max 50 and partial-success reporting.
11. Light/Dark/System theme toggle; badge palette preserved in both themes; print always light.
12. Admin `/audit` viewer with domain/action/actor/target filters, before/after diff and related events.

Tasks 13–15 remain deferred; see Section 20.

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
            identity_aliases, whatsapp_chats, escort_client_group_authorizations)
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
`local/al-rifai-platform:phase3-roadmap-prod-b6e7c0f`.

---

## 3. Repository, Branches and Release

### Current release

| Item | Value |
|---|---|
| Branch merged | `feat/15-task-roadmap` → `release/v1.11.0` → `origin/main` |
| Merge commit / main HEAD | `510f105` (release merge); docs commit is tagged `v1.11.0` |
| Merge strategy | `--no-ff` merge commit, full history preserved |
| Tag | **`v1.11.0`** (annotated) |
| Feature branch | retained for reference; **not deleted** |
| Merge status | pushed to `origin/main`; tag pushed |

The production image was built from the code commit `b6e7c0f`; the merge
commit contains the same code. Image tag: `phase3-roadmap-prod-b6e7c0f`.

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
deployment files and must not be reset. The v1.11.0 merge was performed in a
clean temporary worktree (`release/v1.11.0`) and pushed to `origin/main`.
`origin/main` is the authoritative main branch; do not force-update or delete
the dirty deployment worktree.

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

**Current schema: 1.11.0 — 52 base tables — 15 migrations.** Production was
verified at 1.11.0/15 migrations after the v1.11.0 deployment.

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
| `016_audit_indexes.sql` | 1.11.0 | Audit Trail timestamp/action indexes and program-event index |

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
| GET | `/api/programs` | `vessel.read` | Program list; `q,state,escort,mother,from,to,limit,offset`; `{rows,total,limit,offset}` |
| POST | `/api/programs` | `vessel.submit` / `vessel.command` | Create/update/assign/release/void/start/complete actions |
| GET | `/api/programs/{id}` | `vessel.read` | Program detail |
| GET/POST | `/api/vessel` | `vessel.read` / `vessel.command` | Vessel register alias; same filters as `/api/programs`, plus a `mothers` facet sidecar `[{name,count}]`; POST manual program |
| GET/PATCH | `/api/vessel/{id}` | `vessel.read` / `vessel.command` | Detail + source/confirmation/release evidence; edit master/escort/dates/notes |
| GET | `/api/events` | session | SSE stream (`text/event-stream`): `{domain,action,id,at}` events, 15s heartbeat, 30s client polling fallback |
| GET | `/api/audit` | `audit.read` (ADMIN) | Unified audit viewer: `from,to,domain,action,actor,targetId,page,limit`; merges `audit_events` + `program_events` |
| POST | `/api/review/bulk-reject` | `review.decide` (ADMIN) | `{ids,reason?}`; max 50; per-item audit; partial success `{succeeded,failed,skipped}` |
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
| `/audit` | **Audit Trail** (ADMIN + `audit.read`): unified `audit_events` + `program_events`, filters, before/after diff, related events |
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

Measured from `app/standalone.css`, `app/globals.css`, the shadcn sheet
component and the table components. These are real CSS values, not estimates.

### 13.1 Exact dimensions

| Item | Exact value | Source |
|---|---|---|
| Authenticated page shell | `100vw` fluid grid: `240px + minmax(0, 1fr)` | `.wx-workspace` |
| Authenticated content max-width | **1400px** | `.wx-workspace__content { max-width: 1400px }` |
| Authenticated content padding (desktop) | `22px 26px 40px` | `.wx-workspace__content` |
| Legacy page container max-width | **1680px** | `.workspace { max-width: 1680px }` |
| Navigation sidebar expanded | **240px** | `--wx-sidebar-expanded: 240px` |
| Navigation sidebar collapsed | **72px** | `--wx-sidebar-collapsed: 72px` |
| Detail sidebar (Cash/Vessel) | **480px** at `sm` and above; full width below 640px | `sm:max-w-[480px]` in `DetailSidebar` |
| Cash live table scroll width | **1080px** | inline `minWidth: 1080` |
| Vessel register table scroll width | **1120px** | inline `minWidth: 1120` |
| Employee Cash history table | **980px** | inline `minWidth: 980` |
| Message Intelligence table | **2200px** | inline `minWidth: 2200` |
| Shared cash-payment table minimum | **1050px** | `.cash-payment-table` |
| Legacy program table minimum | **1190px** | `.program-table` |
| Cash search input | `min-width: 260px`, `max-width: 380px` | Cash table |
| Vessel search input | `min-width: 260px`, `max-width: 420px` | Vessel table |

The desktop shell is fluid rather than a fixed page width; the content itself
is capped at 1400px (authenticated) or 1680px (legacy pages). On narrower
screens the content width follows the viewport.

### 13.2 Breakpoints

| Width | Behaviour |
|---|---|
| **>1250px** | Full desktop: 240px sidebar, multi-column filters, wide tables |
| **1100–1250px** | Compact filter grids and card padding (`@media max-width:1250px`) |
| **900–1100px** | Tablet compression; filter/card grids narrow (`@media max-width:1100px`) |
| **≤900px** | Sidebar becomes an off-canvas drawer with hamburger/overlay; shell becomes one column; content padding `16px 14px 28px`; tables scroll horizontally |
| **≤820px** | Additional standalone-table/panel compression |
| **750–820px** | Dialogs/forms tighten; some grids collapse |
| **700–750px** | Form grids become single-column; dialogs full-width |
| **600–700px** | Mobile card padding and typography reduce; search/filter controls wrap |
| **≤600px** | Mobile layout: content padding `14px 12px 24px`, single-column forms, 70px mobile masthead, sticky mobile nav bar, tables horizontal scroll |
| **≤520px** | Narrow-phone spacing and control sizing |

Tailwind/shadcn components additionally use the standard `sm` breakpoint
(640px) for the detail sidebar width and grid changes.

### 13.3 Tables and sidebars

- Wide tables are wrapped in `overflow-x:auto` containers and keep the table's
  explicit minimum width listed above.
- Cash/Vessel sidebars are 480px on desktop, full-width under 640px, scroll
  their body, keep a fixed footer, and close on Escape, backdrop click or X.
- The navigation sidebar uses the collapsed/expanded 240px/72px variables.
- On mobile the navigation is a drawer; the detail sidebar overlays the page.

### 13.4 Dark mode and print (v1.11.0)

- `next-themes` sets `data-theme="light|dark"` on `<html>` from
  `localStorage[alrifai_theme]`; the default is `System`.
- The three-state toggle lives in the sidebar user area (`Light`, `Dark`,
  `System`). It is present on every authenticated page; `/login` follows the OS
  preference.
- The theme is applied before first paint by the provider script; a 200ms
  background/colour/border transition avoids a flash.
- Badge classes keep their required meaning in both themes: `pill` (DRAFT
  gray), `pill.info` (CONFIRMED blue), `pill.ok` (RELEASED green),
  `pill.reversed` (muted strikethrough), `pill.correction` (amber),
  `pill.posted` (emerald).
- Print always resolves to light colours via `@media print`, hides the
  sidebar/nav/toolbars/pagination, and renders `.print-area` at A4 landscape.
- CSV exports use UTF-8 BOM, CRLF, DD-MM-YYYY and plain BDT decimals; the
  “Export all pages” option fetches the full filtered API result.

## 14. UI/UX Improvement Roadmap

Priorities: **P1** = highest value / usability or data-safety issue; **P2** =
meaningful workflow improvement; **P3** = polish. Effort: small (≤1 day),
medium (2–5 days), large (1–2 weeks).

### 14.1 `/dashboard`

**Strengths:** single overview; vessel pipeline counts; review counts;
recent activity; quick actions.

**Pain points:** cards are mostly static totals with no trend/date range;
counts do not always link to the precise filtered view; the page does not show
which orders are awaiting confirmation.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Make every pipeline/review count link to the exact filtered `/vessel`, `/cash`, or `/review` query | Small |
| P1 | Show the oldest DRAFT awaiting confirmation and the oldest confirmed-open program | Small |
| P2 | Add 7/30/90-day trend sparklines for paid amount and new orders | Medium |
| P2 | Add a compact “needs attention” list with direct sidebar actions | Medium |
| P3 | Configurable dashboard cards per role | Large |

### 14.2 `/vessel` (Vessel Register)

**Strengths:** legacy-aligned columns; Master/Escort sub-lines; state badges;
search/state filter/pagination; three-dot sidebar; live polling.

**Pain points:** no Mother-Vessel facet or saved filters; no CSV/print; no
column visibility; the long review sections below the table can bury the
register; DRAFT vs ASSIGNED is easy to confuse.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add CSV/print export for the current filtered register | Small |
| P1 | Add a Mother Vessel facet and a “DRAFT only / awaiting confirmation” quick filter | Small |
| P2 | Add column visibility and sticky first columns on wide screens | Medium |
| P2 | Move the review/evidence sections behind tabs so the register stays primary | Medium |
| P3 | Bulk selection for assignment/release with a single confirmation step | Large |

### 14.3 `/vessel/{id}` (Program detail)

**Strengths:** full program info, order/confirmation/release provenance,
lifecycle timeline, duplicate warning, Mother-Vessel history, sidebar editing.

**Pain points:** very long page; history table duplicates the register table;
provenance text is not copyable/exportable; no sticky summary; no quick anchor
navigation.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add sticky summary/anchor nav (Program, Provenance, History, Events) | Small |
| P1 | Add “copy confirmation/release text” and print/export program record | Small |
| P2 | Collapse technical provenance by default; expand on demand | Small |
| P2 | Make the history table the single source and remove duplicated program rows | Medium |
| P3 | Side-by-side confirmation vs release evidence diff | Medium |

### 14.4 `/vessel/drafts`

**Strengths:** clear DRAFT assignment; escort dropdown; duplicate links;
client-assignment review separation; delivery status/gate.

**Pain points:** delivery-status block dominates the page; draft cards and
DRAFT table duplicate the same programs; no bulk copy/assignment; no clear
“next action” per draft.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Put “Assign” and “Copy draft” on each DRAFT row; make the table primary | Small |
| P1 | Collapse delivery status/gate into a summary with an expandable detail | Small |
| P2 | Bulk select drafts and copy/assign in one pass | Medium |
| P2 | Show a prerequisite checklist per draft (escort, date, confirmation link) | Medium |
| P3 | Draft delivery queue filters and retry actions | Medium |

### 14.5 `/cash`

**Strengths:** summary cards; exact 8-column live table; search/pagination;
correction/reversal sidebar; retained instruction workflow; review candidates
hidden from this page.

**Pain points:** two tables (live transactions and instruction workflow) can
look duplicative; instruction workflow is far below the fold; no state filter
on the live table; correction/reversal forms require opening the sidebar;
no CSV export of the live table.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add a state filter (All/REVIEW/POSTED/REVERSED/corrected) to the live table | Small |
| P1 | Add CSV export of the current filtered live table | Small |
| P2 | Collapse the instruction workflow into a secondary tab/section | Medium |
| P2 | Add inline “Correct/Reverse” shortcuts for POSTED rows | Medium |
| P3 | Saved filter views and date presets | Medium |

### 14.6 `/cash/employee/{employeeId}`

**Strengths:** clear employee header; total payouts/paid; date/amount filters;
history with sidebar; polling.

**Pain points:** no print/statement export; no running balance column; amount
inputs are in BDT while backend uses paisa (easy to mistype); no quick date
presets.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add “Print statement” and CSV export | Small |
| P1 | Add 7/30/90-day and “this month” date presets | Small |
| P2 | Add running effective balance after each payout | Medium |
| P2 | Show correction/reversal history inline on the affected row | Medium |
| P3 | Shareable statement link with expiry | Large |

### 14.7 `/messages` (WhatsApp Message Intelligence)

**Strengths:** complete identity/contact/media/call/business columns; column
control; source-role filter; row detail review; call panel; Dhaka event time.

**Pain points:** 60+ columns can overwhelm; filters are numerous and not
grouped; call trace is conversation-level only; no saved column presets; large
result sets need clearer account/chat context.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add saved column presets (Identity, Operations, Media, Calls, Review) | Small |
| P1 | Group filters into collapsible “Conversation / Identity / Media / Business” sections | Small |
| P2 | Add a conversation drilldown (chat summary → messages → calls) | Medium |
| P2 | Add CSV export of the current filtered view | Medium |
| P3 | Link media status rows directly to a preview/download drawer | Medium |

### 14.8 `/review` (Review Queue)

**Strengths:** single queue for Cash/Vessel/Employee; source evidence; duplicate
comparison; audit history; role-aware actions.

**Pain points:** one-item-at-a-time triage; no bulk approval/rejection; long
forms; no age/SLA indicator; category filters can be slow to scan.

| Priority | Improvement | Effort |
|---|---|---|
| P1 | Add multi-select and bulk reject with one mandatory reason | Medium |
| P1 | Show item age and oldest-first default | Small |
| P2 | Add keyboard shortcuts (next/approve/reject) | Medium |
| P2 | Sticky decision bar while scrolling evidence | Small |
| P3 | SLA/escalation badges and reviewer assignment | Large |

## 15. Form Field Reference

All list-page `<form method="get">` controls are filters, documented with their
pages in Section 8; they never mutate data. The forms below are the mutation
forms. Validation is shown from the UI plus the server-side rules that enforce
it. Submit uses `X-CSRF-Token` from `GET /api/auth/session` for every mutation.

### 15.1 New Program — `/vessel` right sidebar

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| `motherVessel` | text + datalist | Yes | Non-empty, max 120; datalist from existing non-voided mothers; default blank or fixed mother on history page | `programs.mother_vessel` / `motherRows` |
| `lighterName` | text | Yes | Non-empty, max 120 | User input |
| `masterName` | text | No | Optional, max 150 | User input |
| `masterMobile` | tel/text | No | If supplied, server normalizes to `01XXXXXXXXX` / `+8801XXXXXXXXX`; invalid rejected | User input |
| `startDate` | date | Yes | ISO date; duplicate ±1-day Mother+Lighter check | User input |
| `startShift` | select | Yes | `D` or `N`; default `D` | Fixed options |
| `escortMobile` | select | No | Active employee mobile; default “No escort yet” | `GET`-loaded employee list (`listEmployees({state:'ACTIVE'})`) |
| `notes` | textarea | No | Max 2000 | User input |

**Submit:** `POST /api/vessel` with `source_type=MANUAL`; creates DRAFT (or
ASSIGNED if an escort is selected), audit `VESSEL:MANUAL_PROGRAM_CREATED`;
success toast and table refresh. Duplicate/invalid → red toast, form remains.
**Cancel:** closes the sidebar; no request. **Close X/Escape/backdrop:** same.

### 15.2 Edit Program — `/vessel` or `/vessel/{id}` sidebar

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| `masterName` | text | No | Optional, max 150; default current | Program detail |
| `masterMobile` | text | No | Optional; normalized; default current | Program detail |
| `escortName` | text | No | Optional, max 150; only sent with `escortMobile` | Program detail |
| `escortMobile` | text | No | If set, assigns/replaces escort; default current | Program detail |
| `startDate` | date | No | ISO date; default current | Program detail |
| `startShift` | select | No | `D`/`N`; default current | Fixed options |
| `endDate` | date | No | If set, runs release; must be ≥ start date | Program detail |
| `endShift` | select | No | Blank, `D`, `N`; required by server if `endDate` set | Fixed options |
| `notes` | textarea | No | Max 2000; default current | Program detail |

Mother Vessel and Lighter Vessel are intentionally read-only here.
**Submit:** `PATCH /api/vessel/{id}`; updates fields, assigns escort and/or
releases according to supplied values; audit `VESSEL:PROGRAM_UPDATED`; success
toast and detail refresh. Invalid/forbidden → red toast.
**Cancel:** exits edit mode and discards unsaved values; sidebar stays open.

### 15.3 Escort Assignment — `/vessel/drafts`

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| `programId` | select | Yes | Must be a DRAFT program; label `Mother → Lighter · Start Shift` | `listPrograms({state:'DRAFT'})` |
| `employeeMobile` | select | Yes | Must be an active employee | `listEmployees({state:'ACTIVE'})` |
| `employeeName` | text | No | Optional override; max 150 | User input |
| `startDate` | date | No | ISO date; defaults to current program start on server | User input |
| `startShift` | select | No | `D`/`N` | Fixed options |

**Submit:** `POST /api/programs` with `action: assign`; sets the program to
ASSIGNED and records the assignment; `ActionForm` shows “Saved” and refreshes.
**Cancel:** no cancel button; the form resets only after a successful submit.

### 15.4 Create Correction — `/cash` sidebar, POSTED rows only

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| Corrected Amount | number | Yes | `> 0`, 2 decimals; converted to integer paisa; default original/effective amount | Selected transaction |
| Reason | textarea | Yes | 10–500 characters | User input |

**Submit:** `POST /api/cash/transactions/{id}/correct`; original stays
POSTED/unchanged; appends `cash_transaction_adjustments`, contra ledger entry,
audit `CASH:CORRECTION`; success toast; sidebar shows effective amount.
**Cancel:** exits correction mode; no request. **Close:** closes sidebar.

### 15.5 Reverse & Re-post — `/cash` sidebar, POSTED rows only

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| New Amount | number | Yes | `> 0`, 2 decimals; converted to paisa; default original | Selected transaction |
| Method | select | Yes | `bkash`, `nagad`, `rocket`, `bank`, `cash`; default original | Fixed options |
| Notes | textarea | No | Max 500; default original notes | Selected transaction |
| Reason | textarea | Yes | 10–500 characters | User input |

**Submit:** `POST /api/cash/transactions/{id}/reverse`; original becomes
REVERSED; a new POSTED instruction/posting is created with `reversal_of`;
contra and replacement ledger entries; audit `CASH:REVERSAL`; success toast.
**Cancel:** exits reversal mode; no request.

### 15.6 Edit Transaction — `/cash` sidebar, REVIEW/APPROVED only

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| `designation` | text | No | Max 100; saved on the employee registry; default current | Transaction/employee |
| `amount` | number | Yes | `> 0`, 2 decimals; blocked on POSTED/REVERSED or if a paid event exists; default current | Transaction |
| `notes` | textarea | No | Max 500; stored in `cash_instructions.purpose`; default current | Transaction |

**Submit:** `PATCH /api/cash/transactions/{id}`; success toast and row update.
POSTED/REVERSED amount → 409 `POSTED_FINANCIAL_FIELDS_LOCKED`.
**Cancel:** exits edit mode; no request.

### 15.7 New payment instruction — `/cash`

| Field | Type | Required | Validation / default | Data source |
|---|---|---|---|---|
| `employeeName` | text + typeahead | Yes | Must resolve to an employee name; default blank | Employee lookup |
| `employeeMobile` | text | No | Normalized mobile | Employee lookup or input |
| `payoutMobile` | text | No | Normalized mobile; defaults to employee mobile | User input |
| `method` | select | Yes | `bkash` default; `nagad`, `rocket`, `bank`, `cash` | Fixed options |
| `amount` | number | Yes | `> 0`, 2 decimals, BDT | User input |
| `accountId` | select | No | Default first active account | `cash_accounts` |
| `purpose` | text | No | Max 500 | User input |

**Submit:** `POST /api/finance` `action=instruction.create`; creates a REVIEW
instruction; clears amount/purpose; refreshes page; inline error on failure.
**Cancel:** none; form is always visible inside the collapsible panel.

### 15.8 Record income / expense — `/cash`

Fields: `accountId` (select, required, active accounts), `entryDate` (date,
required, default today), `direction` (select, CREDIT/DEBIT), `amount` (text,
required, BDT), `category` (text, required, max 60), `description` (text,
optional, max 500).
**Submit:** `POST /api/finance` `action=ledger.create`; success “Saved” and
refresh; error inline. **Cancel:** none.

### 15.9 Assign paying account — `/cash`

Fields: `id` (instruction id, required), `accountId` (select, required, active
accounts). **Submit:** `POST /api/finance` `action=instruction.account`; only
REVIEW instructions; success refresh. **Cancel:** none.

### 15.10 Instruction workflow actions — `/cash`

Approve (no fields), Reject (`reason` required), Post (no fields), Reverse
(`reason` required). Each calls `POST /api/finance` with the corresponding
action. Buttons appear only for the matching state and capability.

### 15.11 Staff submission — `/cash`

Fields: `employeeName` (required), `method` (select: bKash, Nagad, Bank, Cash),
`amountMinor` (number, paisa, required). **Submit:** `POST /api/finance`
`action=submission.submit`; creates PENDING_REVIEW. **Cancel:** none.

### 15.12 Start / close reconciliation — `/cash`

Start: `accountId` (select, required), `periodStart` (date, required, default
month start), `periodEnd` (date, required, default today), `countedBalance`
(text, required, BDT), `note` (text, optional). **Submit:**
`POST /api/finance` `action=reconciliation.create`.
Close: `id` (required), `note` (textarea, required only for non-zero variance).
**Submit:** `action=reconciliation.close`; no automatic adjustment is posted.

### 15.13 Vessel detail actions — `/vessel/{id}`

- **Replace/assign escort:** `employeeMobile` (required, mobile), `employeeName`
  (optional), `startDate` (date), `startShift` (D/N), `replace` (yes/no).
  `POST /api/programs` `action=assign`.
- **Mark in duty:** no fields; `action=start`.
- **Record release:** `endDate` (date, required), `endShift` (D/N), `note`
  (textarea). `action=release`.
- **Complete program:** no fields; `action=complete`.
- **Void program:** `reason` (required); `action=void`.
All success paths show “Saved” and refresh; invalid state/capability returns an
inline error.

### 15.14 Message identity / domain review — `/messages` row detail

Fields: `identityRole` (select from `OWNER, ADMIN, ACCOUNTANT, ESCORT_CLIENT,
ESCORT, EMPLOYEE, SUPPLIER, CUSTOMER, UNKNOWN`), `businessDomain` (select from
`CASH, VESSEL, SECURITY, HR, PAYROLL, OPERATIONS, PERSONAL, GENERAL, UNKNOWN`),
`reviewStatus` (`UNREVIEWED, CONFIRMED, CORRECTED, REJECTED`), `notes`
(textarea). Defaults from the message. Hidden: account/chat/message id.
**Submit:** `POST /api/messages` `action=classify`; audited; row update.
**Cancel:** none; panel/row closes via its own control.

### 15.15 Review actions — `/review/{id}`

- Approve: no fields; `POST /api/review` `action=decide`, `decision=APPROVED`.
- Reject: `reason` required; `decision=REJECTED`.
- Mark duplicate: `reason` required with `DUPLICATE_OF:` prefix;
  `decision=REJECTED`.
- Correct supported fields: dynamic fields per review domain; `action=correct`;
  stays pending.
- Withdraw: no fields; `action=withdraw`.
Decisions are final and audited.

### 15.16 Employee forms — `/employees`, `/employees/{mobile}`

Add employee: `employeeMobile` (required, normalized mobile), `preferredName`
(required), `dutyType` (select: escort/employee/other as configured),
`designation` (optional), `joinedOn` (date, optional), `notes` (textarea).
`POST /api/employees` `action=create`.
Edit employee: `preferredName`, `designation`, `state`
(ACTIVE/INACTIVE/SUSPENDED), `notes`; `PATCH /api/employees`.
Attendance from employee detail: `dutyDate` (required), `shift` (D/N), `state`
(PRESENT/ABSENT/LEAVE), `hours` (number), `reason` (required only when
changing an existing day).

### 15.17 Attendance form — `/attendance`

`employeeMobile` (select, required), `dutyDate` (date, required), `shift`
(D/N), `state` (PRESENT/ABSENT/LEAVE), `hours` (number), `reason` (required only
for an existing day correction). `POST /api/attendance`.
Delete attendance uses `DELETE /api/attendance` with the employee/date identity.

### 15.18 Payroll rate form — `/payroll`

`destinationKey` (required), `destinationLabel` (required), `shiftRateMinor`
(number, paisa, required), `conveyanceMinor` (number, paisa, optional),
`effectiveFrom` (date, optional). `POST /api/payroll`; success refresh.

### 15.19 Settings forms — `/settings`

- Create account: `code` (required), `name` (required), `type` (select),
  `currency` (default BDT), `openingBalanceMinor` (number). `POST /api/finance`
  `action=account.create`.
- Configure WhatsApp account: `id` (required), `label` (required), `socketPath`,
  `tokenFile`, `accountJid`, `adminJids`, `chatJid`, `purpose`
  (ORDERS/CASH/BOTH). `POST /api/whatsapp`.
- Test connection / sync / process staged: `accountId` where applicable;
  `POST /api/whatsapp` `health|sync|process`.
- Change password: `newPassword` (min 8), `confirmPassword` (min 8, must match).
  `POST /api/auth/password`.
- Create user: `username` (required), `displayName`, `role` (ADMIN/USER),
  `password` (min 8, required). `POST /api/users`.
- Update user: `user` (required), `displayName`, `role`, `active`.
- Reset user password: `user` (required), `password` (min 8).

### 15.20 Business Paid correction/reversal — `/cash/paid/{id}`

Correction: `amountMinor` (number, paisa, required), `employeeName` (optional),
`method` (select), `reason` (textarea, required). `POST /api/finance`
`action=business-paid.correct`.
Reversal: `reason` (textarea, required). `action=business-paid.reverse`.
These operate on Business Paid Event chains; they do not edit financial
postings directly.

### 15.21 Login — `/login`

`username` (required), `password` (required). `POST /api/auth/login`; session
cookie and CSRF on success; error shown without revealing which field failed.

### 15.22 AI assistant — `/assistant`

Prompt/query input (required non-empty), optional conversation context. Submits
to `POST /api/assistant`; authorized tools only; response/stream rendered in the
console. No business mutation is performed by the assistant UI.

## 16. Configuration and Feature Flags

Read from production containers and `compose.phase3.yaml`:

| Flag | Current | Meaning |
|---|---|---|
| `ALRIFAI_TAG` | `phase3-roadmap-prod-b6e7c0f` | Image tag |
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

## 17. Deployment, Backup and Rollback

### Current production images

| Service | Image | Digest |
|---|---|---|
| app | `local/al-rifai-platform:phase3-roadmap-prod-b6e7c0f` | `sha256:c03ea4b4f1cb433ca4ef53a4bfc902e8055451bf7776c35eec55c770aa343ac1` |
| sync | `local/al-rifai-platform:phase3-roadmap-prod-b6e7c0f` | same |

Image tags use the pattern `phase3-` plus the feature name plus `-prod-` plus the short commit SHA. Current tag: `phase3-roadmap-prod-b6e7c0f` (older releases:
`phase3-cash-corr-prod-5d780b1`, `phase3-overhaul-prod-54d2ebd`, `phase3-cash-prod-771ea18`, etc.).

### Backup pattern

Full logical backups are written outside the repository:

```
/opt/al-rifai-backups/alrifai_v2_phase3_20261108T204543Z.sql.gz
/opt/al-rifai-backups/alrifai_v2_phase3_20261108T230530Z.pre-015.sql.gz
/opt/al-rifai-backups/deployment-8825b7f.txt
```

Backups are `chmod 600`; use `pg_dump --no-owner --no-privileges | gzip -9`.
Never commit dumps, `.env` files or media.

### Build and deploy

```bash
cd /opt/al-rifai-phase3-activation
git checkout main && git pull
docker build -t local/al-rifai-platform:phase3-roadmap-prod-b6e7c0f .

cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-roadmap-prod-b6e7c0f \
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

## 18. Verification Commands

Always use a disposable database for integration tests:

```bash
export PATH=/opt/node22/bin:$PATH
export ALRIFAI_ENV_FILE=/opt/al-rifai-phase3-test/.env

pnpm typecheck        # tsc --noEmit
pnpm lint             # scripts/lint.mjs, 0 errors
pnpm test:unit        # 152 tests (current)
pnpm test:standalone  # 247 tests (current, includes Escort E2E and form audit)
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

Current production evidence: health `200`, schema `1.11.0`, image
`phase3-roadmap-prod-b6e7c0f`, app/sync healthy, 0 restarts, 0 error log lines
after deployment. Backup:
`/opt/al-rifai-backups/alrifai_v2_phase3_20261109T053432Z.pre-016.sql.gz`.
Deployment record: `/opt/al-rifai-backups/deployment-b6e7c0f.txt`.

---

## 19. Troubleshooting

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

## 20. Known Limitations and Deferred Work

### 20.1 OCR Release Images — Deferred (not implemented)

**Status:** Not implemented. Owner directive: implement only when the Owner initiates.

**Purpose:** The Escort Release group sends release-slip images via WhatsApp. The current parser (`lib/release-slip.ts`) only handles structured text. Image slips are visible in Message Intelligence with their media status but are not converted into release facts.

**Required before implementation:**

- Integrate an OCR engine (Tesseract, Google Cloud Vision, AWS Textract or Azure Document Intelligence).
- Support mixed Bangla + English text.
- Parse: escort mobile, lighter name, mother vessel, end date, end shift, release point, duty count, salary, conveyance.
- Add columns: `release_point`, `duty_count`, `release_salary`, `release_conveyance`, `release_notes`, `release_ocr_confidence`, `release_ocr_raw_text`; requires migration 017+.
- Match OCR output to existing programs with `lib/vessel-match.ts`; low confidence goes to `REVIEW_REQUIRED`; never create a program.
- Preserve the original image reference for audit.

**Dependencies:** OCR service account/API key, WhatsApp media download pipeline, image preprocessing (rotation, deskew, contrast). **Estimated effort:** large (5–10 days).

### 20.2 Bridge-2 → Bridge-1 Draft Delivery — Deferred (not implemented)

**Status:** Not implemented. Requires a separate Owner-approved workflow.

**Purpose:** A DRAFT program created from a WhatsApp order on WA-02 currently stays in the platform. This feature would deliver the draft notification to WA-01 for Admin review via WhatsApp.

**Required before implementation:**

- Route DRAFT notifications from WA-02 context to WA-01 outbound.
- Maintain message correlation so a WA-01 reply maps back to the original WA-02 order.
- Respect WA-01 rate limits, session rules and the existing allowlist.
- Audit every cross-bridge delivery.

**Dependencies:** WA-01 outbound capability (currently disabled), cross-bridge correlation model. **Estimated effort:** medium (3–5 days).

### 20.3 Supporting Group Evidence Linkage — Deferred (not implemented)

**Status:** Not implemented. Not mandatory per Owner directive.

**Purpose:** Messages in Al-Rifai Office Group (`SUPPORT_ONLY`) and Al-Aqsa Escort Program Group (`OTHER_APPROVED`) contain supporting evidence. Linking them to programs would strengthen the evidence base.

**Required before implementation:**

- Parse group messages for vessel/program references (names, dates, mobiles).
- Match to existing programs with `lib/vessel-match.ts`.
- Store linkage in `program_source_messages` with a confidence score.
- Display a “Supporting Evidence” section on the vessel detail page.
- Never use supporting evidence to create or modify programs — corroboration only.

**Dependencies:** group parsing rules and a confidence model. **Estimated effort:** medium (3–5 days).

### 20.4 Other current limitations

- WA-02 is identity-only; it does not create Cash or Vessel business records.
- Historical media files are not recovered; metadata-only rows remain visible with `MISSING`/`SKIPPED` status.
- Corrections/reversals are append-only. A correction after a Business Paid Event is blocked for amount edits; future paid-event correction requires a separate approved workflow.
- Legacy Vessel Register URL aliases exist; `/vessel` is the primary page.
- Some historical employee rows have no designation/joining date; the UI shows an em dash rather than inventing values.
- Production interactive UI verification requires an Owner login; automated checks cover health, auth enforcement, APIs/read models, schema and logs.
- `DRAFT` and `PENDING_REVIEW` are UI labels for the single Cash instruction `REVIEW` stage; `CORRECTION` filters rows with an adjustment.

---

## 21. Key Data Contracts

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

## 22. Change History (recent releases)

| Version | Commit | Summary |
|---|---|---|
| v1.10.0 | `bc5b17f` | Merge: Escort workflow, source roles, Cash/Vessel UI overhaul, manual programs, employee/vessel history, Cash correction/reversal |
| v1.11.0 | tag `v1.11.0` | 15-task roadmap: form audit, CSV/print, Cash state filter, vessel facets, sticky summary, statement export, inline assign, SSE, column presets, bulk rejection, dark mode, audit viewer |
| pre-merge | `5d780b1` | Cash correction/reversal workflow, schema 1.10.0 |
| pre-merge | `1df0b4b` | Block amount edits after a paid event |
| pre-merge | `54d2ebd` | Cash/Vessel table overhaul, shared sidebar, employee history, manual program creation |
| pre-merge | `771ea18` | Cash transaction table alignment/pagination/live data |
| pre-merge | `8825b7f` | Vessel/Message provenance UI for production |
| pre-merge | `cd679f5` | Authorized Escort order/release enforcement |
| pre-merge | `ab94f65` | Unified WhatsApp message identity/traceability, schema 1.7.0 |

---

## 23. Safety Rules for Developers

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
