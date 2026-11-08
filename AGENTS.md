# AGENTS.md — AL-RIFA'I platform invariants

This file records the rules an automated agent or engineer must preserve when
changing this repository. It is intentionally short; detailed design notes live
in `docs/` and the Phase 3 reports.

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

## Paid vs POSTED

- **Business Paid** = a verified `cash_payment_events` row.
- **Financial POSTED** = an immutable `cash_postings` / `ledger_entries` write.
- A verified WhatsApp payment creates a Business Paid Event automatically when
  `PHASE3_PAID_EVENTS_ENABLED=1`. It does NOT call `postInstruction()` and does
  NOT write `cash_postings` or `ledger_entries`.
- Financial posting keeps its separate `cash.post` authorization.
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