# AGENTS.md — AL-RIFA'I platform (agent reference)

## System Overview

- **App:** AL-RIFA'I Integrated Services business platform — employees, vessel orders/releases, cash & accounts, attendance, payroll, reports, admin.
- **Source:** `/opt/al-rifai-platform`
- **Repo:** `git@github.com:arshiyaazim/al-rifai-platform.git`
- **Branch:** `main` @ `1e68ff1` (2026-11-13)
- **Current version:** `v3.3.0-escort-release`
- **Current image:** `local/al-rifai-platform:v3.3.0-escort-release` (app + sync, same tag)
- **Schema:** `1.13.7` — 25 migrations; 60 migration-managed tables plus 6 runtime `*_snapshot` tables (66 in production)
- **Web URL:** `https://app.al-rifai.iamazim.com` (also `alrifai.iamazim.com`, `al-rifai.iamazim.com`)

## Key Paths

| What | Path |
|---|---|
| Repo `.env` (compose interpolation) | `/opt/al-rifai-platform/.env` |
| Live container `.env` (`env_file`) | `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` |
| Compose files | `compose.yaml`, `compose.phase3.yaml` |
| App entry (Next.js App Router) | `app/` |
| Sync worker | `scripts/sync-worker.mjs` |
| Cash parser | `lib/cash-elements.mjs` |
| Release parsers | `lib/release-slip.ts`, `lib/release-parser.ts` |
| Message router | `lib/message-router.ts` |
| Display helpers | `lib/display-mobile.ts`, `lib/display-name.ts` |
| Install / migrate | `scripts/standalone/install.mjs`, `scripts/standalone/migrate.mjs` |
| Release backfill / join-date backfill | `scripts/backfill-release-slips.ts`, `scripts/backfill-employee-join-date.ts` |

UI routes under `app/(workspace)/`: `/home`, `/insights`, `/assistant`, `/employees`, `/employees/[mobile]`, `/employee`, `/employee/[phone]`, `/vessel`, `/vessel/[id]`, `/vessel/drafts`, `/vessel-register`, `/vessel/register`, `/vessel/vessel-register`, `/release`, `/attendance`, `/cash`, `/cash/[id]`, `/cash/archive`, `/cash/employee/[employeeId]`, `/cash/paid`, `/cash/paid/[id]`, `/cash/submissions`, `/cash/transactions`, `/payroll`, `/review`, `/review/[id]`, `/messages`, `/message-mirror`, `/conversations`, `/reports`, `/archive`, `/audit`, `/settings`, `/settings/api-keys`, `/settings/recruitment`, `/sources-review`, `/submissions`, `/transactions`, `/transactions/employee/[phone]`, `/income-expenditure`, `/register`. `/dashboard` 307-redirects to `/home`.

## Deploy

```bash
cd /opt/al-rifai-platform
docker build -t local/al-rifai-platform:<tag> .
# set ALRIFAI_TAG=<tag> in BOTH .env files
docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app sync
```

**App and sync always deploy together on the same tag.**

## Database

- Production: PostgreSQL container `vps-infra-postgres-1`, database `alrifai_v2_phase3`, owner user `alrifai_app` (runtime role `alrifai_v2_runtime`).
- Migrations: 25 files (`db/standalone/001`–`026`), checksum-locked in `schema_migrations`.
- Key tables: `employees`, `programs`, `vessels`, `program_assignments`, `program_pay`, `cash_instructions`, `cash_postings`, `ledger_entries`, `cash_submissions`, `review_items`, `attendance`, `attendance_records`, `whatsapp_messages`, `whatsapp_media`, `api_keys`, `recruitment_reply_log`.
- Fresh install: `node scripts/standalone/install.mjs`; incremental: `node scripts/standalone/migrate.mjs` (both read the PG env).

## Operator rules

- `displayMobile()`: **11 digits, no country code** (`+8801…`/`8801…` → `01…`); display only, never rewrite stored values.
- Join date = earlier of first cash-payment message time and first vessel assignment start date (Asia/Dhaka); never `created_at`/import time.
- Security attendance = every attendance day not covered by a vessel program assignment; Vessel + Security = total days.
- Cash parser is element-based (mobile + name + amount).
- No technical columns in the UI (hash, JID, proc numbers, internal IDs).
- Pagination dropdown sits at the bottom of tables.
- Unauthenticated page requests → 307 `/login`; the `/api/` namespace keeps JSON `401`.

## Recent batches

- **6** — cash autoconfirm fixes (element parser, employee auto-create, accountant gate).
- **7** — UI diagnosis: Phase 4 UI existed only on `feat/15-task-roadmap`.
- **8** — merge into `main` (`v3.0.0-phase4-merged`); install-grant and `programs.event_at` fixes.
- **9** — UI polish, security attendance, join-date backfill, `/home`, login redirect (`v3.2.0-home-security`).
- **10** — escort release parser + `/release` review page + structured backfill (`v3.3.0-escort-release`).
- **11** — docs/image/git cleanup; **12** — recruitment AI 5-step flow + follow-ups (`0.1.12-flow`).

## Rollback

- Current: `local/al-rifai-platform:v3.3.0-escort-release`
- Available: `local/al-rifai-platform:v3.2.0-home-security`, `local/al-rifai-platform:v2.9.1-cash-autoconfirm`
- Set `ALRIFAI_TAG` in both `.env` files and re-run the compose command.

## Safety boundary

- Never run migrations, cash postings, deployments, Docker rebuilds, WhatsApp
  pairing or outbound sends against production from this repository without a
  separate Owner approval.
- Production inspection is read-only. Schema execution, integration tests and
  experiments belong in a disposable database/container.
- Never discard unrelated dirty files, backups or branches. Do not use
  `git reset --hard`, destructive `git clean` or force-push.

## Cash / WhatsApp rules

- **Current deployed scope:** WA-01 / Bridge-1 is the only Cash/Vessel source
  account. WA-02 / Bridge-2 is identity-only in the current runtime and must not
  create Cash or Vessel records with the current configuration.
- The Owner-intended **Bridge-2 / WA-02 Escort Order intake and Bridge-2 →
  Bridge-1 draft handoff** workflow is **not implemented and not verified** in
  this repository. Do not infer permission or field rules from the identity-only
  current state; any expansion requires an explicit Owner-approved scope,
  participant list, bridge policy and separate implementation.
- A Cash payment is eligible only when it is an OUTGOING message from the
  verified Admin to the single authorized Accountant direct conversation,
  with valid provenance (message ID + block key). Do not broaden access.
- Owner single-mobile rule: when an eligible payment block has exactly one
  identifiable mobile number, that number is BOTH `employee_mobile` and
  `payout_mobile`. Two numbers keep the canonical ID + payout structure. Three
  or more numbers are ambiguous and go to review.
- Never invent a payment method. Accept only the verified markers and labels
  already used by the parser (`B/N/C/R`, `BKASH/NAGAD/CASH/ROCKET/BANK`, including
  the Bangla equivalents). A missing method is an incomplete instruction.
- A cash payment for an unknown mobile auto-creates that employee identity
  (`AUTO_CREATED_FROM_CASH`) and records the link as `REGISTERED`; never attach
  the payment to a different employee.

## Cash source of truth and event time

- The source of truth for Cash is `whatsapp_messages`, not legacy Cashbook or
  Excel data. Legacy `IMPORT` rows were replaced by WhatsApp-linked rows in the
  v1.12.0 overhaul.
- `whatsapp_messages.source_timestamp` is the real WhatsApp event time.
  `created_at` is the database insertion time; `mirrored_at` is the mirror time.
  Never substitute one for another.
- `cash_instructions.event_at` stores the real event time and is used for
  display, payout numbering and cumulative totals. `cash_instructions.created_at`
  remains the database insertion/backfill time.
- Verified Admin (WA-01) OUTGOING payment instructions in the Accountant direct
  chat are auto-POSTED under the Owner-approved Cash exception. Incomplete
  blocks remain `cash_submissions` in `PENDING_REVIEW`.

## Paid vs POSTED

- **Business Paid** = a verified `cash_payment_events` row.
- **Financial POSTED** = an immutable `cash_postings` / `ledger_entries` write.
- **Owner-approved Cash auto-post exception:** a verified Admin (WA-01)
  OUTGOING payment instruction in the Accountant direct chat creates a
  `POSTED` `cash_instructions` row plus `cash_postings` and `ledger_entries`
  automatically. No separate approval step is required for that Cash path.
  This exception is limited to Cash; Vessel and other domains retain their
  existing authorization flows.
- When `PHASE3_PAID_EVENTS_ENABLED=1`, the same verified WhatsApp payment may
  also append a Business Paid Event. The Business Paid Event is still separate
  from the financial posting.
- Manual / non-WhatsApp financial posting keeps its separate `cash.post`
  authorization.
- Business corrections/reversals are append-only events. They must never
  generate a financial ledger reversal automatically.
- `PHASE3_PAID_EVENTS_ENABLED` defaults to `'0'`. It is separate from the
  Phase 3 router cutover setting.

## Admin Paid Events API/UI

- `GET /api/finance?resource=business-paid` is the list; filters and pagination
  are server-side and totals must reconcile with `businessPaidSummary()`.
- `GET /api/finance?resource=business-paid-event&id=...` returns the root
  PAYMENT chain, employee, WhatsApp/Office evidence, instruction/posting link,
  corrections, reversal and audit.
- `business-paid.correct` and `business-paid.reverse` reuse the existing
  `cash.review` + ADMIN services. They require a reason, use the normal CSRF
  mutation path and remain append-only.
- UI routes are `/cash/paid` and `/cash/paid/[id]`. Actions render only for
  `cash.review` and only when the Paid flag is on.
- Financial POSTED stays on `/cash/transactions`. The two bases must be labelled
  explicitly; never present a Business Paid total as a ledger total.

## Reporting basis

- When `PHASE3_PAID_EVENTS_ENABLED=0`, dashboard and transaction reporting keep
  the Phase 2 POSTED-only definition.
- When enabled, summary and Business Paid detail use the business-event basis
  plus historical POSTED rows with no event. A posting linked to a business
  event is never counted twice.
- All date boundaries use `Asia/Dhaka`.

## Database — migration rules

- Technical references:
  `docs/MIGRATION_010_VESSEL_DRAFT_DELIVERY.md`,
  `docs/MIGRATION_011_CASH_PAYMENT_EVENTS.md`,
  `docs/PHASE3_GIT_COMPLETENESS_AUDIT.md`.
- Migrations run in numeric order. 010 (`vessel_draft_deliveries`) must precede
  011 (`cash_payment_events`). Do not renumber them after they are deployed.
- Applied migration files are checksum-locked by `schema_migrations`. Changing
  an applied file requires an explicit, reviewed `--allow-checksum-change`.
- Staged application: `migrate.mjs --through=010` applies only 010. Normal
  `migrate.mjs` then applies 011. Runtime grants are presence-aware so a stage
  can run before later tables exist.
- Vessel Draft worker and transport are default-disabled
  (`ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0`,
  `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=0`, DB
  `vessel_draft_outbound_enabled=false`). Do not enable without the exact
  approved sender/recipient, socket/token and one-message verification.
- Vessel Draft recipients are never invented. `resolveDraftRecipient()` uses the
  **same original authorised order-giving conversation** (direct Escort Client
  chat or approved ORDERS group). Admin JIDs are never a fallback; missing,
  ambiguous, mismatched or non-allowlisted conversations are refused. The worker
  re-resolves the source conversation and verifies the bridge identity
  (`get_native_account_identity`) before every send. Use
  `scripts/standalone/vessel-draft-activation.mjs` for read-only preflight;
  `--enqueue` and `--tick` require explicit confirmation flags and `--tick`
  still requires all five gate blocks.
- `cash_payment_events` and `cash_payment_event_postings` are append-only.
  Corrections/reversals are new rows; never UPDATE/DELETE financial history.

## WhatsApp message mirror

- The bridge SQLite stores are the source of truth. `scripts/sync-worker.mjs` is
  the **only** process that reads them; the parser/router must read
  `whatsapp_messages`, never a bridge file directly.
- Stable identity is `(account_id, chat_jid, message_id)`. A mirror row is not
  committed until the Main Database transaction commits; the checkpoint advances
  only after that.
- Preserve source values. `raw_payload` keeps the original fields; when
  PostgreSQL cannot carry NUL/lone surrogates, `raw_payload.content_base64`
  preserves the exact bytes and marks `content_sanitized:true`.
- `--mode=reconcile` performs the full source↔main comparison and applies late
  edits/revocations; it runs on startup and periodically. `--mode=media-status`
  records an explicit `STORED`/`FAILED`/`SKIPPED` row for every capturable source
  media message and never reports an uncopied file as `STORED`.
- Verify with `node scripts/verify-message-mirror.mjs` (read-only). Production
  `--mode=reconcile`, `--mode=media-status`, image rebuild/recreate and any
  production repair require explicit Owner approval.
- Mirrored messages from both bridges are authoritative for the application.
  Business processing scope is separate: Vessel/Cash currently processes WA-01
  only; enabling WA-02 is a separate approved workflow.

## Recruitment AI (separate application)

- `/opt/al-rifai-recruitment-ai` is a separate application in its own container
  (`al-rifai-recruitment-ai`). It is **not** part of this Compose project and
  must not be started or changed with `docker compose`.
- It reads the **same** bridge store,
  `/var/lib/vps/whatsapp/wa-02/store/messages.db`, through a read-only mount
  (`/wa02/store`). It never writes to the bridge database.
- It writes only its own local SQLite (`data/recruitment.db`) and mirrors audit
  rows to PostgreSQL `recruitment_reply_log` in `alrifai_v2_phase3`.
- Its WhatsApp DB path inside the container is `/wa02/store/messages.db`; the
  send transport is the WA-02 MCP control socket, not the mirror tables.
- Deployment is a manual `docker run`; `docker-compose.yml` in that repository is
  stale and must not be used. See its `README.md` for the exact command.
- Both applications share the WA-02 bridge schema, so a bridge schema change
  requires reviewing and updating both. Recruitment AI never reads
  `whatsapp_messages` and never creates Cash, Vessel or mirror rows.

## WhatsApp message intelligence

- Keep event time, ingestion time and mirror time separate:
  `source_timestamp` (authoritative WhatsApp event), `created_at` (first
  ingestion), `mirrored_at` (last synchronization). Never substitute one for
  another.
- The canonical message is `whatsapp_messages`. `whatsapp_message_intelligence_view`
  is a read-only projection; `whatsapp_message_intelligence` is review metadata,
  not a second message table.
- Do not fabricate names or phone numbers. Saved contact name, Owner contact
  name and WhatsApp push name are distinct sources; unresolved identities stay
  `UNRESOLVED`/`NOT_AVAILABLE`. A LID is never converted without a verified PN
  link.
- Media `STORED` requires a verified file. `MISSING`, `FAILED`, `SKIPPED` and
  `NOT_APPLICABLE` are distinct; every media message remains visible.
- Calls are separate bridge events (`whatsapp_calls`), not messages. Do not
  invent a call ID or turn a message into a call; per-message call trace is
  `NOT_AVAILABLE` when there is no link.
- Identity role and business domain are classification only. They never grant
  authorization. Manual review writes the intelligence side table and
  `audit_events`; it must not alter chats, WhatsApp permissions, Cash, ledger or
  Vessel state.
- Migration 012 is additive and must be applied before deploying this code.

## Escort order / confirmation / release workflow

- An Order Draft requires **both** source authority and identity: WA-01, a DIRECT
  conversation with `whatsapp_chats.source_role = ORDER_INTAKE`, an INCOMING
  message, and a sender/conversation that resolves to the same EXACT canonical
  PN in `identity_aliases` (or an active `ESCORT_CLIENT` registry entry). A
  display name never authorizes intake.
- Groups are never an Order Intake source. The approved Support group is
  support-only, the approved Release group is release-only, and the remaining
  approved vessel group is context-only. Group roles come from an explicit
  `source_role` or the approved group-JID map — never from a display name or a
  message keyword. An unclassified group is `REVIEW_REQUIRED` and blocked.
- Mandatory order fields: Mother Vessel, Lighter Vessel, Master Mobile. One
  Lighter → one Draft. Missing fields go to review; nothing is fabricated.
  Client-supplied Escort assignment fields are reviewed, never drafted.
- The Admin confirmation is a verified Admin OUTGOING WA-01 reply in the SAME
  original direct client chat, linked to exactly one Draft by conversation,
  normalized vessel names, Master Mobile, shift and chronology. Persist
  `confirmation_message_id`, `confirmation_chat_jid`, `confirmation_sender_jid`,
  `confirmation_account_id` and `confirmation_timestamp`. Never confirm from a
  group, a different client, WA-02, an incoming message or an unverified sender.
- Release processing is limited to the approved Release Information group and an
  authorized participant. It updates the exact existing program; it never
  creates one. Persist `end_date`, `end_shift` and the `release_*` provenance.
  Never overwrite `start_date` or `start_shift`.
- Release and confirmation are idempotent. Ambiguous, conflicting or
  already-completed cases go to the Review Queue; prior values are preserved.
- Migration 013 is additive (schema 1.8.0) and must follow 012.
- Full data contract: `docs/ESCORT_ORDER_RELEASE_WORKFLOW.md`.

## Verification commands (isolated test DB only)

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:standalone
pnpm test:paid-events
pnpm build
```

Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSCHEMA`, `PGUSER`, `PGPASSWORD`,
`ALRIFAI_REVIEW_DB_USER` and `ALRIFAI_REVIEW_PASSWORD` to a disposable database.
Never point these at production.

## Pending work (operator)

1. **165 pending release slips** — manual review on `/release` (5 have no matching cash payment).
2. **5 release slips without a cash payment** — verify manually on `/release`.
3. **3 incomplete structured slips** — missing escort mobile or end date.
4. **5 structured slips without an eligible program** — create/correct the program first.
5. **`al-rifai-app-1` stopped container + `local/al-rifai:target02-final`** — remove the container, then the image.
6. **`/opt/vps/AGENTS.md` §0 is stale** (old container/DB/image, 75-migration ledger) — operator edit.
7. **6 `*_snapshot` tables** are outside the migration chain (66 vs 60 tables) — decide whether to add a migration.
8. **4.93 GB unused Docker volumes** — inspect before removing.
9. **8 git worktrees** (7 under `/opt`, 1 under `/tmp/opencode`) — all merged; remove when no longer needed.
10. **Dead release code**: `lib/release-scan.ts`, `release-apply.ts`, `release-retry.ts`, `release-evidence.ts`, `food-bill-match.ts`.
11. **9 known `test:standalone` failures** (Phase 4 semantic drift) — see the Batch 10 report.
12. **Admin page separation** — user/key management currently lives in `/settings`.
