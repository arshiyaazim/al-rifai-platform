# Escort Order → Admin Confirmation → Vessel Register → Escort Release

**Implemented:** 2026-11-08  
**Branch:** `feature/phase3-010-011-activation`  
**Status:** implemented, clone-tested and runtime-verified on a disposable
database. **Production migration 013 and deployment are pending separate Owner
approval.** No production record, message, service or authorization was changed.

---

## 1. Authorized source matrix

Identity values are **not** listed here. The exact mobile numbers, PN/LID aliases
and chat JIDs remain in the existing `identity_aliases`,
`escort_client_group_authorizations`, `whatsapp_chats` and `app_settings`
configuration, which is the authoritative source.

| Source | Verified identity evidence | Business purpose | Order Draft | Release processing |
|---|---|---|---|---|
| Direct Escort Client A (PN plus verified LID alias) | `identity_aliases` EXACT canonical PN link, or an active `ESCORT_CLIENT` entry in the effective-dated authorized-contact registry | Order intake | **Allowed** | Not a release source |
| Direct Escort Client B (PN) | same | Order intake | **Allowed** | Not a release source |
| Direct Escort Client C (PN) | same | Order intake | **Allowed** | Not a release source |
| Escort Support / Office group | approved group JID + authorized group participants | Operational support and context | **BLOCKED** | **BLOCKED** |
| Escort Release Information group | approved group JID + authorized group participants | Release information only | **BLOCKED** | **Allowed** |
| Other approved vessel group (Escort Program group) | approved group JID + authorized group participants | Admin assignment/notification context only (evidence: Admin outgoing assignment messages) | **BLOCKED** | **BLOCKED** |
| Accountant / Cash direct chat | `purpose = CASH` / `source_role = CASH_ONLY` | Cash only | **BLOCKED** | **BLOCKED** |
| WA-02 (both bridges) | identity-only account | none | **BLOCKED** | **BLOCKED** |

Two independent checks are required for an Order Draft:

1. **Source**: WA-01, a DIRECT conversation, `source_role = ORDER_INTAKE` (or a
   direct `purpose = ORDERS` chat before migration backfill), and an INCOMING
   message.
2. **Identity**: the sender and the conversation resolve to the same EXACT
   canonical PN through `identity_aliases`, or the conversation matches an
   active `ESCORT_CLIENT` entry. A display name never authorizes intake.

A group can never create an Order Draft. `source_role` is explicit; it is never
derived from a group display name. An unclassified group is
`REVIEW_REQUIRED` and all state-changing work is blocked.

---

## 2. Implemented flow

```
WhatsApp bridge store
  → sync worker → whatsapp_messages (WA-01 / WA-02)
  → router claim (cutover watermark + business-chat allowlist)
  → conversation source role (ORDER_INTAKE / CASH_ONLY / SUPPORT_ONLY /
    RELEASE_ONLY / OTHER_APPROVED / REVIEW_REQUIRED)
  → domain classifier (context only)
  → Escort parser (Mother + Lighter + Master Mobile mandatory)
  → programs row, state DRAFT (one row per Lighter)
  → Admin assignment in /vessel/drafts
  → verified Admin OUTGOING WA-01 reply in the SAME original client chat
  → programs state CONFIRMED (+ escort, start date/shift, confirmation provenance)
  → Vessel Register (/vessel, /vessel/{id})
  → Release Information group structured slip
  → exact existing program updated: end_date + end_shift (state RELEASED)
  → audit_events + program_events + program_source_messages
```

Manual review remains for: incomplete orders, client-supplied assignment fields,
±1-day duplicate candidates, ambiguous confirmations, unmatched confirmations,
ambiguous releases, conflicting re-releases, completed-duty releases, and
unstructured release-group evidence.

---

## 3. Order intake rules

- Mandatory: **Mother Vessel**, **Lighter Vessel**, **Master Mobile**.
- Multiple lighters in one message create one Draft per lighter.
- A missing mandatory field produces `INCOMPLETE_VESSEL_ORDER` review evidence;
  nothing is fabricated.
- A client message that carries Escort Name/Mobile is **not** a Draft: assignment
  belongs to the verified Admin confirmation. It is preserved for review as
  `CLIENT_ASSIGNMENT_FIELDS_REQUIRE_ADMIN`.
- **Bounded multi-message merge**: an incomplete order may merge with a PENDING
  `INCOMPLETE_VESSEL_ORDER` review item only when it is the same account, the
  same authorized client conversation, created within 30 minutes, shares the
  same Lighter or Mother Vessel, and does not contradict an existing field. The
  earlier review item is withdrawn and both messages remain source evidence.
  Nothing merges across clients, conversations, accounts or vessel families.
- Replaying a message creates no duplicate Draft; the existing exact duplicate
  guard remains authoritative.
- Same Mother + Lighter + Start Date (±1 day) is a duplicate warning to review;
  the exact same start date is a hard duplicate. Same escort/date with a
  different Lighter is a separate assignment.

---

## 4. Admin confirmation rules

A confirmation requires **all** of:

1. WA-01 account.
2. OUTGOING direction.
3. The sender matches a configured `whatsapp_accounts.admin_jids` entry
   (PN/LID alias-aware).
4. The conversation is the **same original direct ORDER_INTAKE client chat** in
   which the Draft was created. Groups and other clients are rejected.
5. The message contains the completed order: Mother, Lighter, Master Mobile,
   Escort Name, Escort Mobile, Start Date and Shift. Destination is optional.
6. Exactly one viable Draft matches on the same conversation, vessel names
   (normalized, spelling-variant tolerant), Master Mobile digits, shift
   corroboration and a bounded chronological window. `lib/vessel-match.ts` is
   reused; ambiguous or weak evidence never confirms.

Persisted on `programs`:

`confirmation_message_id`, `confirmation_chat_jid`, `confirmation_sender_jid`,
`confirmation_account_id`, `confirmation_timestamp`, the original
`source_message_id` / `source_chat_jid`, and the assigned escort/start/shift.

Rejection cases (tested): different client, Support group, Release group,
WA-02, incoming client text, unverified sender, no original Draft, weak
evidence, and a second different confirmation for an already confirmed Draft
(`CONFIRMATION_ALREADY_CONFIRMED` → review). Replaying the exact confirmation is
idempotent: no second assignment or event.

---

## 5. Vessel Register

The order Draft is already the register row, in `DRAFT`. It becomes
`CONFIRMED` only through the verified confirmation above. Program creation keeps
Mother, Lighter, Master Mobile, Destination, Start Date, Start Shift, source
message/chat and source identity. A confirmed order is therefore traceable from
the register row to the original client message and the Admin confirmation
message.

---

## 6. Release rules

- Only the approved Release Information group, only an authorized participant,
  only INCOMING messages.
- Structured release slips parse English and Bangla labels
  (`lib/release-slip.ts`): Mother, Lighter, Master mobile, Destination, Escort
  Name, Escort mobile, Start, End, Total day, Food bill.
- Matching is conservative: existing program with the same escort mobile, the
  same normalized Lighter/Mother, start date on or before the release date and,
  when stated, the same start date. Multiple plausible programs →
  `RELEASE_AMBIGUOUS` review. No match → `RELEASE_PROGRAM_NOT_MATCHED` review.
  A release never creates a program.
- The exact existing row is updated, never replaced:
  `end_date`, `end_shift`, `state = RELEASED`, plus `release_message_id`,
  `release_chat_jid`, `release_sender_jid`, `release_account_id` and
  `release_timestamp`.
- `start_date` and `start_shift` are never overwritten. End Date and Release
  Shift remain separate.
- Idempotent: replaying the same release records the source evidence once and
  changes no revision/event. A different second release is
  `RELEASE_CONFLICT_EXISTING_RELEASE` review and preserves the prior values. A
  completed duty is `RELEASE_PROGRAM_ALREADY_COMPLETED` review.
- Unstructured release-group traffic is evidence only: it is matched read-only
  and kept pending for a human. Support/other-group release-like text never
  updates a program.

---

## 7. Database / migration 013

`db/standalone/013_escort_workflow_authorization.sql` (additive, idempotent,
schema 1.8.0):

- `whatsapp_chats.source_role` with a CHECK constraint and an index. Direct
  chats are backfilled from their operator-configured `purpose`; group roles are
  **not** backfilled and require an explicit role.
- `programs.confirmation_chat_jid`, `confirmation_sender_jid`,
  `confirmation_account_id`, `confirmation_timestamp`.
- `programs.release_message_id`, `release_chat_jid`, `release_sender_jid`,
  `release_account_id`, `release_timestamp`, plus a partial index.

Migration order: `012` (Message Intelligence) → `013`. Fresh install and the
1.7.0 → 1.8.0 upgrade both pass on the disposable database. Table count stays
51; only columns and one index are added.

Rollback (disposable/test only, after backup):

```sql
ALTER TABLE programs DROP COLUMN IF EXISTS release_timestamp;
-- ... drop the other release_*/confirmation_* columns added by 013 ...
ALTER TABLE whatsapp_chats DROP COLUMN IF EXISTS source_role;
DELETE FROM schema_migrations WHERE version='013';
UPDATE schema_meta SET value='1.7.0' WHERE key='schema_version';
```

---

## 8. Verification evidence

- `pnpm typecheck` clean; `pnpm lint` 0 errors.
- `pnpm test:unit` 149/149.
- `pnpm test:standalone` **231/231**, including:
  - 66 router tests (Cash/Vessel/router/review/release),
  - 40 new end-to-end Escort workflow tests,
  - migration integrity for 010/011/012/013,
  - Message Intelligence and message mirror regressions.
- Migrations: disposable DB upgraded 1.7.0 → 1.8.0; fresh install verified at
  1.8.0, 51 tables, 12 migrations.
- Isolated runtime against the disposable DB: order → DRAFT, Admin reply →
  CONFIRMED with provenance, Release group → RELEASED with End Date `20/11/26`
  and Night shift while Start Date `17/11/26` and Day shift were preserved;
  `/vessel`, `/vessel/{id}` and `/messages` returned HTTP 200;
  `/api/programs` returned the released row with confirmation and release ids.
- No real WhatsApp send, no Cash/Ledger write, no WA-02 permission expansion,
  no production migration/deployment/restart.

---

## 9. Deployment requirements (Owner approval)

1. Back up the production database.
2. Apply migration `012` then `013` through the existing migration runner
   (schema `1.6.0`/1.7.0 → `1.8.0`).
3. Deploy the application image built from this commit.
4. Verify `whatsapp_chats.source_role` after the direct-chat backfill. The three
   approved group roles are resolved by the approved group-JID map; a different
   group can be set explicitly with `source_role` and must not be inferred from
   its display name.
5. Verify one real order Draft, one Admin confirmation and one Release slip.
6. Bridge 2 → Bridge 1 draft delivery remains a separate, unapproved workflow.

Production remains unchanged until those steps are explicitly approved.
