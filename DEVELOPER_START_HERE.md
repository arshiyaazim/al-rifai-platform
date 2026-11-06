# DEVELOPER_START_HERE.md — AL-RIFA'I Platform

> **Canonical current-state developer map — not a changelog.** Read this first before modifying code, database, Docker, WhatsApp ingestion, or deployment.
>
> **Last reconciled:** 2026-11-06. **Source:** `feature/phase3-router-cash-vessel` at the Phase 3 completion commit (Live Router cutover gate, complete Cash lifecycle, capability enforcement, transaction-aware audit, incremental migration runner; **91/91 integration tests**, 67/67 unit tests); `main` remains at `e6becfc` (Phase 2). Repository source files, the isolated test database, and read-only production inspection. **Runtime facts below are agent-measured unless marked dated.**
>
> **Priority:** **BUILD → RUN → LIVE → IMPROVE**. Do not block releases on unrelated legacy data migration, historical Git branches, exhaustive tests, or non-blocking cleanup. Never claim a workflow is live solely because code exists.

## 1. Identity and authoritative locations

| Item | Current value / source |
|---|---|
| Git repository | https://github.com/arshiyaazim/al-rifai-platform |
| Git branch | `feature/phase3-router-cash-vessel` at the Task 5F.2B commit (pushed; 67/67 router+cutover); `main` untouched at `e6becfc` |
| Verified baseline | `e6becfc` (Phase 2, `main`, untouched); Phase 3 verified on the feature branch at the completion commit. |
| Local Git checkout (VPS) | `/opt/al-rifai-platform` (`main` at `e6becfc`) |
| Phase 3 test worktree (VPS) | `/opt/al-rifai-phase3-test` at the Task 5F.2B commit (separate worktree; production source unchanged) |
| Standalone app source / root `.env` (VPS) | `/opt/vps/al-rifai-standalone/apps/al-rifai` |
| Public application | https://app.al-rifai.iamazim.com |
| Login | https://app.al-rifai.iamazim.com/login |
| Public health | https://app.al-rifai.iamazim.com/api/health |
| Production PostgreSQL DB | `alrifai_v2`, schema `public`, version `1.2.0` (deployed; must not be migrated by Phase 3 work) |
| Isolated test DB | `alrifai_v2_test`, owner `alrifai_app`, **initialized at schema `1.4.0`** (001–008 + migration ledger), 35 tables. Tests must set `PGDATABASE=alrifai_v2_test`. |
| Legacy PostgreSQL DB | `alrifai` — retained, **not** active application DB |
| WhatsApp source WA-01 | `/var/lib/vps/whatsapp/wa-01/store/messages.db` |
| WhatsApp source WA-02 | `/var/lib/vps/whatsapp/wa-02/store/messages.db` |
| WhatsApp pairing/session stores | Each bridge's `store/whatsapp.db`; not application DB |
| Deployment definitions | `compose.yaml`, `Dockerfile`, `deploy/tls-entry.mjs` |
| Configuration template | `.env.example`; actual root `.env` excluded from Git |
| Schema baseline | `db/standalone/schema.sql` |
| Raw ingestion extension | `db/standalone/002_raw_import.sql` |
| Identity/media extension | `db/standalone/003_phase2_identity_media.sql` |
| Router processing state | `db/standalone/004_phase3_router_state.sql` |
| Cash lifecycle (reversal/reconciliation) | `db/standalone/008_phase3_cash_lifecycle.sql` |
| Incremental migration runner | `scripts/standalone/migrate.mjs` |
| Vessel correlation | `db/standalone/005_phase3_vessel_correlation.sql` |
| Review Queue schema | `db/standalone/006_phase3_review_queue.sql` |
| Review Queue UI schema | `db/standalone/007_phase3_review_queue_ui.sql` |
| Message worker | `scripts/sync-worker.mjs` |
| Media crypto/naming | `lib/whatsapp-media.mjs` |
| Identity classification | `lib/whatsapp-identity.mjs` |
| Media storage/route | `lib/standalone/media-storage.ts`, `app/api/media/route.ts` |
| New-media store (host) | `/var/lib/vps/al-rifai/media` — persistent, outside Git and the image |
| New-media store (containers) | `/media` — writable in `sync`, read-only in `app` |
| Fresh installer | `scripts/standalone/install.mjs` |
| Admin reset | `scripts/standalone/reset-password.mjs` |
| Env check | `scripts/check-env.mjs` |

**Canonical source rule:** `/opt/al-rifai-platform` is the canonical Git source. Phase 3 development happens in the `/opt/al-rifai-phase3-test` worktree on `feature/phase3-router-cash-vessel`; commit and push the feature branch, then merge to `main` only after the release gate. The deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` is synchronized **from a known Git commit**, never edited silently, and never given an independent development history. Synchronize before any production build, and never overwrite the deployment `.env` or other runtime secrets during synchronization.

## 2. Architecture and data flow

```text
WA-01 bridge messages.db ----\
                               -> read-only sync worker -> PostgreSQL alrifai_v2
WA-02 bridge messages.db ----/        |                     | raw messages, chat,
                                      |                     | identity evidence,
                                      |                     | new-media rows
                                      +-> /media/<account>/<sha256>.<ext>
                                                          (persistent bytes)

Browser -> HTTPS :443 -> Next.js app -> domain services -> PostgreSQL
                              |
                              +-> /messages inbox + /api/media (authenticated)
                              +-> Cash / Vessel / Employees / Attendance / Payroll
                              +-> Review / Reports / Settings / Audit

Optional MCP relay processing is a separate path; do not confuse it with
the deployed SQLite direct-import / tail worker.
```

- **One application image, two application services:** `app` and `sync`; shared external Docker network `vps-backend`.
- **Existing infrastructure retained:** PostgreSQL and two paired WhatsApp bridges.
- **No separate Redis/Kafka/vector database or extra messaging service** in this deployment.
- **One primary application database**, with **35 tables** after the Phase 3 extensions and migration ledger (local test schema; production not deployed).
- **Raw capture is not domain interpretation:** a message in PostgreSQL does not imply it has been classified into a cash instruction, vessel order, recruitment record, or AI conversation.
- **Review Queue is read/write only through authenticated services:** the UI never decides, posts or settles; the API re-checks ADMIN + not-submitter + PENDING server-side.
- **Media is content-addressed:** one file per SHA-256 under `/media/<account>/`; the database row links it to account, chat, message and sender evidence. Media keys stay in the bridge store and are never written to PostgreSQL.

## 3. Ports, URLs, services and runtime resources

| Service | Internal / host exposure | Notes |
|---|---|---|
| Public HTTPS app | Host `0.0.0.0:443` → app container `:3443` | TLS handled by `deploy/tls-entry.mjs`; certificate/key read-only mounts from `/etc/vps/apps/al-rifai/tls/` |
| Next.js HTTP | Container `:3000`; host `127.0.0.1:3001` → `:3000` | Private loopback port; not a second public site |
| Sync worker | No exposed port | Reads two bridge SQLite stores via read-only bind mounts; writes `/media` |
| New-media store | Host `/var/lib/vps/al-rifai/media` → `/media` | Persistent; `sync` mounts rw (writes), `app` mounts ro (serves) |
| PostgreSQL | Existing `vps-infra-postgres-1` | Connection values in root `.env`; do not guess or expose credentials |
| WA-01 / WA-02 bridges | Existing bridge services | Exact relay/control ports or sockets must be inspected if needed; not established by `compose.yaml` |

**Compose-defined resource limits:** app **512 MiB**, sync **192 MiB**. Measured 2026-11-05 after Phase 2: app **~70 MiB**, sync **~32 MiB**. Disk **55 GB used / 194 GB total** (~139 GB free); `alrifai_v2` ~75 MB; media store **26 MB / 97 files**. Numbers are a dated snapshot, not current telemetry.

**Runtime baseline (production, unchanged):** HTTPS health 200 with database OK and schema `1.2.0`; authenticated access to the workspace pages including `/messages`; both sync checkpoints advancing. Deployed image `local/al-rifai-platform:20261105-phase2` (`sha256:2950c068…`, built from `09b2a51`); rollback image `20261105-v3` (`sha256:c29d837c…`) retained. Confirm actual digests from Docker before any rollback. **Local test schema:** PostgreSQL 16, `alrifai_v2_test`, schema `1.4.0`, 35 tables; production not deployed.

## 4. Code and directory map

| Path | Responsibility |
|---|---|
| `app/` | Next.js App Router pages and API routes; check actual route tree before documenting a newly added URL |
| `components/` | Reusable UI |
| `lib/` | Domain services, data access, auth, identity and integration helpers |
| `lib/env.mjs` | Shared environment loader |
| `lib/whatsapp-media.mjs` | WhatsApp media decryption, MIME/extension and safe naming (pure) |
| `lib/whatsapp-identity.mjs` | JID classification, canonical PN, confidence and person key (pure) |
| `lib/message-router.ts` | Phase 3 shared WhatsApp message router: domain classification, authorization, crash-safe processing state, Review Queue submission for errors/ambiguity (LOCALLY VERIFIED: lint+typecheck+unit+DB tests pass; CI workflow prepared, not executed) |
| `lib/message-classifier.ts` | Phase 3 domain classifier: CASH/VESSEL/UNKNOWN classification from message text + chat purpose (LOCALLY VERIFIED: 14 unit tests pass) |
| `lib/standalone/review.ts` | Review Queue service: filterable queue, detail with source evidence, corrections, decisions, withdrawal, cash review candidates, counts (LOCALLY VERIFIED: 7 DB integration tests pass) |
| `lib/standalone/finance.ts` | Accounts, instruction lifecycle, posting, reversal, reconciliation, submissions, ledger (LOCALLY VERIFIED: 5 Cash lifecycle tests pass) |
| `lib/standalone/authz.ts` | Capability resolution and server-side enforcement |
| `lib/standalone/users.ts` | Super Admin user administration with lockout protection |
| `lib/review-ui.ts` | Pure Review Queue UI helpers: category/state labels, role-based action projection, source evidence, extracted/missing fields, vessel names, confirmation evidence (17 unit tests pass) |
| `components/standalone/review-*.tsx` | Review Queue filters, actions, source evidence, audit history and detail components |
| `app/(workspace)/review/page.tsx` | Authenticated Review Queue list with pending/resolved/rejected, domain/category filters and cash candidates |
| `app/(workspace)/review/[id]/page.tsx` | Review detail with source evidence, extracted fields, missing/conflicting fields, reasons, audit history and role-checked actions |
| `db/standalone/007_phase3_review_queue_ui.sql` | Additive Review Queue UI schema: category-aware pending uniqueness, correction metadata, cash candidate source columns |
| `lib/standalone/media-storage.ts` | Media-root confinement and attachment filename safety |
| `db/standalone/` | Fresh database bootstrap plus additive raw-import and Phase 2 layers |
| `db/postgres.mjs` | PostgreSQL access and environment initialization |
| `scripts/sync-worker.mjs` | SQLite historical import / continuous tail, identity and media capture |
| `scripts/standalone/` | Installer and admin reset |
| `app/api/media/route.ts` | Authenticated streaming of one captured attachment |
| `app/(workspace)/messages/page.tsx` | Inbox: accounts, conversations, identities, media links, checkpoints |
| `scripts/check-env.mjs` | Checks required environment keys without printing secrets |
| `deploy/` | TLS application entry |
| `tests/` | Focused unit and standalone tests (includes `tests/standalone/review-ui.test.mjs`, `review-api.test.mjs`, `message-classifier.test.mjs`, `message-router.test.mjs`, `media.test.mjs`, `identity.test.mjs`) |
| `docs/STANDALONE-MAPPING.md` | Supporting feature → code → DB mapping; update if changed |
| `docs/STANDALONE-VERIFICATION.md` | Supporting test evidence; not the canonical current-state map |
| `docs/STANDALONE-REMOVED.md` | Legacy feature-removal reference |
| `compose.yaml`, `Dockerfile` | Image, services, ports, mounts and limits |
| `.env.example` | Safe placeholder config, never live credentials |

**Documentation policy:** This file is the top-level map. Detailed references may remain in `docs/`, but they must not contradict this current-state summary. If they do, reconcile them during the same code change.

## 5. Features — implemented versus proven

Status terms: **LIVE** = owner agent reported real deployment/runtime validation; **IMPLEMENTED** = code/schema present, full operational behavior not independently verified; **PARTIAL** = some path works but requested end-to-end capability is incomplete; **NOT BUILT/NOT VERIFIED** = no proof of full implementation.

| Feature | Status | Current capability | Missing / next action |
|---|---|---|---|
| HTTPS, login, sessions | **LIVE** | HTTPS 443, login, protected workspace, admin reset; three retained accounts | Maintain when auth changes |
| Dashboard | **LIVE** (page) | KPI/workspace page renders | Validate each KPI against new DB when business data grows |
| Cash / ledger | **IMPLEMENTED + TESTED (not deployed)** | Full instruction lifecycle REVIEW → APPROVED → POSTED / REJECTED / VOID, posting, immutable ledger, reversal with contra entry, reconciliation, cash review candidates, audit history, role capabilities | Production deployment and Owner acceptance of the posting capability matrix |
| Vessel programs | **PARTIAL** | Create program; escort employee auto-created; pay fails closed without rate | Release parser, 11-column register, richer assignment/confirmation parity |
| Employees | **IMPLEMENTED** | Profiles and linked operations; fresh DB had 0 business employees | Employee-master phases and full identity enrichment |
| Attendance | **IMPLEMENTED** | Manual records and summaries | WhatsApp-driven attendance automation |
| Payroll | **PARTIAL** | Derived pay/rate model | Configure rates; advance, food and conveyance rules not complete |
| Review / audit | **IMPLEMENTED + FRONTEND INTEGRATED** | Review Queue UI with pending/resolved/rejected filters, domain/category filters, source-message evidence, extracted/missing fields, reasons, audit history and role-checked actions; cash review candidates; vessel review panels | Verify domain-specific approval paths as added; production not deployed |
| Reports / CSV | **IMPLEMENTED** | Export/report features in source | Verify current datasets/permissions as needed |
| Settings | **LIVE** (page) | Accounts, rates, relay settings and password functionality | Owner rate configuration pending |
| WA-01 historical import | **LIVE** | All source rows imported; 19,064 messages, checkpoint 19,442 | Keep source/checkpoint reconciliation |
| WA-02 historical import | **LIVE** | All source rows imported; 15,032 messages, checkpoint 15,032 | Keep source/checkpoint reconciliation |
| WA-01 continuous sync | **LIVE** | New rows observed across restarts; checkpoint advances; no error | Exercise outgoing/direct/edits as samples arrive |
| WA-02 continuous sync | **LIVE** | New rows and post-deploy media observed; checkpoint advances; no error | Maintain; outgoing/direct samples continue |
| WhatsApp identity | **LIVE** | One resolver for both accounts: 2,587 aliases (2,320 EXACT / 62 VARIANT / 205 UNRESOLVED); account JIDs normalised; chat and participant names; PN/LID links only when the bridge resolved them | Contact-book/push/profile names where the bridge exposes them; WA-02 store has no `resolved_*`/`group_participant_jid` columns |
| WhatsApp media (new) | **LIVE** | 100 attachments stored (27.2 MB, 97 unique files) including 6 received after deploy; SHA-256 verified; authenticated `/api/media`; no historical recovery | A live document or sticker sample; 55 older WA-02 rows are `MEDIA_METADATA_INCOMPLETE` by design |
| WhatsApp Inbox | **LIVE** | Account selection, direct/group conversations, resolved names, raw JIDs when unresolved, media links, checkpoint and sync health | Deeper conversation search/filtering as data grows |
| Phase 3: Shared Message Router | **IMPLEMENTED** | `lib/message-router.ts`, `lib/message-classifier.ts`, `db/standalone/004_phase3_router_state.sql`, `POST /api/whatsapp?action=route` | Lint+typecheck+14 classifier tests+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Cash Domain Handler | **IMPLEMENTED + TESTED** | WA-01 Admin OUTGOING messages → `cash_instructions` REVIEW; unparsable → `cash_submissions` PENDING_REVIEW; candidate approval creates a linked REVIEW instruction atomically; idempotent by source identity; no automatic posting. Automated writes use `system:whatsapp-router`, so a sole human Admin can review them. | Production not deployed; Owner capability/approval policy decision |
| Phase 3: Review Queue | **IMPLEMENTED + FRONTEND INTEGRATED** | 10 review categories; `review_items.category` column; category-aware pending uniqueness; group participant authorization; multi-message vessel correlation; ambiguous confirmation handling; Review Queue UI with filters, source evidence, extracted/missing fields, reasons, audit history, corrections and role-checked decisions; cash review candidates | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Vessel Domain Handler | **IMPLEMENTED** | WA-01 incoming vessel messages → `programs` DRAFT via `createProgram()` with atomic provenance; group participant authorization via `escort_client_group_authorizations`; multi-lighter and multi-message correlation via `program_source_messages`; duplicates → Review Queue; admin outgoing confirmation via `applyConfirmation()` in same chat; ambiguous confirmations → review; WA-02 rejected; vessel review panels show incomplete orders, duplicates, ambiguous confirmations, escort conflicts, original/normalized names and confirmation_message_id | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Cash Reversal & Reconciliation | **IMPLEMENTED + TESTED** | `cash_reversals` (one per posting, immutable, contra CREDIT ledger entry), `cash_reconciliations` (expected/counted/variance, OPEN/CLOSED), API, UI and `/cash/[id]` audit history | Production not deployed |
| Phase 3: Source Provenance | **IMPLEMENTED** | `whatsapp_messages.processing_status/retry_count/last_error/last_processed_at`; `cash_instructions.source_message_id/source_block_key`; `programs.source_message_id/source_chat_jid`; `program_source_messages`; `cash_submissions` source columns | Migration additive/idempotent; DB tests pass locally; CI migration validation not executed; production not deployed |
| Phase 3: CI Workflow | **IMPLEMENTED** | `.github/workflows/ci.yml`: lint, typecheck, unit tests, full integration suite, router+cutover, Review Queue, Cash lifecycle/users, migration validation at `1.4.0`, Next.js build, Docker build validation | CI jobs never started — GitHub account locked due to a billing issue; no production creds |
| Recruitment conversations | **NOT BUILT/NOT VERIFIED** | No complete workflow established | Design from old source/docs, implement new module |
| Employee conversations | **NOT BUILT/NOT VERIFIED** | Raw messages available | Role-based conversation routing and employee actions |
| Client CRM / customer service | **NOT BUILT/NOT VERIFIED** | Raw messages available | Client identity, case state, reply workflow |
| AI assistant / AI-origin messages | **NOT BUILT/NOT VERIFIED** | Integration placeholders | Model/tool integration, source attribution, domain actions, approvals |

**Fresh-data policy:** Owner does not require historical business data import. Agent reported **0 programs, 0 cash instructions, 0 employees and 0 postings** after removing temporary test records. Raw WhatsApp history is retained. Do not confuse “empty new business DB” with “broken app.”

**Test evidence — this session (2026-11-06):** `pnpm test:unit` executed: **67 pass / 0 fail** (shift-boundary, unified-auth-policy, media, identity, message-classifier, review-ui; re-confirmed in this environment after `pnpm install --frozen-lockfile`). DB-dependent suites now run against the isolated `alrifai_v2_test` database: **91/91 pass** (domain 9, WhatsApp adapter 1, router 49, cutover 18, Review API 7, Cash lifecycle 5, users 2). `scripts/standalone/migrate.mjs` provides the previously missing `db:migrate` path. GitHub Actions remains billing-locked; the workflow is updated for schema `1.4.0` but has not executed. No production credentials.

## 6. Pipeline/workflow inventory

**Counting rule:** A pipeline is one independently meaningful end-to-end business/data flow. Below are **15 tracked logical pipelines**, **not** a claim that 15 background workers exist. Recount when adding/removing a flow. Status reflects the weakest critical step.

| # | Pipeline / workflow | Status | What works now | What remains |
|---|---|---|---|---|
| P01 | HTTPS → login → authorized workspace | **LIVE** | TLS, session, authenticated pages | Ongoing access checks |
| P02 | Fresh schema → DB connectivity → health | **LIVE** | 35-table test DB, health OK, version 1.4.0 (local test schema) | Repeat on next schema change; production not deployed |
| P03 | WA-01 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P04 | WA-02 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P05 | WA-01 new message → automatic DB tail | **LIVE** | New rows observed across restarts; checkpoint advances; no error | Outgoing/direct/edits samples as they arrive |
| P06 | WA-02 new message → automatic DB tail | **LIVE** | New rows and post-deploy media observed; checkpoint advances; no error | Outgoing/direct samples as they arrive |
| P07 | Raw message → shared identity/contact resolution | **PARTIAL** | One resolver for both accounts: 2,587 aliases, canonical PN, chat/participant names, bridge-only PN/LID links | Contact-book/push/profile names; WA-02 store lacks `resolved_*` and participant columns |
| P08 | Raw message → domain classification/action | **IMPLEMENTED** | Phase 3 shared router + classifier; authorization via whatsapp_chats; processing state; Review Queue submission; Review Queue UI with filters, source evidence, extracted/missing fields, reasons, audit history and role-checked actions | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| P09 | Cash instruction → review → approval → posting → reversal → reconciliation | **IMPLEMENTED + TESTED** | Full lifecycle, immutable ledger, contra reversal, reconciliation, capability enforcement and audit; 5 lifecycle tests + 49 router tests | Production deployment; Owner acceptance of role matrix |
| P10 | Vessel order → program → assignment → release | **IMPLEMENTED** | Router creates program DRAFT from WhatsApp vessel messages (WA-01 only); multi-lighter and multi-message correlation; confirmation via applyConfirmation in same chat; ±1-day duplicate warnings → Review Queue; vessel review panels for incomplete orders, duplicates, ambiguous confirmations, escort conflicts, original/normalized names and confirmation_message_id | Release and assignment parity; CI workflow prepared, not executed; production not deployed |
| P11 | Employee → attendance → payroll | **PARTIAL** | Core tables/UI and rate calculation | Rate setup, attendance automation, extras |
| P12 | Recruitment / employee / client conversations | **NOT BUILT/NOT VERIFIED** | Raw source messages available | Conversation UI, classification, workflows |
| P13 | Phase 3 CI pipeline | **IMPLEMENTED** | .github/workflows/ci.yml: lint, typecheck, unit tests, full integration suite, router+cutover, Review Queue, Cash lifecycle/users, migration validation (schema 1.4.0), Next.js build, Docker build validation | CI jobs never started — GitHub account locked due to a billing issue; production not deployed |
| P14 | New media → persistent bytes → authenticated access | **LIVE** | 100 attachments / 27.2 MB stored and SHA-verified, including post-deploy samples; authenticated streaming; no historical recovery | Live document/sticker sample; retention policy as volume grows |
| P15 | AI/admin → reply → WhatsApp → audit | **NOT BUILT/NOT VERIFIED** | No end-to-end proof | AI tools, outbound sender, source/audit linkage |

**Summary:** count programmatically when updating; **the table itself is authoritative**. (P01–P06 and P14 LIVE = 7; P07, P09, P11 PARTIAL = 3; P08, P10, P13 IMPLEMENTED = 3; P12, P15 NOT VERIFIED = 2.) **Current: 7 LIVE / 3 PARTIAL / 3 IMPLEMENTED / 2 NOT VERIFIED.**

**Phase 3 test execution — 2026-11-06 (test DB `alrifai_v2_test`, schema 1.4.0):**

- `tests/standalone/domain.test.ts` — **9/9**.
- `tests/standalone/whatsapp.test.ts` — **1/1** (adapter sync + fail-closed router default).
- `tests/standalone/message-router.test.mjs` — **49/49**.
- `tests/standalone/router-cutover.test.mjs` — **18/18**.
- `tests/standalone/review-api.test.mjs` — **7/7**.
- `tests/standalone/cash-lifecycle.test.mjs` — **5/5**.
- `tests/standalone/users.test.mjs` — **2/2**.
- Combined: **91/91 integration tests**, run sequentially with `--test-concurrency=1`. Unit suite: **67/67**.
- Migration: `alrifai_v2_test` 1.3.3 → 1.4.0, 35 tables, 7 ledger rows; repeat run is a no-op. Fresh disposable DB: install 34 tables/1.4.0; migrate 35 tables; `install --force` succeeds.
- The Live Router remains default-disabled in production; test activation is synthetic and confined to the test DB.
- Production remains `1.2.0`; **no Phase 3 workflow is marked LIVE** and no production financial posting occurred.

## 7. WhatsApp ingestion facts and boundaries

- Live measurement 2026-11-05: **34,096** PostgreSQL raw messages (WA-01 **19,064**, WA-02 **15,032**), 0 duplicates on `(account_id, chat_jid, message_id)`; counts change as new messages arrive.
- The sync worker reads **both bridge `messages.db` files read-only**. It does not read or overwrite either `whatsapp.db` session store.
- Import uses stable source snapshots and checkpoints; the tailer resumes from the last committed rowid and never duplicates a row.
- **Identity evidence:** account, chat and participant rows in `identity_aliases`; account JIDs normalised to `<number>@s.whatsapp.net`; LID ↔ PN links only where the bridge itself resolved them. Names come from the bridge chat label. Current: 2,587 aliases (2,320 EXACT / 62 VARIANT / 205 UNRESOLVED).
- **New-media capture:** for images/audio/video/documents/stickers the worker reads the persisted URL + media key, decrypts in memory, verifies the recorded SHA-256 and writes one content-addressed file under `/media/<account>/`. Media keys never enter PostgreSQL. `--mode=import` skips media; only the live tail and its recent-reconcile window are captured, so historical attachments are not recovered.
- **Media results:** 100 stored / 27.2 MB (97 unique files, content-hash dedupe) including 6 received after the Phase 2 deploy; 55 WA-02 rows are `MEDIA_METADATA_INCOMPLETE` because the older bridge rows carry no URL/key. Documents and stickers are supported by the code but have no live sample yet.
- **Capture scope and business-processing scope differ:** store raw messages from both accounts as configured; process into Cash/Vessel/HR/CRM/AI only under explicitly defined domain rules. Never treat all WhatsApp messages as automatically authorized financial or business commands.
- Both incoming and outgoing, direct and group, are target capture paths. **Do not claim all combinations proven** until corresponding live events are observed.
- LID ≠ guaranteed phone number. Preserve unresolved identity instead of inventing a number.
- The README now separates the **optional MCP relay** from the deployed direct-SQLite worker and records the live media path.

## 8. Database and secrets

- **Current database:** `alrifai_v2`, PostgreSQL, schema version `1.2.0` (deployed); the Phase 3 branch defines `1.4.0` through migration 008, verified only on the isolated test DB and a disposable fresh DB. Legacy `alrifai` is retained for rollback and is not part of the new application's business state.
- **Isolated Phase 3 test DB:** `alrifai_v2_test` on the existing `vps-infra-postgres-1` (owner `alrifai_app`, UTF8) is at schema `1.4.0`: 35 tables (including `schema_migrations`), 5 functions, 15 triggers. Migrations 002–008 are applied, including `cash_submissions.instruction_id`, `cash_reversals`, `cash_reconciliations`, and the extended ledger source values. It is separate from `alrifai_v2`/`alrifai` and must be the explicit `PGDATABASE` for installation/migration/integration tests. Production `alrifai_v2` remains `1.2.0` and is not migrated or modified.
- **Installer repeat-safety:** a second run without `--force` refuses with `ALREADY_INSTALLED`. `--force` now skips the non-idempotent baseline and re-applies only the additive layers + grants; verified on the disposable fresh DB. Prefer `pnpm db:migrate` for a controlled upgrade.
- **Installer/migrations:** fresh `schema.sql` + additive `002`–`008`, all idempotent, schema `1.4.0`. `scripts/standalone/migrate.mjs` is the incremental, checksum-tracked path. Production schema remains `1.2.0` and is not migrated. Do not reintroduce the legacy migration chain just to match historical DB structure.
- **Phase 2 tables/columns:** `whatsapp_media` (one row per captured attachment, unique per account/chat/message, FK to the message) and identity evidence columns on `identity_aliases` (`display_name`, `name_source`, `canonical_jid`, `person_key`, first/last seen, `metadata`). The live migration was applied with a verified `pg_dump` (`/var/lib/vps/al-rifai/backups/pre-phase2-20261105-1111.dump`) and preserved all 34,090 pre-change messages.
- **Dedup key:** `(account_id, chat_jid, message_id)`. `(account_id, message_id)` alone loses one known WA-01 duplicate-ID-across-chat case.
- **Central configuration:** `/opt/vps/al-rifai-standalone/apps/al-rifai/.env`; shared loader `lib/env.mjs`; `pnpm env:check` prints missing key names, not values.
- `.env` is **never committed**, copied into Docker images, or printed. `.env.example` holds placeholders only.
- Frontend-created login passwords are **hashed**, not stored in plaintext. Bootstrap admin password can be provided via `.env`; use `pnpm admin:reset` for recovery.
- WA session keys and media decryption material remain in bridge-owned storage; not copied into the main business DB. The worker uses a media key in memory only.
- **Media directory:** `/var/lib/vps/al-rifai/media` (host), `/media` in containers; owned `10001:10001`, mode `0700`, written by the root `sync` process and read-only to `app`. It is outside Git and the image, so it survives rebuilds and container recreation.
- The owner prioritizes rapid delivery and simple configuration, not enterprise security tooling. Keep existing functional authentication and do not introduce new infrastructure as a prerequisite to ordinary feature work.

## 9. Fast build, deploy and essential checks

Work in the Phase 3 worktree `/opt/al-rifai-phase3-test` on the feature branch, commit and push it, then (after approval) merge `main` and synchronize the deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` from that commit. The live `.env` stays only in the deployment source and is never committed, copied into Git, or overwritten by synchronization.

```bash
cd /opt/al-rifai-platform
git status --short
git pull --ff-only origin main
# Make scoped code changes; update this document in the SAME commit.
git add <changed-source-paths> DEVELOPER_START_HERE.md
git commit -m "feat: <concise change>"
git push origin main
```

For production deployment, use the existing `compose.yaml` and image workflow. **Do not assume a Git push automatically deploys code.** Build a new image only when runtime code changed; deploy only when authorized, then confirm:

1. `/api/health` returns 200 and database/schema match.
2. HTTPS login works and intended pages render.
3. Both WhatsApp worker checkpoints continue advancing when source rows arrive.
4. `sync-worker --mode=status` shows `last_error: null`, media counts and identity totals.
5. A stored attachment downloads byte-identically through `/api/media` for a signed-in user and is refused (401) without a session.
6. No active bridge pairing/session is disturbed.
7. Record actual image digest, Git SHA, deployment timestamp and measured RAM/disk here.

**No unnecessary large regression suites** for a docs-only edit. Do not restart Docker daemon, wipe bridge stores, or run broad Docker/volume pruning.

## 10. Current blockers and immediate priorities

| Priority | Work | Acceptance |
|---|---|---|
| 1 | Keep GitHub `main`, the canonical checkout and the deployment source aligned | `origin/main` = local HEAD, and the deployment source matches the committed documentation/source |
| 2 | Phase 3 release candidate | Code, migrations, tests and docs complete on `feature/phase3-router-cash-vessel`; 91/91 integration + 67/67 unit; production deployment gated on Owner approval, fresh backup and business allowlist |
| 3 | Observe WA-02 outgoing/direct/edited samples | Real observed examples reach PostgreSQL once; checkpoint advances; no error |
| 4 | Confirm document and sticker media | A live document/sticker attachment stored with SHA verification |
| 5 | Complete identity map | Contact-book/push/profile names where the bridge exposes them; WA-02 store lacks `resolved_*` and participant columns |
| 6 | Media retention and disk budget | A retention/size policy before the 26 MB store grows; keep the default 25 MB per-file ceiling |
| 7 | Production Phase 3 migration/deploy | Owner approval, verified `pg_dump`, approved chats/participants/Admin JIDs, then follow `PHASE3_VPS_RELEASE_CHECKLIST.md` |

**Phase 3 implementation state (all items):**
- Router Foundation: IMPLEMENTED + TESTED — `lib/message-router.ts`, `lib/message-classifier.ts`, state/retry, Review Queue submission, per-account cutover watermark. 49/49 router tests, 18/18 cutover tests.
- Cash Domain: IMPLEMENTED + TESTED — WA-01 Admin OUTGOING messages only → REVIEW; unparsable → PENDING_REVIEW candidate; candidate approval atomically creates a linked REVIEW instruction; automated writes attributed to `system:whatsapp-router`; no automatic posting. 5/5 Cash lifecycle tests.
- Vessel Domain: IMPLEMENTED + TESTED — DRAFT programs, multi-message correlation, group participant authorization, confirmation via `applyConfirmation()`, WA-02 rejected.
- Review Queue: IMPLEMENTED + TESTED — category-aware queue, source evidence, corrections, decisions, withdrawal, cash candidates, role-checked actions. 7/7 Review API tests + 17 UI unit tests.
- Cash Reversal/Reconciliation: IMPLEMENTED + TESTED — immutable reversal + contra ledger entry; expected/counted/variance reconciliation with no automatic adjustment; `/cash/[id]` shows posting, reversal, ledger and audit.
- Authorization: IMPLEMENTED + TESTED — explicit capabilities for cash review/post/reverse/reconcile/ledger/account, payroll, employees, attendance, vessel command/release, WhatsApp, review and user management; USER writes are staged through review where the model promises submission.
- Audit integrity: IMPLEMENTED — `recordAudit(input, client)` participates in the caller's transaction; review decisions apply domain writes on the same client.
- Migration/CI: IMPLEMENTED — `scripts/standalone/migrate.mjs`, shared grants, idempotent `install --force`, CI updated for schema `1.4.0` and the full suite. Not executed on GitHub (billing lock).
- Frontend: IMPLEMENTED — Cash candidate decisions, reversal, reconciliation, instruction audit detail, Super Admin user administration.
- Verification: 67/67 unit, 91/91 integration, typecheck, lint, Next build, Docker build, `pnpm audit --prod` clean. PRODUCTION NOT DEPLOYED.

**Delivery boundary:** Implementation and integration tests complete on `feature/phase3-router-cash-vessel` at `7b0330c`; pushed to origin. No production deployment. Production readiness is **BLOCKED** pending the items in the audit block below.
| 6 | Domain conversation routing | Cash/Vessel/HR/Recruitment/CRM routed to proper handlers; no unauthorized automatic posting |
| 7 | Vessel rates and missing release/parser logic | Owner-configured rates; end-to-end order/release flow |
| 8 | Recruitment, employee conversations and AI assistant | Incremental modules, measured and deployed separately |
| 9 | Reduce disk below target if practical | Identify unused cache/images without removing live services |
| 10 | Optional legacy DB/container removal | Separate explicit owner decision; not a release prerequisite |

**Phase 3 production readiness audit — 2026-11-06 (implementation complete; deployment NOT executed):** **CODE READY; PRODUCTION GATED.**

- **Environment:** production app/sync remain on `local/al-rifai-platform:20261105-phase2`; PostgreSQL 16.15; `alrifai_v2` at `1.2.0 / 30 tables`; feature worktree carries the Phase 3 completion work. WA-01/WA-02 bridges are up and untouched.
- **Schema compatibility:** 004–008 are additive/idempotent and drop no data. 004 adds processing state; 005 adds multi-message vessel correlation; 006 adds group authorization and review category; 007 replaces the pending-review index and adds correction/source columns; 008 adds candidate→instruction linkage, immutable reversals, reconciliation and the extended ledger source values. Business tables are empty in production; 34,376 messages, 2,010 chats, ~2,595 identity aliases and media rows must survive. No new functions/triggers are added by 008 except the immutable reversal trigger.
- **Migration path:** `scripts/standalone/migrate.mjs` is checksum-tracked, idempotent and grants the runtime role. Verified on `alrifai_v2_test` (1.3.3 → 1.4.0, 35 tables) and on a fresh disposable DB (install 34 tables/1.4.0; migrate 35 tables/7 ledger rows; repeat install `--force` succeeds). `db:migrate`, `db:verify`, `db:preflight` now exist.
- **Historical reprocessing guard:** unchanged and still mandatory. The Live Router is default-disabled, requires explicit per-account `phase3_cutover_rowid:*` and `phase3_business_chats:*`, and never rewrites historical statuses. Production has 0 `phase3_%` settings.
- **Vessel authorization data:** `escort_client_group_authorizations` is still empty in production; group vessel intake remains fail-closed until the Owner populates approved participants. This is a deployment prerequisite, not a code defect.
- **Cash lifecycle:** complete in code and tested in the isolated DB: candidate→instruction, approval, posting, immutable reversal, reconciliation, audit and capability enforcement. No automatic posting. Production execution requires the Owner-approved capability matrix and a separate decision to post real money.
- **Dependency/security:** Next.js `16.4.1`, Zod `4.6.6`, fast-uri `3.1.9`; `pnpm audit --prod` reports no known vulnerabilities.
- **Verification:** typecheck 0 errors, lint 0 errors, 67/67 unit tests, 91/91 integration tests, Next.js build and Docker build pass. CI workflow is updated but GitHub Actions remains billing-locked.
- **Backup/rollback:** no fresh pre-Phase-3 production backup exists yet. Required before deployment. Application rollback to `20261105-phase2` remains safe because 004–008 are additive; a full DB rollback still needs a verified restore. Cash corrections use reversal, never mutation.
- **Verdict:** the release candidate is code-complete and test-complete. Production deployment is **BLOCKED on explicit Owner approval**, a fresh verified backup, the production migration window, the business-chat/participant/Admin-JID allowlist, and acceptance of CI evidence.

### Phase 3 historical cutover design — 2026-11-06 (DESIGN ONLY; not implemented)

**Current pipeline (ordered):**
1. Bridge SQLite `messages.db` (WA-01/WA-02) is append-only; the sync worker reads rows above `whatsapp_sync_state.last_rowid`.
2. The worker upserts `whatsapp_messages` with `(account_id, chat_jid, message_id)` identity, `source_rowid`, `source_timestamp`, direction, sender, text and media metadata, then commits the checkpoint.
3. Migration 004 adds `processing_status` with `DEFAULT 'PENDING'`; the worker does not set it, so **every existing and newly mirrored row is PENDING**.
4. An ADMIN `POST /api/whatsapp` action `route` (or `process`, which delegates to the same `routePendingMessages()`) claims all PENDING/FAILED/PROCESSING rows with **no historical cutoff**, classifies them and creates Cash REVIEW instructions / Vessel DRAFT programs / review items.
5. Cash is WA-01 Admin OUTGOING in a CASH/BOTH chat; Vessel is WA-01 INCOMING in an ORDERS/BOTH chat with an authorized participant; WA-02 is rejected for business processing; no posting/approval/ledger.

**Root cause of the replay risk:** 004's `DEFAULT 'PENDING'` backfills all **34,355** production messages to PENDING; the router claims every PENDING row; production has **2,010 chats all `purpose='BOTH', authorized=true`** (1,959 direct / 51 group) from the Phase 2 capture import, and `whatsapp_accounts.admin_jids` is **empty (length 0)**. Cash is currently fail-closed by the empty admin list, but Vessel direct chats are auto-authorized; once admin JIDs are configured, a single route/process call would parse the whole history. Sync checkpoints are `wa-01 = 19,588` and `wa-02 = 15,145`; all 34,355 rows have `source_rowid` (0 nulls).

**Strategy comparison:**

| Strategy | Safety | Delayed msgs | Replay/restart | Rollback | Complexity |
|---|---|---|---|---|---|
| A. `source_timestamp` cutoff | Unsafe: WhatsApp time ≠ ingestion order; delayed/queued messages are misclassified | Excludes valid delayed messages | Fragile | Simple | Low |
| B. Monotonic watermark (`whatsapp_sync_state.last_rowid` / `source_rowid` / `id`) | Safe: append-only order | New rowid → eligible even with an old timestamp | Safe | Watermark is immutable | Medium |
| C. Explicit `processing_eligible` flag set by the worker | Safest/explicit | Safe | Safe | Needs worker + schema change | High |
| D. Migration-time marking of historical rows | Safe if the watermark is correct | Safe | Idempotent | Data-only; Phase 2 ignores it | Low |

**Superseded implementation note (Task 5F.2B):** the bulk historical-status marking described below is **not** implemented. The implemented design uses the per-account watermark in the router claim query, a default-disabled activation gate and an explicit business-chat allowlist, leaving historical processing statuses untouched. The analysis below remains as the design record.

**Recommended: B + D + an activation gate + a separate business-authorization allowlist.**
- Capture the cutover watermark **before** the update, in the migration transaction: per account `whatsapp_sync_state.last_rowid` (and optionally the global `max(id)`), stored in `app_settings` (`phase3_cutover_rowid:wa-01`, `phase3_cutover_rowid:wa-02`, `phase3_cutover_id`).
- Mark historical rows `processing_status='COMPLETED'`, `classification='HISTORICAL_PRE_PHASE3'`, `processed_at=now()` where `source_rowid <= cutover`. Rows with `source_rowid > cutover` stay PENDING and are the only new eligible messages. History remains stored and queryable.
- Add a router activation gate (e.g., `app_settings.phase3_router_enabled` or a dedicated env flag); the route/process action refuses with `ROUTER_DISABLED` until the migration and authorization setup are complete.
- Add a defense-in-depth router guard: `source_rowid > cutover` (fallback `id > cutover_id` only when `source_rowid` is null). This prevents a stray PENDING historical row from being claimed even if the marking is skipped or re-run.
- Replace the capture-scope authorization with an explicit business allowlist before enabling: set every `whatsapp_chats` row to `authorized=false` and configure only the Owner-approved Cash/Orders chats with the correct purpose, **or** add a separate `whatsapp_processing_chats` allowlist. Configure the verified WA-01 Admin JID(s) in `whatsapp_accounts.admin_jids` and populate `escort_client_group_authorizations` for approved group participants. Do not reuse the Phase 2 “capture everything” `BOTH/true` rows as business authorization.

**How migration/deployment timing is handled:** the router is disabled while the migration runs. New bridge rows arriving during the migration have `source_rowid` above the captured checkpoint, so they are not marked historical and remain PENDING for post-enable processing. A worker restart/replay cannot lower the watermark; the `ON CONFLICT` upsert updates existing rows and does not create rows below the checkpoint. Delayed WhatsApp messages with old timestamps but new rowids are eligible, which is the intended behavior. After the migration commits, the Owner configures the business allowlist and enables the router.

**Required future changes (not implemented):**
- Migration: append the cutover capture/marking to 004, or add a new `008_phase3_cutover.sql` after 007 (recommended for separation; bump `schema_meta` accordingly).
- Router: activation-gate check and the watermark guard in `claimMessages()`; return `ROUTER_DISABLED`/`HISTORICAL_SKIPPED` rather than silently processing.
- Authorization: the explicit chat/participant/Admin allowlist described above.
- Tests: focused cutover tests (see below), plus the existing 49-test suite.

**Race-condition analysis:**
- Migration vs sync worker: the checkpoint is captured first; bridge rowids are append-only; rows above it are new and stay PENDING. Rows at/below it are already committed and correctly marked historical.
- Router vs migration: the activation gate prevents claims until the migration commits; the router then sees the final rows.
- Concurrent routers: `FOR UPDATE SKIP LOCKED` + the `PROCESSING` status ensure one claimer.
- Crash/restart: `PROCESSING` older than 30 minutes is reclaimed; `FAILED` retries after the 10-minute backoff with `retry_count < 10`; `processing_status` prevents duplicate work after restart.
- Duplicate replay: message identity plus the Cash `cash_instructions_source_identity` / program duplicate rules keep business rows unique.
- Unauthorized chats/participants: the allowlist and `escort_client_group_authorizations` remain fail-closed; WA-02 is rejected.
- Delayed messages: new `source_rowid` → eligible; timestamps are never used for eligibility.

**Test plan (isolated test DB; not yet added):**
1. Pre-cutover historical PENDING row (`source_rowid <= cutoff`) → cutover marking → router processes 0; row is COMPLETED/HISTORICAL.
2. Post-cutover row (`source_rowid > cutoff`) → processed into the expected Cash/Vessel record.
3. Delayed message with an old `source_timestamp` but a new `source_rowid` → eligible.
4. Duplicate replay of a post-cutover message → no duplicate instruction/program.
5. Concurrent router calls → one claim.
6. Crash recovery (`PROCESSING` older than 30 minutes) → reclaimed without duplication.
7. Unauthorized chat (`authorized=false`/wrong purpose) → ignored.
8. WA-02 message → no Cash/Vessel record.
9. Cash-vs-Vessel separation: payment text in an ORDERS chat, vessel text in a CASH chat → no cross-domain record.
10. Activation gate disabled → route/process returns `ROUTER_DISABLED` and writes nothing.
11. Empty `admin_jids` → Cash rejected; configured Admin JID → processed.
12. A new row inserted during the cutover → remains eligible, not marked historical.
13. Re-running the cutover marking → idempotent; no new rows marked.

**Rollback:** the cutover is a data update; the Phase 2 app ignores the new columns, so an app-only rollback to `20261105-phase2` is safe. Re-running the cutover only marks rows at/below the fixed watermark. A full DB rollback to 1.2.0 still requires a fresh restore; no down migrations. Keep the `20261105-phase2` image and take a fresh verified dump before the cutover.

**Owner decisions required:** the authorized Cash chat(s), Orders chat(s), group participants and WA-01 Admin JID(s); the cutover window and router-enable time; B+D versus adding the explicit `processing_eligible` flag (C); whether to pause ingestion during the index/marking window; acceptance of no CI run (billing lock); and whether any historical backfill is ever approved (separate task only).

**Task 5F.2B — Live Router cutover gate (IMPLEMENTED; test-verified 2026-11-06; not deployed):**
- **Default disabled:** `routePendingMessages()` loads the activation config before any claim. `app_settings.phase3_router_enabled` must be JSON `true`; otherwise it returns `{disabled:true, reason:'ROUTER_DISABLED'}` with zero claims and zero business writes. Both `/api/whatsapp` actions `route` and `process` delegate to this function, so both are gated; direct internal callers cannot bypass it.
- **Per-account watermark:** `app_settings.phase3_cutover_rowid:<account>` is an explicit non-negative JSON number, captured at cutover and never advanced automatically. `app_settings.phase3_business_chats:<account>` is an explicit JSON array of chat JIDs (an empty array is valid for identity-only WA-02). Every account in `whatsapp_sync_state` must have both; missing/invalid any account disables the router. Absence never defaults the watermark to zero.
- **Claim query:** requires `source_rowid IS NOT NULL AND source_rowid > phase3_cutover_rowid:<m.account_id>` and `phase3_business_chats:<m.account_id>` contains `m.chat_jid`, while preserving the existing PENDING/FAILED/PROCESSING retry rules, `FOR UPDATE SKIP LOCKED`, retry limits and message identity.
- **Historical safety:** no bulk UPDATE and no status rewrite. Historical rows retain their existing `processing_status` and are simply ineligible for Live Routing. Historical Backfill remains a separate path and is not gated by this watermark; it may parse an eligible historical message under its own authorization.
- **Authorization:** capture `whatsapp_chats.authorized=true` is not business authorization. The explicit `phase3_business_chats` allowlist is required; the existing `whatsapp_chats` purpose/authorized checks, WA-01-only Cash/Vessel rules, `admin_jids` for Cash, group-participant authorization and WA-02 rejection remain in force.
- **Tests:** new `tests/standalone/router-cutover.test.mjs` **18/18**; existing `message-router.test.mjs` **49/49**; combined **67/67**; Review API **7/7**; finance **3/3**. The tests use a synthetic test-only activation state and watermark; production remains disabled (0 `phase3_%` rows in production `app_settings`).
- **Remaining production prerequisites:** configure the three keys with the Owner-approved Cash/Orders chats, group participants and WA-01 Admin JID(s); capture the real per-account cutover watermarks at deployment (audit-time checkpoints wa-01 19,588 / wa-02 15,145; recapture at the actual cutover); fresh verified backup; incremental migration/grant path; maintenance window; CI evidence. **Production Phase 3 routing is not activated.**

## 11. Mandatory maintenance rule — overwrite current state, do not append history

**Every code, configuration, schema, feature, workflow, port, URL, folder, Docker, Git, or deployment change MUST update this file in the same commit.** This includes feature removals and failed/blocked implementations that materially affect the current picture.

1. Read this file **before** modifying the system.
2. Inspect only the affected source/config/runtime area; do not launch a full audit for every small edit.
3. Update **only the affected existing sections/rows**: URLs/ports, folder paths, features, pipelines, status, blockers, resource measurements and release SHA as relevant.
4. **Replace stale values**. Do **not** append daily entries, repeated reports, old snapshots or sequential change histories.
5. If a pipeline is added, removed, split or merged, **renumber/recount the inventory and update its status**.
6. Distinguish **code present**, **tested**, **live**, **pending**, and **unknown**. Never upgrade a status based on inference.
7. Update the top “Last reconciled” date, Git commit baseline (after commit), and deployed image/commit **only when actually known**. Avoid a self-referential commit-SHA loop: use the last independently verified commit SHA or state “current commit” until pushed.
8. Update relevant `README.md` or `docs/` only when their detailed instructions changed; keep this file authoritative.
9. **Commit this file with the related code change and push `main`**. A docs-only correction is a valid standalone commit; it does not require an image rebuild or deployment.
10. Final agent report should state: **what changed, which sections were refreshed, commit SHA, push status, and whether production was deployed**.

**Anti-patterns:** append-only timeline; claiming a pipeline is complete from a UI route; copying raw secrets into docs; hiding failed checks; retaining obsolete ports/URLs; confusing old production with new standalone; rebuilding the image for documentation-only changes.

## 12. Handoff in one sentence

**AL-RIFA'I is a live, lean Next.js/PostgreSQL platform with two bridge-SQLite ingestion paths, continuous tail on both accounts, shared identity evidence, new-media capture, and an authenticated Review Queue that surfaces source-message evidence, extracted/missing fields, reasons, audit history and role-checked decisions for Cash and Vessel; the next engineering work is GitHub CI/release validation, richer contact identity, document/sticker live proof, retention, and domain-specific conversation/AI workflows—not another infrastructure rebuild.**
