# Vessel Order Draft — Root Cause and Corrected Stage

**Date:** 2026-11-07 (updated after deployment of `7da17f1`)
**Status:** The full internal pipeline — intake → field extraction → DRAFT
persistence → Owner draft presentation → Admin assignment → confirmation — is
implemented and **clone-verified**, and `/vessel/drafts` is **production-deployed**
on `phase3-ai-rc-7da17f1` (Owner-approved deployment 2026-11-07). Production
has 8 live WA-01 `DRAFT` programs, so intake is active. Automatic WhatsApp
delivery is **not implemented** and is blocked on an Owner decision; delivery
remains `MANUAL_COPY_ONLY`. The internal delivery queue exists in
`lib/vessel-draft-delivery.ts` (unit-tested, **not deployed**, not enabled).

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
| Admin draft template | **Never generated in production `86d659a`**; implemented on the candidate | `renderOwnerDraft` / `composeAdminDraft` had no caller in Phase 3 |
| Delivery to Admin WhatsApp | **Never attempted** | No outbound sender; bridge has no `messages.send` capability |
| Assignment/confirmation | Works from the Admin's outgoing reply | `applyConfirmation()` sets `CONFIRMED` (clone-verified) |

**Update 2026-11-07:** live WA-01 order traffic above the cutover has since
produced **8 `DRAFT` programs** in production (created 08:28–10:28 UTC, e.g.
`Union-Odyssey / Khadija-Khatun`, `BELTOKYO / RIPA`, `Beltokyo /
Banglar-Modhumoti-1`). This confirms stages 1–3 are live in `86d659a` and the
missing stage is the draft UI/transport, not extraction or persistence. The
`86d659a` image does not contain `/vessel/drafts`.

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
4. **No live order in the original observation window.** Above rowid `19634`,
   the traffic first observed was Cash, release-group and ignored messages;
   the structured orders seen on 2026-11-05/06 (`rowid 19506–19627`) were
   historical and were never routed. Later on 2026-11-07 live orders did arrive
   and produced the 8 DRAFT programs noted above.

This is a **missing delivery stage**, not a parser failure for structured orders.

## 3. Implemented correction (candidate `7da17f1`; first introduced in `9e85e49`)

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

### Verified on the isolated clone (`7da17f1`)

- 29 Admin routes and 12 USER routes return HTTP 200.
- Full WA-01 pipeline: an authorized order message produced a `DRAFT` program
  with Mother Vessel `CLONE INTAKE`, Lighter Vessel `L-CLONE-01`, Master Mobile
  `01711111111`, Destination `Chattogram`, start date `2026-11-07`, shift `D`.
  It appeared on `/vessel` and `/vessel/drafts`; the draft rendered all fields
  with blank escort lines. An Admin outgoing reply then set the state to
  `CONFIRMED`, assigned the escort and recorded `confirmation_message_id`.
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
- No outbound message, no automatic assignment, no posting, no schema change.
- All clone fixtures were removed after verification.

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

1. Owner decision on Option A vs B (delivery transport).
2. Production credentials still unavailable (login verification blocked).
3. 7 existing `RELEASE_UNSTRUCTURED` production review items remain for manual
   review. The improved parser now extracts and matches evidence for **future**
   messages, but no historical item or program was rewritten.
4. `al-rifai.iamazim.com` Cloudflare 1014 requires an Owner DNS decision.
5. The internal delivery queue (`675a3ef`) is implemented and tested but not
   deployed; a further release requires a new candidate and Owner approval.

## 7. Rollback

No schema change. Roll back to the previous image
`local/al-rifai-platform:phase3-ai-rc-86d659a` (digest `932ef856…`) with the same
Compose project (`-p al-rifai-phase3`); no data restore is required for this
UI/logic-only change. The pre-import backup
`/var/lib/vps/al-rifai/backups/phase3-pre-import-20261106T224024Z.dump`
(SHA-256 `83dfe6d0284a1f16d1109aee0cb0b29273bbc3a739955194bada2fd8c8daaad9`)
remains verified but is not needed for a UI rollback.
