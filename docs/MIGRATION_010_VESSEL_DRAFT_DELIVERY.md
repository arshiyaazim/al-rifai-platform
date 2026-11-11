# Migration 010 — Vessel Draft Delivery Technical Documentation

**Date:** 2026-11-08
**Migration:** `db/standalone/010_vessel_draft_delivery.sql`
**SHA-256:** `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`
**Branch:** `feature/phase3-integration` @ `0b309b2`
**Production status:** **APPLIED 2026-11-08** (010-only gate: 47 tables,
schema `1.5.0`; after 011: 49 tables, schema `1.6.0`).
**Runtime delivery status:** **MANUAL_COPY_ONLY**. Worker and transport code
are deployed in image `phase3-ai-rc-8a6c2c6`, but all outbound flags/gates remain
OFF and no sender permission or recipient is approved. No message was sent.

---

## A. Original objective and evidence

### A.1 What the repository verifies

The implemented order workflow is:

```text
Authorized WA-01 order message
  -> classifyDomain()/handleVessel()
  -> parseEscortOrder()
  -> one DRAFT program per Lighter (plus REVIEW on ambiguity/missing fields)
  -> exact Owner draft in /vessel/drafts, program detail and PROGRAM review
  -> Admin copies the draft, fills Escort Name/Mobile/Date/Shift in WhatsApp
  -> Admin's actual outgoing reply is the confirmation
  -> applyConfirmation() updates the matching program
  -> release evidence / releaseProgram() for later lifecycle
```

Evidence:

- `docs/VESSEL_WORKFLOW.md`, `docs/VESSEL_ORDER_DRAFT.md`,
  `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`.
- `lib/order-draft-template.ts` and `lib/order-draft-from-record.ts`.
- `app/(workspace)/vessel/drafts/page.tsx`.
- Production image `phase3-ai-rc-7da17f1` contains the draft UI; project docs
  record 8 live DRAFT programs at the 7da17f1 verification. This audit did not
  re-query the live DRAFT count.

### A.2 Bridge-2 / WA-02 — evidence boundary

The task brief refers to an Owner-intended **Bridge-2 (WA-02) → Bridge-1 (WA-01)
Escort Order Draft** workflow. The inspected repository and `/opt/vps` documents
do **not** contain a verified specification for that workflow. Specifically,
there is no evidence for:

- WA-02 client/chat/participant allowlist for order intake;
- WA-02 order classification and field mapping;
- WA-02 draft identity/provenance;
- the Bridge-2 → Bridge-1 handoff trigger or permission;
- whether Bridge-2 receives orders and Bridge-1 only sends the draft;
- confirmation authority under that split.

Current verified deployed scope is different:

| Account | Current verified scope |
|---|---|
| WA-01 / Bridge-1 | Authorized Vessel order source and Admin confirmation account; 9 business chats; outbound send capability absent |
| WA-02 / Bridge-2 | Identity-only in current runtime; zero business chats; no order intake; read policy `native.identity.read` only |

**Classification:** Bridge-2 order-intake workflow = **UNKNOWN / NOT VERIFIED**.
WA-02 is **currently identity-only**, not proven permanently identity-only. Any
expansion requires an explicit Owner decision, participant list, bridge policy
change and separate implementation. This document does not invent it.

### A.3 Historical requirements vs implemented behavior

| Requirement family | Status |
|---|---|
| Authorized client order → DRAFT program | **IMPLEMENTED / TESTED IN ISOLATION / DEPLOYED in `7da17f1`** (WA-01 path) |
| Exact Owner draft layout | **IMPLEMENTED / TESTED / DEPLOYED** |
| Manual copy of draft by Admin | **IMPLEMENTED / DEPLOYED** |
| Admin reply as confirmation | **IMPLEMENTED / DEPLOYED** |
| Durable outbound draft queue | **IMPLEMENTED / TESTED IN ISOLATION**, migration pending |
| Automatic WhatsApp draft delivery | **IMPLEMENTED IN SOURCE, NOT ACTIVATED** (worker + transport exist; gate OFF) |
| Bridge-2 order intake / Bridge-2→Bridge-1 handoff | **UNKNOWN / NOT VERIFIED** |
| Release evidence / program lifecycle | **IMPLEMENTED / TESTED / DEPLOYED** for structured slips; unstructured evidence stays review-only |

## B. Migration SQL

File: `db/standalone/010_vessel_draft_delivery.sql` (51 lines).

### B.1 Table

`vessel_draft_deliveries` (one row per eligible, complete, unchanged draft
version):

| Column | Type | Constraints |
|---|---|---|
| `id` | text PK | `^vdd_[a-f0-9]{64}$`; idempotency key |
| `program_id` | text NOT NULL | FK → `programs(id)` ON DELETE CASCADE |
| `source_message_id` | text | nullable provenance |
| `account_id` | text NOT NULL DEFAULT `wa-01` | `CHECK (account_id='wa-01')` |
| `recipient_jid` | text NOT NULL | length 1–120 |
| `content` | text NOT NULL | length 1–4000 |
| `content_hash` | text NOT NULL | lowercase SHA-256 hex |
| `state` | text NOT NULL DEFAULT `PREPARED` | `PREPARED`, `QUEUED`, `SENDING`, `SENT`, `FAILED`, `DELIVERY_UNKNOWN`, `DEAD`, `CANCELLED` |
| `attempts` | integer NOT NULL DEFAULT 0 | `>= 0` |
| `next_attempt_at` | timestamptz | retry schedule |
| `lease_until` | timestamptz | worker claim lease |
| `delivery_ref` | text | bridge result reference |
| `error` | text | last error |
| `created_at` / `updated_at` | timestamptz | defaults `now()` |
| unique | — | `(program_id, content_hash, recipient_jid)` |

### B.2 Indexes

| Index | Definition |
|---|---|
| `vessel_draft_deliveries_pkey` | PK `id` |
| `vessel_draft_deliveries_program_id_content_hash_recipient_j_key` | unique `(program_id, content_hash, recipient_jid)` |
| `vessel_draft_deliveries_queue` | `(state, next_attempt_at, created_at)` WHERE `state IN ('QUEUED','FAILED')` |
| `vessel_draft_deliveries_program` | `(program_id, created_at DESC)` |
| `vessel_draft_deliveries_lease` | `(lease_until)` WHERE `state='SENDING'` |

### B.3 Triggers, foreign keys, permissions

- Foreign key: `program_id → programs(id) ON DELETE CASCADE`.
- No `updated_at` trigger is defined; the store writes `updated_at` explicitly.
- No append-only trigger; this is a mutable queue table, not financial history.
- Runtime grants: `SELECT, INSERT, UPDATE` (no DELETE) via
  `scripts/standalone/grants.mjs`.
- `scripts/standalone/install.mjs` includes the file in the fresh-install chain
  and `TARGET_TABLES`.
- Migration runner auto-discovers it and checksums it.

### B.4 Dependencies and version behavior

- Depends on `programs(id)` and standard `forbid_mutation`/baseline schema only.
- Applied after `009`.
- **010 alone leaves `schema_meta.schema_version` at `1.5.0`** (the file does not
  update it).
- In the integrated branch, 011 follows 010 and sets `schema_version='1.6.0'`.
- Fresh install with both: 49 tables, 10 migration rows, `1.6.0`.
- Incremental 1.5.0→1.6.0: 010 then 011.
- Repeat migration: no-op.
- Failure probe: a failing migration rolls back; no probe table/ledger row.

### B.5 Checksum

`fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`

Identical on router, cash, integration and canonical untracked copy.

## C. Application implementation

| Component | File / function | Lines | Status | Test evidence | Runtime activation |
|---|---|---|---|---|---|
| Vessel intake parser | `lib/escort-intake-candidate.mjs::parseEscortOrder` | 132–306 | Implemented | `message-router.test.mjs` vessel cases | Live on WA-01 |
| Date/shift normalization | `lib/shift-boundary.ts` | — | Implemented | `shift-boundary.mjs`, draft tests | Live |
| Domain classifier | `lib/message-classifier.ts::classifyDomain` | 69–145 | Implemented | `message-classifier.test.mjs` | Live |
| Router vessel handler | `lib/message-router.ts::handleVessel` | 732–995 | Implemented | router/vessel tests | Live on WA-01 |
| Release-slip parser | `lib/release-slip.ts::parseReleaseSlips`, `parseUnstructuredRelease` | 118–270 | Implemented | `release-slip.test.mjs`, router tests | Live; evidence only unless structured match |
| Release handler | `lib/message-router.ts::handleReleaseSlip` | 629–725 | Implemented | router release tests | Live |
| Confirmation handler | `lib/message-router.ts::handleConfirmation` → `lib/standalone/whatsapp.ts::applyConfirmation` | 1002–1068; 342+ | Implemented | router/domain tests | Live |
| Program creation | `lib/standalone/programs.ts::createProgram` | 136–256 | Implemented | router/domain tests | Live |
| Program release | `lib/standalone/programs.ts::releaseProgram` | 257+ | Implemented | release/router tests | Live |
| Draft template | `lib/order-draft-template.ts::renderOwnerDraftFields` | 85–113 | Implemented | `order-draft-record.test.mjs` | Live UI |
| Draft projection | `lib/order-draft-from-record.ts::ownerDraftFromProgram/Record/ReviewPayload` | 83–180 | Implemented | 7 tests | Live UI |
| Draft UI | `app/(workspace)/vessel/drafts/page.tsx` | 28–180+ | Implemented | build + HTML | Live in `7da17f1` |
| Draft panel | `components/standalone/owner-draft-panel.tsx` | 8–67 | Implemented | build | Live |
| Copy button | `components/standalone/copy-draft-button.tsx` | — | Implemented; clipboard only | build | Live |
| Pure delivery state machine | `lib/vessel-draft-delivery.ts` | 22–350 | Implemented | 12 tests | Not used by a worker |
| Durable queue store | `lib/standalone/vessel-draft-delivery-store.ts` | 42–395 | Implemented | 8 tests | Migration absent; no worker |
| Queue producer | `enqueueDraftForProgram` | 149–205 | Implemented | store tests | No production caller |
| Queue consumer | `lib/vessel-draft-delivery-worker.ts::runVesselDraftDeliveryTick` → `claimDueDeliveries` | worker 72–150; store 239–282 | Implemented | 5 worker/transport tests + 8 store tests | Worker default-disabled |
| Outbound request builder | `buildOutboundRequest` | 302–327 | Implemented; never executes | 12 tests | Gate disabled |
| Transport/send call | `lib/vessel-draft-transport.ts::sendVesselDraft` | 45–70 | Implemented; MCP `send_message` | mocked adapter tests | Production gate/permission OFF |
| Retry/unknown recovery | `recoverStuckDeliveries`, `applyDeliveryOutcomeToStore` | 207–337 | Implemented | store + worker tests | Worker default-disabled |
| Admin delivery status | `deliveryStatusForPrograms`, `/vessel/drafts` | 338–352; page 108–142 | Implemented | store test | UI shows disabled gate |
| Legacy draft composer | `lib/order-draft.ts::composeAdminDraft` | 38–65 | Implemented historical; no current caller | not authoritative | Not used |
| Legacy candidate draft | `lib/escort-intake-candidate.mjs::buildEscortAdminDraft` | 385–389 | Implemented historical; no current caller | — | Not used |

### C.1 Queue / delivery sequence

```text
enqueueDraftForProgram()
  -> ownerDraftFromProgram() exact text
  -> prepareDraftDelivery() PREPARED
  -> Postgres ON CONFLICT(id) DO NOTHING
  -> QUEUED + audit
claimDueDeliveries()
  -> FOR UPDATE SKIP LOCKED
  -> SENDING + attempts+1 + 60s lease
prepareDeliveryRequest()
  -> runtime gate + buildOutboundRequest (NO SEND)
applyDeliveryOutcomeToStore()
  -> SENT / FAILED / DELIVERY_UNKNOWN / DEAD + audit
```

There is **no code that calls `claimDueDeliveries()` in a worker**, and **no
`send_message` call** in this path.

## D. Exact current template

The authoritative current template is
`lib/order-draft-template.ts::renderOwnerDraftFields` (lines 85–113). It renders
exactly:

```text
Mother Vessel: ${vesselDisplayName(mother)}
Importer
Lighter Vessel:${vesselDisplayName(lighter)}
Master mobile:-${masterMobileDisplay(master)}
Destination: ${destination}        # "Destination:" when absent
Escort Name:
Escort mobile:
${DD/MM/YY} ((${D|N}))

Al-Rifa'i Integrated Services
```

Exact code literals:

```ts
const lines = [
  `Mother Vessel: ${mother}`,
  'Importer',
  `Lighter Vessel:${lighter}`,
  `Master mobile:-${master}`,
  destination ? `Destination: ${destination}` : 'Destination:',
  'Escort Name:',
  'Escort mobile:',
  `${date} ((${shift}))`,
  '',
  OWNER_DRAFT_FOOTER,
];
```

`OWNER_DRAFT_FOOTER = "Al-Rifa'i Integrated Services"`.

Rules:

- `vesselDisplayName()` adds `M.V. ` once and strips existing prefixes.
- `masterMobileDisplay()` renders `01XXX-XXXXX`.
- date is `DD/MM/YY`; shift is `D` or `N`.
- Mother, Lighter, Master Mobile, date and shift are mandatory; missing values
  throw `DRAFT_FIELDS_REQUIRED` rather than inventing values.
- Escort Name and Escort Mobile are intentionally blank; the Admin supplies them
  in the confirmation reply.
- Destination is optional; the line is `Destination:` when absent.

### D.1 Other templates found (not authoritative)

1. `lib/order-draft.ts::composeAdminDraft` — historical `Notun escort order:`
   15-line layout; no current caller.
2. `lib/escort-intake-candidate.mjs::buildEscortAdminDraft` — historical
   candidate layout; no current caller.
3. `legacy-reference/03_ORDER_DRAFT_ASSIGNMENT_CONFIRMATION.md` — historical
   functional specification; not executable authority.

## E. Bridge-2 → Bridge-1 delivery status

**Current implementation: DATABASE QUEUE + MANUAL COPY ONLY.**

| Capability | Status |
|---|---|
| Durable `vessel_draft_deliveries` queue | Code + migration **applied in production** |
| Queue producer | Connected after committed DRAFT program when an approved recipient exists |
| Queue consumer worker | Implemented; default-disabled by `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0` |
| WhatsApp delivery adapter | **IMPLEMENTED IN SOURCE**; not enabled |
| `messages.send` permission | Absent from WA-01 and WA-02 current policies |
| Automatic delivery | **CODE PRESENT, DISABLED** |
| Manual copy from `/vessel/drafts` | **YES**, production-deployed |
| Bridge-2 order intake | **NOT IMPLEMENTED / UNVERIFIED** |
| Bridge-2 → Bridge-1 handoff | **NOT IMPLEMENTED / UNVERIFIED** |

Missing for automatic delivery:

1. One narrow WA-01 send token/permission scoped to one approved Admin JID.
2. Explicit Owner-approved sender and recipient JIDs.
3. Env and DB kill switches (`ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED`,
   `vessel_draft_outbound_enabled`).
4. Socket/token configuration.
5. A worker that calls `claimDueDeliveries()` and one `send_message` per claimed
   record.
6. Delivery outcome/ack persistence (already partly available).
7. Migration 010 applied + runtime grants.
8. A single-message live verification and rollback plan.

## F. Completion matrix

| Requirement | Planned | Code Exists | Tested | Production Active | Missing Work | Evidence |
|---|---|---|---|---|---|---|
| WA-01 order classification | Yes | Yes | Yes | Yes | — | `classifyDomain`, `handleVessel` |
| One DRAFT per Lighter | Yes | Yes | Yes | Yes | — | `createProgram`, router tests |
| Multi-lighter / duplicate handling | Yes | Yes | Yes | Yes | — | router tests |
| Exact Owner draft | Yes | Yes | Yes | Yes | — | `order-draft-template.ts` |
| Draft UI / copy | Yes | Yes | Yes | Yes | — | `/vessel/drafts`, panel |
| Admin reply confirmation | Yes | Yes | Yes | Yes | — | `applyConfirmation` |
| Durable delivery queue | Yes | Yes | Yes | Yes (migration applied; empty) | — | `010`, store, production ledger |
| Queue producer wiring | Yes | Yes | Yes | Conditional (requires approved recipient) | Owner recipient approval | `createProgram` hook, store tests |
| Queue worker | Yes | Yes | Yes | No (default-disabled) | Owner gate | worker/transport tests |
| WhatsApp send adapter | Yes | Yes | Yes | No | approved permission/recipient | transport tests |
| Outbound permission | Needed | No | No | No | Owner/bridge approval | policies |
| Retry/terminal unknown | Yes | Yes | Yes | No (default-disabled) | Owner gate | store + worker tests |
| Bridge-2 order intake | Owner-intended (unverified) | **No** | No | No | specification + implementation | no verified source |
| Bridge-2→Bridge-1 handoff | Owner-intended (unverified) | **No** | No | No | specification + implementation | no verified source |
| Release evidence | Yes | Yes | Yes | Yes (review-only) | — | `release-slip.ts` |
| Program release | Yes | Yes | Yes | Yes | — | `releaseProgram` |

## G. Migration readiness — direct answers

1. **What does applying 010 enable?**
   It creates the optional durable `vessel_draft_deliveries` table and grants
   runtime SELECT/INSERT/UPDATE. It enables the queue/store code and Admin status
   panel to operate. It does **not** send messages.

2. **What does it NOT enable?**
   No WhatsApp send permission, no approved sender/recipient, no outbound
   activation and no Bridge-2 intake. The worker and send adapter are present
   but default-disabled by both env and the five-block gate.

3. **Is automatic Escort Draft Delivery implemented?**
   **Implemented in source, not activated.** Queue, producer hook, worker,
   claim, narrow `send_message` adapter, retry and terminal states exist. With
   current production config the gate remains closed and mode is
   `MANUAL_COPY_ONLY`.

4. **Can the workflow be tested without live WhatsApp sending?**
   Yes. The worker is tested with an injected fake transport; no real socket or
   message is used. Evidence: 12 pure + 8 store + 5 worker/transport + 7 draft
   tests.

5. **What must be completed before production activation?**
   Approve and configure the exact sender JID, recipient JID, socket/token,
   `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1`, DB
   `vessel_draft_outbound_enabled=true`, `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=1`,
   and perform the one-message controlled verification/rollback.

6. **What requires separate Owner approval?**
   Sending account, recipient JID, chat scope, exact template, trigger/retry
   behavior, migration, send permission, live activation, rollback, and any
   Bridge-2 scope expansion.

**Migration 010 and the worker code do not, by themselves, enable outbound
sending. Production outbound remains blocked until the exact Owner-approved
transport gate is configured and verified.**
