# AGENTS.md — AL-RIFA'I platform invariants

This file records the rules an automated agent or engineer must preserve when
changing this repository. It is intentionally short; detailed design notes live
in `docs/` and the Phase 3 reports.

## Current release (2026-11-13)

- **Version**: `v3.0.0-phase4-merged`, image `local/al-rifai-platform:v3.0.0-phase4-merged`.
- **Schema**: `1.13.7`, 60 tables, **25 migrations (001–026)**. Live DB `alrifai_v2_phase3`.
- **Branch**: Phase 4A–4E UI is merged into `main`. `feat/15-task-roadmap` is
  merged and **no longer the source of truth**; do not treat it as current, and
  do not delete the branch. Build production images from `/opt/al-rifai-platform` (`main`).
- **Deploy**: `docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app`
  after building and setting `ALRIFAI_TAG` in both `.env` files.
- **Rollback**: `local/al-rifai-platform:v2.9.1-cash-autoconfirm`.
- Historical version/schema numbers below (v1.12.0, 1.13.x intermediate levels)
  describe past releases, not the running system.

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
- An unregistered employee mobile is recorded as `UNREGISTERED`; never attach
  the payment to a different employee and never auto-create an unrelated one.

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

## Database

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