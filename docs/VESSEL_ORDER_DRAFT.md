# Vessel Order Draft — Root Cause and Corrected Stage

**Date:** 2026-11-07
**Status:** Draft rendering implemented and verified on the candidate. Automatic
delivery is **not implemented** and is blocked on an Owner decision.

---

## 1. Expected pipeline

```
Authorized WA-01 order message
  → field extraction
  → draft creation (DRAFT vessel program)
  → Admin draft template
  → Admin assignment
  → authorized confirmation reply
  → Vessel Program (ASSIGNED)
```

## 2. What actually happened in production

| Stage | Production `86d659a` | Evidence |
|---|---|---|
| Order message | Received and mirrored | `whatsapp_messages` rows above the WA-01 cutover `19634` |
| Field extraction | Works for structured orders | `parseEscortOrder` in `lib/escort-intake-candidate.mjs` |
| Draft creation | Creates a `programs` row in `DRAFT` | `handleVessel()` → `createProgram()` |
| Admin draft template | **Never generated** | `renderOwnerDraft` / `composeAdminDraft` had no caller in Phase 3 |
| Delivery to Admin WhatsApp | **Never attempted** | No outbound sender; bridge has no `messages.send` capability |
| Assignment/confirmation | Works from the Admin's outgoing reply | `applyConfirmation()` |

### Root causes

1. **Orphaned template code.** `lib/order-draft-template.ts` and
   `lib/order-draft.ts` were pure modules with no Phase 3 caller. The legacy UI
   used `composeAdminDraft` in `app/sources-review/view.tsx`; that UI was not
   migrated, so the template disappeared.
2. **No transport.** The WA-01 bridge consumer policy grants read capabilities
   only (`messages.read`, `contacts.read`, `media.read/download`, `calls.read`,
   plus `native.*` read). There is no `messages.send`. WA-02 is identity-read
   only and its outbound tables accept `account_id='wa-02'` exclusively.
3. **Historical backlog.** Messages at or below the cutover rowid stay
   `PENDING` by design. The structured orders seen on 2026-11-05/06
   (`rowid 19506–19627`) are historical and were never routed.
4. **No live order in the observation window.** Above rowid `19634`, the live
   traffic was Cash, release-group and ignored messages; no new vessel order
   arrived, so no live draft event could occur.

This is a **missing delivery stage**, not a parser failure for structured orders.

## 3. Implemented correction (candidate `9e85e49`)

- `lib/order-draft-from-record.ts`
  - `ownerDraftFromProgram()` for DRAFT/CONFIRMED program rows.
  - `ownerDraftFromReviewPayload()` for unresolved PROGRAM review items.
  - Normalises `DD-MM-YYYY`, `DD/MM/YY`, `YYYY-MM-DD`, `D/N/Day/Night`.
  - Blocks the draft on any missing required field; never invents a value.
  - Delivery constant: `MANUAL_COPY_ONLY`.
- `lib/order-draft-template.ts`
  - `renderOwnerDraftFields()` shares the exact layout with the timestamp-based
    `renderOwnerDraft()` (no second copy of the format).
- UI:
  - `/vessel/drafts` — every DRAFT/CONFIRMED program and unresolved order review,
    with gap warnings, source link, copy button and delivery status.
  - Program detail and Review detail show the same draft block.
  - Navigation entry “Order Drafts”.
- Tests: `tests/standalone/order-draft-record.test.mjs` (7 pure tests).
- Fixed `getProgram()` returning `Date` objects (`SELECT *`) which made the
  program detail page fail with `[object Date]`.

### Verified on the isolated clone

- 32 authenticated routes return HTTP 200.
- Draft output for a fixture program:
  ```
  Mother Vessel: M.V. Union-Odyssey
  Importer
  Lighter Vessel:M.V. Fardin-7
  Master mobile:-01911-428354
  Destination:
  Escort Name:
  Escort mobile:
  03/11/26 ((D))

  Al-Rifa'i Integrated Services
  ```
- A review fixture rendered `Destination: Landing Ghat` and `04/11/26 ((N))`.
- Missing master mobile produced `MISSING_MASTER_MOBILE` and no text.
- No outbound message, no assignment, no posting, no schema change.

## 4. Bridge roles (read-only verification)

| | WA-01 | WA-02 |
|---|---|---|
| Container | `vps-whatsapp-wa-01-cap4-20261011` | `vps-whatsapp-wa-02-cap4-20261011` |
| Identity | `8801880446111@s.whatsapp.net` | `8801958122300@s.whatsapp.net` |
| Policy | read-only (`messages.read`, `contacts.read`, `media.*`, `calls.read`, `native.*` read) | `native.identity.read` only |
| Send capability | none | none |
| Phase 3 use | orders, Cash, release; 9 allowlisted chats | disabled (`[]` business chats) |

Bridge sessions, checkpoints and allowlists were not changed.

## 5. Transport options (require Owner approval)

### Option A — Keep manual copy (current, safest)
The Admin copies the draft from `/vessel/drafts` into the existing WhatsApp
client, adds escort details, and sends. No new capability, no new risk.
**This is what the candidate implements.**

### Option B — Platform delivers the draft to one Admin JID
Requires all of:
1. Explicit Owner approval.
2. A `messages.send` capability added to a **new, narrow** WA-01 consumer token
   (do not widen the existing read token; do not touch WA-02).
3. A fixed destination: one of the configured WA-01 Admin JIDs, not a client chat.
4. A durable draft record. Because `ai_outbound_messages` is WA-02-only, this
   needs a new migration (Owner-approved) or reuse of an existing WA-01-safe
   table.
5. Idempotency, audit, retry limit and a kill switch.

Option B must never send the Admin draft to client groups automatically; the
Admin confirmation reply remains the authorization.

## 6. Remaining blockers

1. Owner decision on Option A vs B.
2. Production credentials still unavailable (login verification blocked).
3. Unstructured release/cancel messages still need a parser extension.
4. Candidate `9e85e49` is not deployed.

## 7. Rollback

No schema change. Roll back to the previous image
`local/al-rifai-platform:phase3-ai-rc-86d659a` (digest `932ef856…`) with the same
Compose project; no data restore is required for the UI-only change.
