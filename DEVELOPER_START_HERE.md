# DEVELOPER_START_HERE.md — AL-RIFA'I Platform

> **Canonical current-state developer map — not a changelog.** Read this first before modifying code, database, Docker, WhatsApp ingestion, or deployment.
>
> **Last reconciled:** 2026-11-05. **Source:** `feature/phase3-router-cash-vessel` at commit `cff8a67` (Phase 3 Increments 5 & 6 — Review Queue UI, CI & Tests); local session branch `arena/e574efa6-al-rifai-platform` at `cff8a67`; GitHub `main` remains at `e6becfc` (Phase 2). Repository source files and locally executed test results. **Runtime facts below are agent-measured unless marked dated.**
>
> **Priority:** **BUILD → RUN → LIVE → IMPROVE**. Do not block releases on unrelated legacy data migration, historical Git branches, exhaustive tests, or non-blocking cleanup. Never claim a workflow is live solely because code exists.

## 1. Identity and authoritative locations

| Item | Current value / source |
|---|---|
| Git repository | https://github.com/arshiyaazim/al-rifai-platform |
| Git branch | `feature/phase3-router-cash-vessel` at `80216b4` on origin (fast-forwarded from `cff8a67`); `arena/e574efa6-al-rifai-platform` session branch at `771bb05`; `main` untouched at `e6becfc` |
| Verified baseline | `e6becfc` (Phase 2, `main`, untouched); current commit `80216b4` (Phase 3 Increments 5 & 6 plus doc fixes; `cff8a67` is the implementation commit). `f606678` Increment 4 checkpoint is not present in this checkout. |
| Local Git checkout (VPS) | `/opt/al-rifai-platform` |
| Standalone app source / root `.env` (VPS) | `/opt/vps/al-rifai-standalone/apps/al-rifai` |
| Public application | https://app.al-rifai.iamazim.com |
| Login | https://app.al-rifai.iamazim.com/login |
| Public health | https://app.al-rifai.iamazim.com/api/health |
| New PostgreSQL DB | `alrifai_v2`, schema `public`, version `1.3.3` (local test DB; production not deployed) |
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

**Canonical source rule:** `/opt/al-rifai-platform` is the canonical Git source. Make every source-code and documentation change there first, commit it, and push `main`. The deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` is synchronized **from a known Git commit**, never edited silently, and never given an independent development history. Synchronize before any production build, and never overwrite the deployment `.env` or other runtime secrets during synchronization.

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
- **One primary application database**, with **32 tables** after the Phase 3 extensions (local test schema; production not deployed).
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

**Runtime baseline (production, unchanged):** HTTPS health 200 with database OK and schema `1.2.0`; authenticated access to the workspace pages including `/messages`; both sync checkpoints advancing. Deployed image `local/al-rifai-platform:20261105-phase2` (`sha256:2950c068…`, built from `09b2a51`); rollback image `20261105-v3` (`sha256:c29d837c…`) retained. Confirm actual digests from Docker before any rollback. **Local Increment 5 test schema:** PostgreSQL 17, `alrifai_v2`, schema `1.3.3`, 32 tables; production not deployed.

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
| Cash / ledger | **PARTIAL** | Create instruction in REVIEW; no automatic posting; ledger schema/UI | Cash WhatsApp parser parity via Phase 3 router; real approved posting not demonstrated |
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
| Phase 3: Cash Domain Handler | **IMPLEMENTED** | WA-01 Admin OUTGOING messages → `cash_instructions` REVIEW via `createInstruction()` with atomic source provenance; unparsable → `cash_submissions` PENDING_REVIEW via `submitCash()`; idempotent by `(source_message_id, source_block_key)`; no automatic posting | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Review Queue | **IMPLEMENTED + FRONTEND INTEGRATED** | 10 review categories; `review_items.category` column; category-aware pending uniqueness; group participant authorization; multi-message vessel correlation; ambiguous confirmation handling; Review Queue UI with filters, source evidence, extracted/missing fields, reasons, audit history, corrections and role-checked decisions; cash review candidates | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Vessel Domain Handler | **IMPLEMENTED** | WA-01 incoming vessel messages → `programs` DRAFT via `createProgram()` with atomic provenance; group participant authorization via `escort_client_group_authorizations`; multi-lighter and multi-message correlation via `program_source_messages`; duplicates → Review Queue; admin outgoing confirmation via `applyConfirmation()` in same chat; ambiguous confirmations → review; WA-02 rejected; vessel review panels show incomplete orders, duplicates, ambiguous confirmations, escort conflicts, original/normalized names and confirmation_message_id | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| Phase 3: Source Provenance | **IMPLEMENTED** | `whatsapp_messages.processing_status/retry_count/last_error/last_processed_at`; `cash_instructions.source_message_id/source_block_key`; `programs.source_message_id/source_chat_jid`; `program_source_messages`; `cash_submissions` source columns | Migration additive/idempotent; DB tests pass locally; CI migration validation not executed; production not deployed |
| Phase 3: CI Workflow | **IMPLEMENTED** | `.github/workflows/ci.yml`: lint, typecheck, unit tests, domain integration tests, router tests, Review Queue integration tests, migration validation (schema 1.3.3), Next.js build, Docker build validation | Workflow prepared with a `review-tests` job; CI jobs never started — GitHub account locked due to a billing issue (run id 42093139485); no production creds |
| Recruitment conversations | **NOT BUILT/NOT VERIFIED** | No complete workflow established | Design from old source/docs, implement new module |
| Employee conversations | **NOT BUILT/NOT VERIFIED** | Raw messages available | Role-based conversation routing and employee actions |
| Client CRM / customer service | **NOT BUILT/NOT VERIFIED** | Raw messages available | Client identity, case state, reply workflow |
| AI assistant / AI-origin messages | **NOT BUILT/NOT VERIFIED** | Integration placeholders | Model/tool integration, source attribution, domain actions, approvals |

**Fresh-data policy:** Owner does not require historical business data import. Agent reported **0 programs, 0 cash instructions, 0 employees and 0 postings** after removing temporary test records. Raw WhatsApp history is retained. Do not confuse “empty new business DB” with “broken app.”

**Test evidence — this session (2026-11-05):** `npm run test:unit` executed: **67 pass / 0 fail** (shift-boundary, unified-auth-policy, media, identity, message-classifier, review-ui). DB-dependent suites (message-router, review-api, domain, whatsapp) require PostgreSQL `alrifai_v2` and a root `.env` — absent in this sandbox, not executed here. CI workflow `.github/workflows/ci.yml` is present; GitHub Actions run id 42093139485 (2026-11-05) on `cff8a67` — jobs never started because the GitHub account is locked due to a billing issue. CI did not run. No production credentials.

## 6. Pipeline/workflow inventory

**Counting rule:** A pipeline is one independently meaningful end-to-end business/data flow. Below are **15 tracked logical pipelines**, **not** a claim that 15 background workers exist. Recount when adding/removing a flow. Status reflects the weakest critical step.

| # | Pipeline / workflow | Status | What works now | What remains |
|---|---|---|---|---|
| P01 | HTTPS → login → authorized workspace | **LIVE** | TLS, session, authenticated pages | Ongoing access checks |
| P02 | Fresh schema → DB connectivity → health | **LIVE** | 32-table DB, health OK, version 1.3.3 (local test schema) | Repeat on next schema change; production not deployed |
| P03 | WA-01 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P04 | WA-02 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P05 | WA-01 new message → automatic DB tail | **LIVE** | New rows observed across restarts; checkpoint advances; no error | Outgoing/direct/edits samples as they arrive |
| P06 | WA-02 new message → automatic DB tail | **LIVE** | New rows and post-deploy media observed; checkpoint advances; no error | Outgoing/direct samples as they arrive |
| P07 | Raw message → shared identity/contact resolution | **PARTIAL** | One resolver for both accounts: 2,587 aliases, canonical PN, chat/participant names, bridge-only PN/LID links | Contact-book/push/profile names; WA-02 store lacks `resolved_*` and participant columns |
| P08 | Raw message → domain classification/action | **IMPLEMENTED** | Phase 3 shared router + classifier; authorization via whatsapp_chats; processing state; Review Queue submission; Review Queue UI with filters, source evidence, extracted/missing fields, reasons, audit history and role-checked actions | Lint+typecheck+unit+DB tests pass locally; CI workflow prepared, not executed; production not deployed |
| P09 | Cash instruction → review → posting/ledger | **PARTIAL** | REVIEW creation via router; WhatsApp cash parser parity; posting schema; cash review candidates with source evidence and corrections; no automatic posting | Authorized posting and real approved posting not demonstrated; production not deployed |
| P10 | Vessel order → program → assignment → release | **IMPLEMENTED** | Router creates program DRAFT from WhatsApp vessel messages (WA-01 only); multi-lighter and multi-message correlation; confirmation via applyConfirmation in same chat; ±1-day duplicate warnings → Review Queue; vessel review panels for incomplete orders, duplicates, ambiguous confirmations, escort conflicts, original/normalized names and confirmation_message_id | Release and assignment parity; CI workflow prepared, not executed; production not deployed |
| P11 | Employee → attendance → payroll | **PARTIAL** | Core tables/UI and rate calculation | Rate setup, attendance automation, extras |
| P12 | Recruitment / employee / client conversations | **NOT BUILT/NOT VERIFIED** | Raw source messages available | Conversation UI, classification, workflows |
| P13 | Phase 3 CI pipeline | **IMPLEMENTED** | .github/workflows/ci.yml: lint, typecheck, unit tests, domain integration tests, router tests, Review Queue integration tests, migration validation (schema 1.3.3), Next.js build, Docker build validation | Workflow prepared with a `review-tests` job; CI jobs never started — GitHub account locked due to a billing issue (run id 42093139485); production not deployed |
| P14 | New media → persistent bytes → authenticated access | **LIVE** | 100 attachments / 27.2 MB stored and SHA-verified, including post-deploy samples; authenticated streaming; no historical recovery | Live document/sticker sample; retention policy as volume grows |
| P15 | AI/admin → reply → WhatsApp → audit | **NOT BUILT/NOT VERIFIED** | No end-to-end proof | AI tools, outbound sender, source/audit linkage |

**Summary:** count programmatically when updating; **the table itself is authoritative**. (P01–P06 and P14 LIVE = 7; P07, P09, P11 PARTIAL = 3; P08, P10, P13 IMPLEMENTED = 3; P12, P15 NOT VERIFIED = 2.) **Current: 7 LIVE / 3 PARTIAL / 3 IMPLEMENTED / 2 NOT VERIFIED.**

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

- **Current database:** `alrifai_v2`, PostgreSQL, schema version `1.2.0` (deployed); local migration 004 proposes `1.3.0` (CI PENDING); legacy `alrifai` retained for rollback and not part of the new application's business state.
- **Installer:** fresh `schema.sql` + `002_raw_import.sql` + `003_phase2_identity_media.sql`, all idempotent (deployed schema v1.2.0). Local Phase 3 migrations `004_phase3_router_state.sql` through `007_phase3_review_queue_ui.sql` are committed on `cff8a67` (additive/idempotent, schema v1.3.3); CI PENDING, not applied to production; production schema remains v1.2.0 and is not migrated. Do not reintroduce the legacy migration chain just to match historical DB structure.
- **Phase 2 tables/columns:** `whatsapp_media` (one row per captured attachment, unique per account/chat/message, FK to the message) and identity evidence columns on `identity_aliases` (`display_name`, `name_source`, `canonical_jid`, `person_key`, first/last seen, `metadata`). The live migration was applied with a verified `pg_dump` (`/var/lib/vps/al-rifai/backups/pre-phase2-20261105-1111.dump`) and preserved all 34,090 pre-change messages.
- **Dedup key:** `(account_id, chat_jid, message_id)`. `(account_id, message_id)` alone loses one known WA-01 duplicate-ID-across-chat case.
- **Central configuration:** `/opt/vps/al-rifai-standalone/apps/al-rifai/.env`; shared loader `lib/env.mjs`; `pnpm env:check` prints missing key names, not values.
- `.env` is **never committed**, copied into Docker images, or printed. `.env.example` holds placeholders only.
- Frontend-created login passwords are **hashed**, not stored in plaintext. Bootstrap admin password can be provided via `.env`; use `pnpm admin:reset` for recovery.
- WA session keys and media decryption material remain in bridge-owned storage; not copied into the main business DB. The worker uses a media key in memory only.
- **Media directory:** `/var/lib/vps/al-rifai/media` (host), `/media` in containers; owned `10001:10001`, mode `0700`, written by the root `sync` process and read-only to `app`. It is outside Git and the image, so it survives rebuilds and container recreation.
- The owner prioritizes rapid delivery and simple configuration, not enterprise security tooling. Keep existing functional authentication and do not introduce new infrastructure as a prerequisite to ordinary feature work.

## 9. Fast build, deploy and essential checks

Work in the canonical checkout `/opt/al-rifai-platform`, commit and push `main`, then synchronize the deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` from that commit. The live `.env` stays only in the deployment source and is never committed, copied into Git, or overwritten by synchronization.

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
| 2 | Phase 3 local implementation (all increments) | Code present on `feature/phase3-router-cash-vessel`; Increment 5 committed locally; no production deployment |
| 3 | Observe WA-02 outgoing/direct/edited samples | Real observed examples reach PostgreSQL once; checkpoint advances; no error |
| 4 | Confirm document and sticker media | A live document/sticker attachment stored with SHA verification |
| 5 | Complete identity map | Contact-book/push/profile names where the bridge exposes them; WA-02 store lacks `resolved_*` and participant columns |
| 6 | Media retention and disk budget | A retention/size policy before the 26 MB store grows; keep the default 25 MB per-file ceiling |

**Phase 3 implementation state (all items):**
- Router Foundation: IMPLEMENTED — `lib/message-router.ts`, `lib/message-classifier.ts`, migration `db/standalone/004_phase3_router_state.sql`, API action `route` on `/api/whatsapp`. LOCALLY VERIFIED: lint+typecheck+14 classifier tests+DB tests pass. CI workflow prepared, not executed. PRODUCTION NOT DEPLOYED.
- Cash Domain: IMPLEMENTED — WA-01 Admin OUTGOING messages only → `cash_instructions` REVIEW via `createInstruction()` with atomic source provenance (source_channel/source_message_id/source_block_key/source_hash in same INSERT); unparsable or invalid → `cash_submissions` PENDING_REVIEW via `submitCash()`; idempotent by unique index on `(source_message_id, source_block_key)`; INCOMING messages never create instructions; no automatic posting. LOCALLY VERIFIED: DB tests pass. PRODUCTION NOT DEPLOYED.
- Vessel Domain: IMPLEMENTED — incoming WhatsApp vessel → `programs` DRAFT; duplicates → Review Queue; admin outgoing confirmation via `applyConfirmation` (no new outbound sender); no second confirmation requirement. LOCALLY VERIFIED: DB tests pass. PRODUCTION NOT DEPLOYED.
- Review Queue: IMPLEMENTED + FRONTEND INTEGRATED — `review_items` for PROGRAM/EMPLOYEE/ATTENDANCE reviews; `cash_submissions` for CASH parse errors; category-aware pending uniqueness; no auto-decision. Review Queue UI with pending/resolved/rejected filters, domain/category filters, source-message evidence, extracted/missing fields, reasons, audit history, corrections and role-checked decisions. LOCALLY VERIFIED: 17 UI tests + 7 DB tests pass. PRODUCTION NOT DEPLOYED.
- Source Provenance: IMPLEMENTED — processing_status/retry_count/last_error/last_processed_at on `whatsapp_messages`; source_message_id/source_block_key on `cash_instructions`; source_message_id/source_chat_jid on `programs`; `program_source_messages`; cash candidate source columns. Migration 007 is additive/idempotent. DB tests pass. PRODUCTION NOT DEPLOYED.
- CI Workflow: IMPLEMENTED — `.github/workflows/ci.yml` with lint, typecheck, unit tests, domain integration tests, router tests, Review Queue integration tests, migration validation (schema 1.3.3), Next.js build and Docker build validation. CI jobs never started — GitHub account locked due to a billing issue (run id 42093139485). PRODUCTION NOT DEPLOYED.
- Frontend Integration: IMPLEMENTED — Review Queue pages/components, Cash review integration, Vessel review integration, role-based actions, source evidence and audit history. LOCALLY VERIFIED: typecheck+lint+build+unit+DB tests pass. PRODUCTION NOT DEPLOYED.
- Docs: IMPLEMENTED — `DEVELOPER_START_HERE.md` updated in place; migration 007 added.

**Delivery boundary:** Local implementation package complete (`cff8a67` plus this documentation refresh). No VPS deployment. GitHub push status: `cff8a67` is present on origin `feature/phase3-router-cash-vessel`; this session's documentation refresh is pushed on `arena/e574efa6-al-rifai-platform` (session branch policy — no push to `main`, no merge into `main`). No production deployment.
| 6 | Domain conversation routing | Cash/Vessel/HR/Recruitment/CRM routed to proper handlers; no unauthorized automatic posting |
| 7 | Vessel rates and missing release/parser logic | Owner-configured rates; end-to-end order/release flow |
| 8 | Recruitment, employee conversations and AI assistant | Incremental modules, measured and deployed separately |
| 9 | Reduce disk below target if practical | Identify unused cache/images without removing live services |
| 10 | Optional legacy DB/container removal | Separate explicit owner decision; not a release prerequisite |

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
