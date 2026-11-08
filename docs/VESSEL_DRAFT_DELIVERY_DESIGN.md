# Vessel Draft delivery — architecture, internal work and activation gate

> **2026-11-08 integration note (supersedes 010-only status below):** in
> `feature/phase3-integration`, 010 is followed by 011 and the combined fresh
> rehearsal target is schema **`1.6.0`, 49 tables, 10 migration rows**. The
> 010-only statements in this historical document (schema stays `1.5.0`, CI
> 46→47) describe the earlier router-branch rehearsal, not the combined branch.
> 010 is now applied in production. A default-disabled worker
> (`lib/vessel-draft-delivery-worker.ts`) and a narrow WA-01
> `send_message` adapter (`lib/vessel-draft-transport.ts`) now exist. Because no
> approved sender/recipient or send permission is configured, delivery is still
> **`MANUAL_COPY_ONLY`** and no message was sent. Sections below that say the
> worker/send call is absent are historical and superseded by this note. Current
> WA-02 scope is identity-only; an Owner-intended Bridge-2 → Bridge-1 order
> workflow is unverified and not implemented.

**Date:** 2026-11-07 (updated after durable-infrastructure completion)
**Status:** Safe internal work **implemented and clone/unit/integration-tested**.
**No outbound transport is enabled and no WhatsApp message is sent.**
**Production migration status: NO MIGRATION APPLIED.** Additive migration
`010_vessel_draft_delivery.sql` is written and verified on a disposable clone of
the exact production schema, but is **pending Owner approval** and is not
applied to production. Until approval the platform stays `MANUAL_COPY_ONLY`.

---

## 1. Intended pipeline (only the first four stages are live)

```
Authorized WA-01 Vessel Order          LIVE (production)
  → parseEscortOrder field extraction  LIVE
  → DRAFT program persistence          LIVE (8 live DRAFTs on 2026-11-07)
  → Owner draft template               LIVE on candidate 7da17f1 (/vessel/drafts)
  → Authorized WhatsApp delivery       NOT ENABLED — this document
  → Admin assignment                  LIVE (Admin reply from WhatsApp client)
  → Confirmation                      LIVE (applyConfirmation → CONFIRMED)
  → Program update                    LIVE
```

The missing stage is **transport**, not parsing, persistence or confirmation.
`lib/order-draft-from-record.ts` still exports `OWNER_DRAFT_DELIVERY =
'MANUAL_COPY_ONLY'`.

## 2. Bridge architecture and identities (read-only verification)

| | WA-01 (Bridge-1) | WA-02 (Bridge-2) |
|---|---|---|
| Container | `vps-whatsapp-wa-01-cap4-20261011` | `vps-whatsapp-wa-02-cap4-20261011` |
| Identity | `8801880446111@s.whatsapp.net` | `8801958122300@s.whatsapp.net` |
| Consumer policies | `messages.read`, `contacts.read`, `media.read`, `calls.read`, `native.contacts.read`, `native.content.read`, `native.events.read`, `native.identity.read`, `calls.policy.read` | `native.identity.read` only |
| `messages.send` | **absent** | **absent** |
| `admin_jids` | `8801880446111`, `8801880446111@s.whatsapp.net`, LID variants | `[]` |
| Phase 3 business chats | 9 allowlisted (orders, cash, release group) | `[]` |

Policy files were inspected at `/etc/vps/services/whatsapp/*-consumer-policy.json`;
no token value is reproduced here. `ai_order_drafts` and `ai_outbound_messages`
have `CHECK (account_id='wa-02')`, so they **cannot** carry a WA-01 draft.

### Delivery direction

- **Sender account:** WA-01 only (`8801880446111@s.whatsapp.net`). WA-02 has no
  send capability and no admin JIDs.
- **Recipient:** one explicitly Owner-approved WA-01 Admin JID (a direct chat,
  NOT a client or release group). The exact JID is a configuration value, never
  hardcoded here.
- **Scope:** one message per DRAFT program, to that one Admin JID. Never to
  client groups. The Admin then replies in the **original order chat**; that
  reply remains the only confirmation (`applyConfirmation()` in
  `lib/standalone/whatsapp.ts`).

This direction must be confirmed by the Owner before activation.

## 3. Internal work implemented (safe, isolated)

`lib/vessel-draft-delivery.ts` — pure, no DB, no bridge, no send:

- `draftIdempotencyKey()` — `vdd_` + SHA-256 of
  `programId + sha256(exact draft text) + recipientJid`. Changing the draft
  text or recipient produces a new key; re-sending an unchanged draft is
  impossible.
- `isOwnerDraftShape()` — validates the exact ten-line Owner layout and
  requires blank Escort Name / Escort mobile lines (the Admin confirmation rule).
- `prepareDraftDelivery()` → `PREPARED` record (`accountId='wa-01'`,
  `recipientJid`, `text`, `attempts=0`). Rejects incomplete drafts.
- `DraftDeliveryStore` interface + `MemoryDraftDeliveryStore` — a real
  WA-01-safe table can be plugged in later without changing the state machine.
- `enqueueDraftDelivery()` — idempotent; an existing key is never queued twice.
- State machine: `PREPARED → QUEUED → SENDING → SENT / FAILED /
  DELIVERY_UNKNOWN / DEAD`. `markSending`, `applyDeliveryOutcome`,
  `isRetryDue`, `requeueDelivery`, `retryDelayMs` (exponential backoff,
  3 attempts max).
  - `SENT` and `DELIVERY_UNKNOWN` are terminal. A timeout or dropped socket
    becomes `DELIVERY_UNKNOWN` and is **never retried automatically** (the
    bridge may already have delivered).
  - `FAILED` may be retried only explicitly and only after backoff.
- `deliveryGate()` — five independent blocks (env switch, DB switch, approved
  sender, approved recipient, transport configured). Default from
  `deliveryGateFromEnv({})` is fully disabled with mode `MANUAL_COPY_ONLY`.
- `buildOutboundRequest()` — prepares (never executes) the smallest possible
  request: `{accountId:'wa-01', recipientJid, text, idempotencyKey}`. Refuses a
  terminal record, a non-sendable state or a recipient mismatch.
- `deliveryViewModel()` — UI projection that never claims a send and carries
  `CONFIRMATION_RULE`.

`tests/standalone/vessel-draft-delivery.test.mjs` — 12 unit tests covering
shape, idempotency, dedup, gate, recipient mismatch, terminal states, bounded
retries and the confirmation invariant. All pass.

## 4. Durable infrastructure — IMPLEMENTED and TESTED (production migration pending)

`lib/standalone/vessel-draft-delivery-store.ts` is the Postgres implementation
of the pure queue. It **never calls a WhatsApp transport**; the only path that
could produce a sendable request is `buildOutboundRequest()`, gated by five
independent blocks.

| Requirement | Implementation |
|---|---|
| Durable draft/outbound records | Migration `010_vessel_draft_delivery.sql`, table `vessel_draft_deliveries` |
| Stable idempotency keys | `draftIdempotencyKey()` → `vdd_<sha256(programId + sha256(text) + recipientJid)>`; stored as the primary key |
| One record per eligible draft/version | `UNIQUE (program_id, content_hash, recipient_jid)` + `INSERT ... ON CONFLICT (id) DO NOTHING`; a changed draft gets a new id |
| Transaction-safe queue claiming | `claimDueDeliveries()` uses `FOR UPDATE SKIP LOCKED` inside `tx()`, increments `attempts` exactly once, sets a 60 s `lease_until` |
| Retry and failure handling | `FAILED` → `next_attempt_at = now + 60s * 2^(attempts-1)`, max 3 attempts, then `DEAD`; only due FAILED rows are claimable |
| Explicit `DELIVERY_UNKNOWN` | Timeout/dropped socket or abandoned lease → terminal `DELIVERY_UNKNOWN`, never retried (bridge may have delivered) |
| Duplicate-send prevention | Idempotency key + `SENT`/`DELIVERY_UNKNOWN`/`DEAD` terminal states + `buildOutboundRequest()` terminal refusal |
| Delivery audit trail | Reuses the existing append-only `audit_events` via `recordAudit()` (no second table); `VESSEL_DRAFT_DELIVERY_*` actions |
| Admin-visible status | `/vessel/drafts` "Draft delivery status" panel (`deliveryStatusForPrograms()`), graceful when the table is absent |
| Recovery after worker restart | `recoverStuckDeliveries()` converts expired `SENDING` leases to `DELIVERY_UNKNOWN` before every claim |
| Incomplete draft fields | `enqueueDraftForProgram()` returns `BLOCKED` with the gaps and writes an audit event; no record is created |

### Exact pending migration (`db/standalone/010_vessel_draft_delivery.sql`)

One new table, **no legacy Cash/Vessel row rewritten**, schema version stays
`1.5.0` (additive layer recorded in `schema_migrations` as version `010`).

Columns: `id` (PK, `^vdd_[a-f0-9]{64}$`), `program_id` (FK → `programs.id`
ON DELETE CASCADE), `source_message_id`, `account_id` (`CHECK = 'wa-01'`),
`recipient_jid`, `content`, `content_hash` (sha256 hex), `state` (CHECK over
`PREPARED/QUEUED/SENDING/SENT/FAILED/DELIVERY_UNKNOWN/DEAD/CANCELLED`),
`attempts`, `next_attempt_at`, `lease_until`, `delivery_ref`, `error`,
`created_at`, `updated_at`.

Indexes: PK; unique `(program_id, content_hash, recipient_jid)`; partial
`vessel_draft_deliveries_queue` on `(state, next_attempt_at, created_at)`
WHERE state IN ('QUEUED','FAILED'); `vessel_draft_deliveries_program` on
`(program_id, created_at DESC)`; partial `vessel_draft_deliveries_lease` on
`(lease_until)` WHERE state='SENDING'.

Tooling updated: `scripts/standalone/install.mjs` (fresh-install chain +
`TARGET_TABLES`), `scripts/standalone/grants.mjs` (runtime `SELECT/INSERT/UPDATE`
grant), `scripts/standalone/migrate.mjs` auto-discovers `010`, CI table-count
expectation 46 → 47, test reset helpers include the new table.

### Migration test evidence (disposable clone of production schema)

- Restored `phase3-predeploy-7da17f1-20261107T124612Z.dump` into a fresh
  disposable DB; pre-state: schema `1.5.0`, 46 tables, max migration `009`,
  delivery table absent.
- Applied `010` via `scripts/standalone/migrate.mjs`: post-state schema `1.5.0`,
  47 tables, ledger version `010`, all 15 columns and 4 indexes present.
- Legacy counts unchanged: 218 employees / 102 programs / 3,817 instructions /
  1,586 postings / 13 review items.
- Rollback simulation: `DROP TABLE vessel_draft_deliveries` + delete ledger row
  `010` → back to 46 tables, `max_migration=009`, identical legacy counts;
  preflight then reports `010` pending again (re-appliable). Disposable DB dropped.
- Production table ownership is `alrifai_app`, so the established migration
  procedure will apply cleanly (the restore needed extra test-only grants because
  `pg_restore --no-owner` changed ownership).

### Tests

- `tests/standalone/vessel-draft-delivery.test.mjs` — 12 pure unit tests.
- `tests/standalone/vessel-draft-delivery-store.test.mjs` — 8 integration tests:
  table/gate, one QUEUED record + audit, dedup, incomplete-draft blocking,
  transaction-safe claim, backoff + terminal `DELIVERY_UNKNOWN`, worker-restart
  recovery, Admin status + denied outbound request.
- Full suites: unit **133/133**, integration **133/133**, typecheck clean,
  lint 0 errors. Admin UI verified on a local dev server against the clone DB
  both with the table absent (graceful degradation) and with a synthetic QUEUED
  record (status visible). Clone fixtures removed.

## 5. Exact draft message example (for Owner approval)

Rendered by the deployed template from a real production `DRAFT` program
(`prog_df6a840cee55d392022df783`), read-only, no gaps:

```text
Mother Vessel: M.V. Beltokyo
Importer
Lighter Vessel:M.V. Banglar-Modhumoti-1
Master mobile:-01720-614025
Destination:
Escort Name:
Escort mobile:
07/11/26 ((N))

Al-Rifa'i Integrated Services
```

Escort Name and Escort mobile are intentionally blank: only the Admin's
completed outgoing reply in the **same original order-giving chat** supplies
them. The delivery notification is not confirmation and does not require any
client acknowledgment or approval button.

## 6. Smallest possible outbound transport change (prepared, NOT enabled)

1. Add one narrow WA-01 consumer token with `messages.send` scoped to the single
   approved Admin JID. Do **not** widen the existing read token; do not touch
   WA-02.
2. Set `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1`, an `app_settings` boolean
   `vessel_draft_outbound_enabled=true`, and explicit
   `ALRIFAI_VESSEL_DRAFT_SENDER_JID` / `ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID` /
   sender socket + token file. These five blocks are exactly what
   `runtimeDeliveryGate()` checks; none is currently set.
3. Apply migration `010` (Owner-approved) and grant runtime access.
4. One `send_message` socket call per claimed record using the prepared
   `OutboundRequest` (`accountId`, `recipientJid`, `text`, `idempotencyKey`),
   persisting `SENDING` before the call and recording every outcome in
   `audit_events`. **This call is not implemented anywhere in the codebase
   today** — that is the smallest remaining change.
5. `applyConfirmation()` and the Admin confirmation rule are untouched: delivery
   never assigns an escort, never confirms and never updates a program.

### Controlled single-message verification procedure (for approval, not executed)

1. With all five gate blocks enabled for exactly one recipient, insert ONE
   eligible draft and confirm the gate returns `OUTBOUND_APPROVED`.
2. Call `claimDueDeliveries(1)`; verify exactly one row becomes `SENDING` with
   `attempts=1`.
3. Call `prepareDeliveryRequest(id)`; verify the prepared text equals §5 and the
   idempotency key is stable.
4. Perform **one** `send_message` call; verify the state becomes `SENT` with a
   `delivery_ref`, one `VESSEL_DRAFT_DELIVERY_SENT` audit row, and zero duplicate
   messages (re-enqueue returns `DUPLICATE`).
5. Immediately disable the env kill switch; confirm no further request is
   prepared and mode returns to `MANUAL_COPY_ONLY`.
6. Rollback if any check fails: disable both kill switches, delete the single
   delivery row, drop the table (or leave it empty); no legacy data is touched.

## 7. Activation gate — exact approvals still pending

The Owner must explicitly approve all of:

1. **Sending account** — WA-01 `8801880446111@s.whatsapp.net` (WA-02 has no role).
2. **Recipient JID** — exact Admin JID (not currently configured anywhere).
3. **Authorized chat scope** — one direct Admin chat; never client/release groups.
4. **Message template** — the exact ten-line Owner draft in §5.
5. **Delivery trigger** — one record per eligible, complete, unchanged draft.
6. **Retry behavior** — 3 attempts, exponential backoff, `DELIVERY_UNKNOWN`
   terminal, worker-restart recovery, no automatic resend on ambiguity.
7. **Database migration** — `010_vessel_draft_delivery.sql` (additive, tested,
   rollback simulated); no legacy data rewritten.
8. **Live activation and rollback plan** — two kill switches, single-message
   verification in §6, and the ability to disable without a data restore.

Until then: `MANUAL_COPY_ONLY`, `/vessel/drafts` copy button, no `messages.send`,
no outbound message, no production migration.

## 8. Files

| File | Role |
|---|---|
| `lib/vessel-draft-delivery.ts` | Pure delivery state machine, idempotency, gate, prepared request |
| `lib/standalone/vessel-draft-delivery-store.ts` | Durable Postgres store, claim, retry, recovery, status, audit |
| `db/standalone/010_vessel_draft_delivery.sql` | **Pending** additive migration (NOT applied in production) |
| `tests/standalone/vessel-draft-delivery.test.mjs` | 12 pure tests |
| `tests/standalone/vessel-draft-delivery-store.test.mjs` | 8 integration tests |
| `app/(workspace)/vessel/drafts/page.tsx` | Admin workspace + delivery status panel |
| `lib/order-draft-from-record.ts` | `MANUAL_COPY_ONLY` Owner draft projection |
| `lib/order-draft-template.ts` | Exact Owner draft layout |
| `lib/standalone/whatsapp.ts` (`applyConfirmation`) | Unchanged confirmation rule |
| `lib/ai/sender.ts` | Reference pattern (WA-02 only, disabled) |

---

## 9. Next Vessel Draft delivery release — review and activation plan

**Status:** PREPARED ONLY. No migration applied, no image built/deployed, no
outbound enabled. Production remains `phase3-ai-rc-7da17f1` / schema `1.5.0` /
`schema_migrations` max `009` / 46 tables.

### 9.1 Feature-branch review (commits after deployed `7da17f1`)

Code commits: `ed78ec2` (pure delivery state machine + 12 tests), `d533939`
(TRANSFER classification + 7 historical regressions), `675a3ef` (employee
update `PATCH`, payroll rate gating), `3e0dd01` (migration 010, durable store,
Admin status UI, tooling, 8 integration tests). Remaining commits are docs.
Changed code paths: `lib/vessel-draft-delivery.ts`,
`lib/standalone/vessel-draft-delivery-store.ts`,
`db/standalone/010_vessel_draft_delivery.sql`,
`lib/release-slip.ts`, `lib/message-router.ts`, `lib/review-ui.ts`,
`lib/action-form-request.ts`, `components/standalone/action-form.tsx`,
`app/(workspace)/{cash,settings,vessel,payroll,employees/[mobile],vessel/drafts}/page.tsx`,
`scripts/standalone/{install,grants}.mjs`, `.github/workflows/ci.yml`, three
test reset helpers, `package.json`.

### 9.2 Delivery store and migration 010 verified

- `lib/standalone/vessel-draft-delivery-store.ts`: idempotent enqueue,
  `FOR UPDATE SKIP LOCKED` claim, bounded retry/backoff, terminal
  `DELIVERY_UNKNOWN`, worker-restart lease recovery, audit trail via
  `audit_events`, Admin status, five-block `runtimeDeliveryGate()`,
  prepared-but-never-executed request. **No `send_message` call.**
- Migration `010` SHA-256
  `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`; applied,
  verified and rolled back on a disposable clone of the exact production
  schema; legacy counts unchanged; re-appliable.
- Tests: 12 pure + 8 durable-store integration; focused re-run **31/31**;
  full unit **133/133**, integration **133/133**, typecheck clean, lint 0 errors.

### 9.3 Compatibility with the currently deployed release

- `7da17f1` does **not** contain the delivery module (added later). A new image
  built from the current branch is additive: no column, enum or table change is
  required at deploy time.
- Verified against the deployed **46-table** schema: `deliveryTableAvailable()`
  → `false`, `runtimeDeliveryGate()` → disabled with 5 reasons and
  `MANUAL_COPY_ONLY`, `deliveryStatusForPrograms()` → 0 rows. The
  `/vessel/drafts` page degrades gracefully (verified on a local dev server
  against the clone DB both with the table absent and with a synthetic QUEUED
  record).
- Therefore the application release and migration 010 are **independently
  approvable**; deploying the image does not require the migration.

### 9.4 Exact missing WhatsApp transport integration

| Missing piece | Evidence |
|---|---|
| `messages.send` capability | WA-01 policy has only read capabilities + `calls.policy.write`; `has_messages_send=false`. WA-02 is `native.identity.read` only. |
| Narrow sender token/socket | `ALRIFAI_VESSEL_DRAFT_SENDER_SOCKET` / `_TOKEN_FILE` absent from `.env`. |
| Approved identities | `ALRIFAI_VESSEL_DRAFT_SENDER_JID` / `_RECIPIENT_JID` absent; no Owner-approved recipient JID exists. |
| Two kill switches | `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED` absent; `app_settings.vessel_draft_outbound_enabled` absent. |
| Delivery worker | No caller of `claimDueDeliveries()` / `prepareDeliveryRequest()` exists; no `send_message` call in the delivery path (only `lib/ai/sender.ts` for WA-02, disabled). |
| Durable table in production | `vessel_draft_deliveries` ABSENT; migration 010 not applied. |

The single smallest integration is: one narrow WA-01 consumer token with
`messages.send` scoped to the approved Admin JID, plus one `send_message` socket
call per claimed record driven by `claimDueDeliveries()` →
`prepareDeliveryRequest()`, persisting the outcome with
`applyDeliveryOutcomeToStore()`. Everything else (queue, idempotency, retry,
audit, status, gate, template) already exists.

### 9.5 Smallest safe release and activation plan (all steps need approval)

1. **Release (no outbound):** fresh verified backup → build one image from the
   current branch → `ALRIFAI_TAG=<new> docker compose ... up -d app sync` →
   verify health/schema/counts/routes. **Do NOT apply migration 010.** The
   delivery UI shows "not configured / MANUAL_COPY_ONLY". Rollback:
   `ALRIFAI_TAG=phase3-ai-rc-7da17f1` (or `86d659a` for the older release).
2. **Migration (separate approval):** apply `010_vessel_draft_delivery.sql`
   via `scripts/standalone/migrate.mjs`; verify 46→47 tables, ledger `010`,
   schema still `1.5.0`, legacy counts unchanged. Rollback: drop table + delete
   ledger row `010` (simulated on a disposable clone).
3. **Outbound activation (separate approval):** set the 5 gate blocks, add the
   narrow `messages.send` token, then perform the controlled single-message
   verification in §6. Kill switch off immediately afterwards if any check fails.
4. **Confirmation stays unchanged:** `applyConfirmation()` still requires the
   Admin's completed outgoing reply in the original order-giving chat.

### 9.6 Approvals required before any of §9.5 executes

- Explicit approval to build/deploy a new production image (fresh backup).
- Explicit approval to apply migration 010.
- The 8 outbound activation approvals in §7 (sender, recipient, chat scope,
  template, trigger, retry, migration, live+rollback plan).

Until then: `MANUAL_COPY_ONLY`, no `messages.send`, no WhatsApp message, no
production migration, no new image.
