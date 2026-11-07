# Vessel Draft delivery — architecture, internal work and activation gate

**Date:** 2026-11-07
**Status:** Safe internal work **implemented and clone/unit-tested**. **No outbound
transport is enabled, no WhatsApp message is sent, no migration is applied.**
Migration status for this work: **NO MIGRATION**.

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

## 4. Durable records — design only, NOT applied

A real deployment needs a WA-01-safe table. Proposed DDL (requires a separate
Owner-approved migration; **not included in `7da17f1` and not applied**):

```sql
CREATE TABLE vessel_draft_deliveries (
  id                text PRIMARY KEY,              -- the idempotency key
  program_id        text NOT NULL REFERENCES programs(id),
  source_message_id text,
  account_id        text NOT NULL CHECK (account_id = 'wa-01'),
  recipient_jid     text NOT NULL,
  content           text NOT NULL,
  state             text NOT NULL DEFAULT 'PREPARED'
                    CHECK (state IN ('PREPARED','QUEUED','SENDING','SENT','FAILED',
                                     'DELIVERY_UNKNOWN','DEAD','CANCELLED')),
  attempts          integer NOT NULL DEFAULT 0,
  next_attempt_at   timestamptz,
  delivery_ref      text,
  error             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE vessel_draft_delivery_attempts (
  id           text PRIMARY KEY,
  delivery_id  text NOT NULL REFERENCES vessel_draft_deliveries(id) ON DELETE CASCADE,
  attempt_no   integer NOT NULL,
  state        text NOT NULL,
  response     jsonb NOT NULL DEFAULT '{}'::jsonb,
  started_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
```

`UNIQUE (id)` on the idempotency key is the database-level duplicate guard that
backs `enqueueDraftDelivery()`.

## 5. Smallest possible outbound transport change (prepared, not enabled)

1. Add one narrow WA-01 consumer token with `messages.send` scoped to the single
   approved Admin JID. Do **not** widen the existing read token; do not touch
   WA-02.
2. Add two kill switches: `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1` and an
   `app_settings` boolean `vessel_draft_outbound_enabled=true`, plus explicit
   `ALRIFAI_VESSEL_DRAFT_SENDER_JID` / `ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID`.
3. One `send_message` socket call per QUEUED record, passing
   `idempotencyKey` so the bridge can deduplicate; persist `SENDING` before the
   call and record every attempt.
4. The Admin UI shows `deliveryViewModel()`; no automatic confirmation, no
   escort assignment, no program state change from delivery.

**Nothing above is enabled.** All `AI_*` flags remain `0`, no bridge policy was
changed, no WhatsApp message was sent.

## 6. Activation gate (Owner must approve explicitly)

Before any of §5 is enabled, the Owner must approve the exact:

1. sender account and JID,
2. recipient Admin JID,
3. chat scope (one direct chat, never client/release groups),
4. delivery behavior (one message per unchanged draft, retry policy, kill
   switches, no automatic confirmation),
5. the migration that creates the WA-01-safe durable tables.

Until then: `MANUAL_COPY_ONLY`, `/vessel/drafts` copy button, and the existing
Admin confirmation rule remain the supported workflow.

## 7. Files

| File | Role |
|---|---|
| `lib/vessel-draft-delivery.ts` | Pure delivery state machine |
| `tests/standalone/vessel-draft-delivery.test.mjs` | 12 isolated tests |
| `lib/order-draft-from-record.ts` | `MANUAL_COPY_ONLY` Owner draft projection |
| `lib/order-draft-template.ts` | Exact Owner draft layout |
| `app/(workspace)/vessel/drafts/page.tsx` | Admin copy workspace |
| `lib/standalone/whatsapp.ts` (`applyConfirmation`) | Unchanged confirmation rule |
| `lib/ai/sender.ts` | Reference pattern (WA-02 only, disabled) |
