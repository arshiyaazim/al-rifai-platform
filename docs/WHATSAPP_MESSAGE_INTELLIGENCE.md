# WhatsApp Message Intelligence — data contract and operations

**Implemented:** 2026-11-08  
**Branch:** `feature/phase3-010-011-activation`  
**Status:** implemented and runtime-verified on an isolated dev server against the disposable test database. **Production migration/deployment is pending Owner approval.**

## 1. Existing components reused

| Component | Reuse |
|---|---|
| `whatsapp_messages` | Canonical message row; no second message table. |
| `identity_aliases` | Canonical person/alias registry; PN/LID, confidence, display name, person key, contact metadata. |
| `whatsapp_chats` | Chat label, purpose and authorization. |
| `whatsapp_media` | Actual media file status/bytes. |
| `whatsapp_accounts` | Bridge/account identity and Admin JIDs. |
| `escort_client_group_authorizations` | Group participant → client contact authorization. |
| `employees` | Employee/escort identity fallback. |
| `review_items` / `cash_submissions` | Review status derivation. |
| `audit_events` | Manual identity/domain review history. |
| `lib/whatsapp-identity.mjs`, `mobile-identity.mjs`, `business-rules.mjs` | JID kind, PN/LID, phone normalization. |
| `lib/message-classifier.ts` | Existing CASH/VESSEL classification. |
| `lib/standalone/messages.ts` | Existing inbox repository, extended. |
| `/messages` page | Existing Message Data Table, extended; no second inbox. |

## 2. New database objects (migration 012, additive)

- `whatsapp_messages.mirrored_at` — synchronization time, separate from
  `source_timestamp` (original WhatsApp event time) and `created_at` (first
  ingestion time).
- `whatsapp_calls` — actual bridge call events keyed by
  `(account_id, call_id, chat_jid)`.
- `whatsapp_message_intelligence` — per-message manual review of identity role,
  business domain and review status, with previous values and reviewer identity.
  This is metadata, not a duplicate message table.
- `whatsapp_message_intelligence_view` — read-only joined projection used by the
  API/table. It never writes and never changes authorization.

Rollback for a disposable database:

```sql
DROP VIEW IF EXISTS whatsapp_message_intelligence_view;
DROP TABLE IF EXISTS whatsapp_message_intelligence;
DROP TABLE IF EXISTS whatsapp_calls;
ALTER TABLE whatsapp_messages DROP COLUMN IF EXISTS mirrored_at;
DELETE FROM schema_migrations WHERE version='012';
UPDATE schema_meta SET value='1.6.0' WHERE key='schema_version';
```

## 3. Timestamp semantics

| Column | Meaning | Authoritative? |
|---|---|---|
| `whatsapp_messages.source_timestamp` | Original WhatsApp event timestamp from the bridge | **Yes** |
| `whatsapp_messages.created_at` | First Main Database ingestion time | No (provenance) |
| `whatsapp_messages.mirrored_at` | Most recent synchronization time; changes only when a source row changes | No (provenance) |
| `raw_payload.timestamp` | Original source timestamp string | Evidence |

The UI displays `source_timestamp` in **Asia/Dhaka**. The API returns
`dhaka_date`, `dhaka_time` and `dhaka_timestamp`; ingestion and mirror times are
separate fields. Reconciliation only updates `source_timestamp` when the source
bridge row itself changed; it never substitutes ingestion time.

The three historical WA-01 timestamp mismatches are late source edits; the new
`--mode=reconcile` applies the source value, and the verifier reports a mismatch
until that approved repair is run.

## 4. Identity and contact sources

| Column | Source | Fallback / unavailable |
|---|---|---|
| Sender Saved Name | `identity_aliases.metadata.saved_name` (bridge/contact evidence) | `display_name`, then `NOT_AVAILABLE` |
| My Contact Name | `whatsapp.db` → `whatsmeow_contacts.full_name/first_name/business_name` | `NOT_AVAILABLE` |
| WhatsApp Profile / Push Name | `whatsmeow_contacts.push_name` | `NOT_AVAILABLE` |
| Sender Display Name | `identity_aliases.display_name` / saved / push | JID, then `UNRESOLVED` |
| Sender Mobile | Verified PN JID; BD normalized `+880…`; other PN retained as `+<international digits>` | `NOT_AVAILABLE` for unresolved LID |
| Country Code | `+880` for verified BD; otherwise `NOT_AVAILABLE` | Never guessed from a name or display text |
| Canonical Person ID | `identity_aliases.person_key` | `NOT_AVAILABLE` |
| PN JID | `identity_aliases.canonical_jid` / PN JID | `NOT_AVAILABLE` |
| LID / WhatsApp Identity | Sender LID or bridge `whatsmeow_lid_map` link | `NOT_AVAILABLE` |
| Identity Resolution Method | `PN_JID`, `VERIFIED_ALIAS`, `DISPLAY_NAME`, `UNRESOLVED` | `UNRESOLVED` |
| Identity Confidence | `EXACT`, `VARIANT`, `UNRESOLVED` | `UNRESOLVED` |
| Identity Role | Admin JIDs / group authorization / employee / manual review | `UNKNOWN` |

Names are never fabricated. A LID is never converted to a phone number without
the bridge's own PN link. `whatsapp.db` is read read-only by the sync worker.

## 5. Conversation and media

- Chat type: `GROUP` for `@g.us`, otherwise `DIRECT`.
- Group name: `whatsapp_chats.label` or the bridge chat name; never derived from
  the JID.
- Group participant identity: `identity_aliases` for the exact
  `group_participant_jid`.
- Media status: `STORED` only when the actual file is present and hash-verified;
  `FAILED` retryable; `SKIPPED` source metadata/payload absent; `MISSING` when a
  media message has no `whatsapp_media` row; `NOT_APPLICABLE` for text/reaction.
- Every media message remains in `whatsapp_messages` with its type, filename,
  SHA-256 and length even when no file exists.

## 6. Call trace

The bridge SQLite `calls` table is mirrored into `whatsapp_calls` by the sync
worker. Calls have `call_id`, chat, direction, type, status, duration, ended
time and reason.

Calls are **not** ordinary messages and have no `message_id`. The Message table
therefore shows `NOT_AVAILABLE` for per-message call trace and provides actual
call events in the conversation-level Call trace panel. No call ID is invented
and no ordinary message becomes a call.

## 7. Role and business domain

- Identity role examples: `OWNER`, `ADMIN`, `ACCOUNTANT`, `ESCORT_CLIENT`,
  `ESCORT`, `EMPLOYEE`, `SUPPLIER`, `CUSTOMER`, `UNKNOWN`.
- Business domain examples: `CASH`, `VESSEL`, `SECURITY`, `HR`, `PAYROLL`,
  `OPERATIONS`, `PERSONAL`, `GENERAL`, `UNKNOWN`.
- Automatic domain: existing message classification, then chat purpose.
- Automatic role: account/Admin JIDs, group authorization, employee registry.
- Manual review: `whatsapp_message_intelligence` stores role/domain/review
  status with reviewer and previous values; `audit_events` records the change.
- A role/domain label never grants WhatsApp or business permission.

## 8. API

`GET /api/messages`

Filters: `account`, `chat`, `direction`, `kind`, `q`, `role`, `domain`,
`identity`, `mediaStatus`, `messageType`, `reviewStatus`, `sort`, `limit`,
`offset`. Sort: `time_desc`, `time_asc`, `sender`, `domain`, `role`.

`GET /api/messages?view=stats` — sync/identity/media/call counts.  
`GET /api/messages?view=chats` — conversation list.  
`GET /api/messages?view=calls` — actual call events.

`POST /api/messages`

```json
{
  "action": "classify",
  "account": "wa-01",
  "chat": "<chat_jid>",
  "messageId": "<message_id>",
  "identityRole": "ACCOUNTANT",
  "businessDomain": "PAYROLL",
  "reviewStatus": "CORRECTED",
  "notes": "..."
}
```

Requires `whatsapp.manage`, CSRF, and writes only the intelligence side table +
audit. It never changes Cash, the ledger, WhatsApp permissions or Vessel state.

## 9. UI

The existing `/messages` table now provides all mandatory fields. Default visible
columns: Message Time, Account, Sender Name, Owner Contact Name, Mobile Number,
Group Name, Identity Role, Business Domain, Direction, Message Content, Media
Status. Every required column is available through the **Columns** control; the
table has horizontal scrolling, sticky header, pinned identity/time columns,
filters, sorting, pagination and a row detail expansion with all fields and the
identity/domain review form.

## 10. Verification evidence

- `pnpm typecheck` clean; `pnpm lint` 0 errors.
- `pnpm test:unit` 149/149.
- `pnpm test:standalone` 190/190 (includes message mirror, message intelligence,
  migration 012 integrity and existing Cash/Vessel regressions).
- Isolated dev server (`next start`/standalone) against `alrifai_v2_test`:
  - `/messages` returned **200** with the Message Intelligence table and all
    mandatory column labels.
  - `/api/messages?limit=2` returned all fields, including event/ingestion/mirror
    times, names, mobile, role, domain, media and call columns.
  - `POST /api/messages` classification returned **200**; filter by
    `role=ACCOUNTANT` returned exactly the reviewed message; audit row present.
- Production schema remains **1.6.0**; migration 012 and code deployment require
  separate Owner approval.

## 11. Deployment requirements

1. Back up the production database.
2. Apply migration `012_whatsapp_message_intelligence.sql` through the existing
   migration runner (additive; 49 → 51 tables, schema 1.7.0).
3. Deploy the new app image; restart only the app service.
4. Deploy the updated sync worker image; restart only the sync service.
5. Verify `/messages`, `/api/messages`, call panel and role/domain review.
6. Rollback: previous image plus the SQL rollback above (disposable/test only);
   production rollback uses the previous image and leaves the additive tables
   inert.
