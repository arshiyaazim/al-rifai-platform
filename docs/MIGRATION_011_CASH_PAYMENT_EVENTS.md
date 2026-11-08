# Migration 011 — Cash Business Paid Events Technical Documentation

**Date:** 2026-11-08
**Migration:** `db/standalone/011_cash_payment_events.sql`
**SHA-256:** `4203fdbeff6eede80cc44799b6cdad4112b37e621ef44cf09d22d0ac58964165`
**Branch:** `feature/phase3-integration` @ `0b309b2`
**Production status:** **NOT APPLIED** (production schema `1.5.0`, 46 tables,
migrations `002`–`009`; `PHASE3_PAID_EVENTS_ENABLED` absent/OFF).
**Feature status:** implemented and isolated-tested; **NOT production-active**.

---

## A. Original objective

Migration 011 adds a **Business Paid Event** layer that is separate from the
financial ledger:

| Concept | Meaning | Storage |
|---|---|---|
| WhatsApp Cash payment | Verified Admin→Accountant payment instruction | `cash_instructions` + `cash_payment_events` |
| Office payment | Authorized Office approval of a cash candidate | `cash_submissions` + `cash_instructions` + event |
| Business Paid | Verified business payment occurrence | `cash_payment_events` (`PAYMENT`) |
| Financial POSTED | Immutable ledger posting | `cash_postings` + `ledger_entries` |
| Correction | Append-only corrected business amount/name/method | new `CORRECTION` event |
| Business reversal | Append-only business cancellation | new `REVERSAL` event |
| Financial reversal | Separate `cash.reverse` ledger contra entry | `cash_reversals` + CREDIT ledger |

The Owner requirements encoded:

- WA-01 verified Admin OUTGOING messages to the single authorized Accountant
  direct chat are Cash-eligible.
- Multiple payment blocks in one message are processed separately.
- Exactly one identifiable mobile = employee identity = payout destination.
- Two mobiles = employee ID + payout; 3+ = review.
- Missing method is never fabricated.
- A verified WhatsApp payment creates Business Paid automatically when the flag
  is on; no Office approval is required.
- Office approval creates exactly one Business Paid Event.
- Business Paid must never automatically call `postInstruction()`, write
  `cash_postings` or write `ledger_entries`.
- Dashboard/reporting must distinguish Business Paid from Financial POSTED and
  never double count.
- Admin list/detail/correction/reversal API/UI.
- Historical data is not re-processed or backfilled.

## B. Migration SQL

File: `db/standalone/011_cash_payment_events.sql` (172 lines).

### B.1 `cash_payment_events`

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `^[A-Za-z0-9._:-]{1,80}$` |
| `event_type` | text | `PAYMENT`, `CORRECTION`, `REVERSAL` |
| `instruction_id` | text | FK → `cash_instructions(id)` ON DELETE RESTRICT; nullable |
| `source_submission_id` | text | FK → `cash_submissions(id)` RESTRICT; Office provenance |
| `employee_mobile` | text NOT NULL | `^\+8801[3-9][0-9]{8}$`; **no FK to employees** |
| `payout_mobile` | text NOT NULL | same canonical format |
| `employee_name` | text NOT NULL | 1–150 chars |
| `employee_link_status` | text | `REGISTERED` / `UNREGISTERED` snapshot |
| `amount_minor` | bigint | `> 0` |
| `method` | text | `bkash/nagad/rocket/bank/cash` |
| `source_category` | text | `WHATSAPP` / `OFFICE` |
| `source_message_id` | text | WhatsApp message ID |
| `source_block_key` | text | `payment-block-N` |
| `status` | text | `PAID`, `CORRECTED`, `REVERSED` |
| `paid_at` | timestamptz | business time; reporting uses Asia/Dhaka |
| `reason` | text | 1–500 chars where required |
| `corrects_event_id` | text | FK self-reference for corrections |
| `reverses_event_id` | text | FK self-reference for reversals |
| `created_by` | text NOT NULL | actor ID |
| `created_at` | timestamptz | default `now()` |

Checks:

- `cash_payment_events_shape`: PAYMENT/PAID without correction/reversal links;
  CORRECTION/CORRECTED with `corrects_event_id` + reason; REVERSAL/REVERSED with
  `reverses_event_id` + reason.
- `cash_payment_events_whatsapp_source`: WHATSAPP events require both message ID
  and block key.
- `cash_payment_events_office_submission`: Office PAYMENT requires a submission.

### B.2 Unique / partial indexes

| Index | Definition | Purpose |
|---|---|---|
| `cash_payment_events_whatsapp_source` | unique `(source_message_id, source_block_key)` WHERE PAYMENT+WHATSAPP | one event per WhatsApp block |
| `cash_payment_events_office_submission` | unique `(source_submission_id)` WHERE PAYMENT+OFFICE | one event per Office submission |
| `cash_payment_events_instruction_payment` | unique `(instruction_id)` WHERE PAYMENT | one payment event per instruction |
| `cash_payment_events_one_correction` | unique `(corrects_event_id)` WHERE CORRECTION | one correction per event |
| `cash_payment_events_one_reversal` | unique `(reverses_event_id)` WHERE REVERSAL | one reversal per event |
| `cash_payment_events_instruction` | `(instruction_id)` | lookups |
| `cash_payment_events_employee` | `(employee_mobile, paid_at DESC)` | employee history |
| `cash_payment_events_source` | `(source_category, paid_at DESC)` | source reporting |
| `cash_payment_events_status` | `(status, paid_at DESC)` | status reporting |
| `cash_payment_events_paid_at` | `(paid_at DESC)` | time reporting |

### B.3 `cash_payment_event_postings`

| Column | Notes |
|---|---|
| `payment_event_id` | PK, FK → `cash_payment_events(id)` RESTRICT |
| `instruction_id` | FK → `cash_instructions(id)` RESTRICT |
| `posting_id` | UNIQUE, FK → `cash_postings(id)` RESTRICT |
| `posted_at` | only written after a genuine posting |
| `created_by`, `created_at` | audit metadata |

Index: `cash_payment_event_postings_instruction`.

### B.4 Append-only protection

Triggers `cash_payment_events_immutable` and
`cash_payment_event_postings_immutable` call the baseline
`forbid_mutation()` on UPDATE/DELETE. Corrections/reversals are new rows.

### B.5 Grants, dependencies, version

- Runtime grants via `scripts/standalone/grants.mjs`:
  `cash_payment_events` and `cash_payment_event_postings` = SELECT + INSERT only.
- Depends on `cash_instructions`, `cash_submissions`, `cash_postings`,
  `forbid_mutation()`, `schema_meta`; all exist before 011.
- Must follow 010.
- Sets `schema_meta.schema_version = '1.6.0'`.
- Fresh install: 49 tables, 10 migration rows, `1.6.0`.
- Incremental 1.5.0→1.6.0: 010 then 011.
- Repeat migration: no-op.
- Failure probe: rollback clean; no probe table/ledger row.

### B.6 Checksum

`4203fdbeff6eede80cc44799b6cdad4112b37e621ef44cf09d22d0ac58964165`

## C. Source implementation

### C.1 WhatsApp pipeline

```text
wa-01 OUTGOING message
  -> processPending()/routePendingMessages()
  -> loadRouterConfig() [DB gate + watermark + business chats]
  -> claimMessages() [PENDING/FAILED/stale, source_rowid > watermark]
  -> isChatAuthorized()
  -> classifyDomain() = CASH
  -> Admin JID + wa-01 + isAuthorizedCashConversation()
  -> handleCash()
  -> parsePaymentBlocks() [all clean blocks]
  -> createInstruction(..., {whatsAppVerified:true})
       -> cash_instructions REVIEW
       -> insertBusinessPaidEvent() PAYMENT, WHATSAPP [flag ON]
  -> no postInstruction()
```

| Stage | File / function | Lines |
|---|---|---|
| Worker/API entry | `lib/phase3-router-worker.ts`; `app/api/whatsapp/route.ts`; `lib/standalone/whatsapp.ts::processPending` | 315–322 |
| Router config/claim | `lib/message-router.ts::loadRouterConfig`, `claimMessages` | 130–166, 181–235 |
| Chat authorization | `isChatAuthorized` | 269–302 |
| Classification | `lib/message-classifier.ts::classifyDomain` | 93–145 |
| Cash authorization | `lib/cash-source-eligibility.ts::cashSourceEligibility`; `lib/authorized-contacts.ts::isAuthorizedCashConversation` | 25–34; 50–70 |
| Cash handler | `lib/message-router.ts::handleCash` | 477–569 |
| Parser | `lib/history-extraction.mjs::parsePaymentBlocks` | 99–186 |
| Identity normalization | `employeeMobile` | 46–50 |
| Event writer | `lib/standalone/finance.ts::insertBusinessPaidEvent` | 128–161 |
| Instruction+event transaction | `createInstruction` | 163–207 |
| Financial posting | `postInstruction` | 288–350 |
| Posting link | `postInstruction` event-link block | 317–333 |

### C.2 Office pipeline

```text
cash_submissions PENDING_REVIEW
  -> decideCashSubmission(APPROVED) [cash.review + ADMIN]
  -> cash_instructions REVIEW
  -> insertBusinessPaidEvent() PAYMENT, OFFICE [flag ON]
  -> cash_submission_reviews
  -> no postInstruction()
```

| Stage | File / function | Lines |
|---|---|---|
| Submit | `lib/standalone/finance.ts::submitCash` | 621–656 |
| Decide | `decideCashSubmission` | 658–682 |
| Event insert | `insertBusinessPaidEvent` | 647–665 |
| Audit | `CASH_PAYMENT_EVENT_CREATED` | 662–664 |

Office approval is always `source_category='OFFICE'`, even if the candidate has
a WhatsApp source message; it is not labelled an automatic WhatsApp payment.

### C.3 Correction and reversal (business vs financial)

| Operation | Function | Lines | Writes |
|---|---|---|---|
| Business correction | `correctBusinessPaidEvent` | 796–827 | new CORRECTION event + audit |
| Business reversal | `reverseBusinessPaidEvent` | 834–861 | new REVERSAL event + audit |
| Financial posting | `postInstruction` | 288–350 | `cash_postings` + `ledger_entries` + link |
| Financial reversal | `reversePosting` | 378–423 | `cash_reversals` + CREDIT ledger |

Business correction/reversal never writes `cash_postings`, `ledger_entries` or
`cash_reversals`. Financial reversal never mutates the business event.

### C.4 Admin API/UI

| Layer | File / route | Lines |
|---|---|---|
| List API | `GET /api/finance?resource=business-paid` | `app/api/finance/route.ts:22–44` |
| Detail API | `GET /api/finance?resource=business-paid-event&id=` | `app/api/finance/route.ts:45–49` |
| Correction API | `POST /api/finance` `business-paid.correct` | `app/api/finance/route.ts:125–131` |
| Reversal API | `POST /api/finance` `business-paid.reverse` | `app/api/finance/route.ts:133–136` |
| List service | `listBusinessPaidEvents` | `lib/standalone/cash-dashboard.ts:536–650` |
| Detail service | `getBusinessPaidEventDetail` | `lib/standalone/finance.ts:471–535` |
| List UI | `/cash/paid` | `app/(workspace)/cash/paid/page.tsx`; `components/standalone/business-paid-view.tsx` |
| Detail UI | `/cash/paid/[id]` | `app/(workspace)/cash/paid/[id]/page.tsx` |

### C.5 Reporting

| Function | Lines | Behavior |
|---|---|---|
| `businessPaidSummary` | `cash-dashboard.ts:329–415` | events + latest correction; reversed excluded; legacy POSTED with no event appended |
| `cashDashboardSummary` | `417–419` | flag ON → business summary; OFF → original POSTED summary |
| `listBusinessPaidEvents` | `536–646` | same basis; `event_id`, employee, source, posting status |
| `dhakaTimestamp` | `104–119` | Asia/Dhaka display |

Double counting is prevented by excluding any `cash_postings` instruction that
has a PAYMENT event. Historical POSTED rows without an event remain included.

## D. Historical coverage

Read-only production aggregates at audit time (2026-11-08):

| Item | Count |
|---|---:|
| Cash instructions | 3,838 |
| Business Paid Events | 0 (migration not applied) |
| Instructions with source message/block | 3,838 |
| Instructions without employee/payout mobile | 0 |
| WA-01 outgoing text in Accountant conversation | 2,431 |
| Payment-format messages (`ID:`) | 2,341 |
| Total `ID:` blocks | 2,341 |
| Messages with 2+ `ID:` markers | 1 |
| Messages with more than one instruction | 0 |
| Pending cash submissions | 117 |
| Pending missing core fields | 72 |
| Unregistered employee mobiles | 39 |
| Unregistered payout mobiles | 1,402 |
| Same-day employee+amount repeat groups | 1,574 groups / 3,217 rows |

Important distinctions:

- **Historical WhatsApp mirror**: 34,677 messages; independent of this migration.
- **Existing Cash Instructions**: 3,838 REVIEW/POSTED rows; remain unchanged.
- **Existing Financial POSTED**: 1,586 postings/ledger entries; remain authoritative.
- **New Business Paid Events**: zero in production until flag + migration + live
  traffic.
- **Missing retroactive events**: all 3,838 existing instructions remain without
  a Business Paid Event. No backfill was run or authorized.
- **Multi-block gap**: 1 message has two `ID:` markers but no message has more
  than one instruction; the old backfill likely skipped the second block.
- **Pending candidates**: 72 lack core fields and may fail strict approval until
  corrected.
- **Unregistered mobiles**: 39 employee/1,401 payout references are not in
  `employees`; new events would be `UNREGISTERED`, never reassigned.
- **Potential duplicate groups** are not confirmed duplicates and must not be
  cleaned automatically.

## E. Feature completion matrix

| Feature | Implemented | Tested in isolation | Deployed | Activated | Missing / blocked |
|---|---|---|---|---|---|
| WhatsApp parser single-mobile | Yes | Yes | No (integration branch) | No | — |
| Multi-block processing | Yes | Yes | No | No | historical gap remains |
| WhatsApp automatic PAYMENT | Yes | Yes | No | No | migration + flag |
| Office PAYMENT | Yes | Yes | No | No | migration + flag |
| PAYMENT append-only | Yes | Yes | No | No | migration |
| CORRECTION append-only | Yes | Yes | No | No | migration + flag |
| REVERSAL append-only | Yes | Yes | No | No | migration + flag |
| Posting link | Yes | Yes | No | No | migration + flag |
| No automatic postInstruction | Yes | Yes | No | No | — |
| Admin list API | Yes | Yes | No | No | migration + deploy |
| Admin detail API | Yes | Yes | No | No | migration + deploy |
| Admin list/detail UI | Yes | Build/HTTP | No | No | migration + deploy |
| Correction/reversal UI/API | Yes | Yes | No | No | migration + flag |
| Business Paid summary | Yes | Yes | No | No | migration + flag |
| Legacy POSTED parity | Yes | Yes | Production currently POSTED-only | No event flag | — |
| Historical backfill | **No** | No | No | No | not authorized |
| Existing pending candidate correction | **No** | No | No | No | reviewer action |

## F. Migration readiness — direct answers

1. **What does applying 011 enable?**
   It creates `cash_payment_events` and `cash_payment_event_postings`, unique
   indexes, immutable triggers and runtime append-only grants. It enables the
   Business Paid write/read code paths and `/cash/paid` pages to operate.

2. **What remains disabled with `PHASE3_PAID_EVENTS_ENABLED=0`?**
   No new WhatsApp automatic events, no Office approval events, no corrections or
   reversals (services throw `PAID_EVENTS_DISABLED`), and dashboard summary uses
   the original POSTED basis. Existing data and POSTED reporting remain unchanged.

3. **What existing behavior must remain unchanged?**
   WA-01 authorization/watermarks/business chats, WA-02 current scope, parser
   provenance, `cash.review`/`cash.post` RBAC, finance lifecycle, immutable
   posting/ledger/reversal records, Cash Freeze/immutability protections, and
   no automatic financial posting.

4. **Which APIs/pages depend on the new schema?**
   `GET /api/finance?resource=business-paid`,
   `GET /api/finance?resource=business-paid-event&id=`,
   `POST business-paid.correct/reverse`, `/cash/paid`, `/cash/paid/[id]`, and the
   flag-ON dashboard summary. `/cash/paid` queries 011 even when the flag is OFF,
   so **011 must be applied before starting the integrated image**.

5. **What historical records remain without Paid Events?**
   All 3,838 existing cash instructions and all 2,341 historical payment-format
   messages, until a separately authorized retroactive process exists. No
   backfill is part of this migration.

6. **What is required for safe activation?**
   Fresh backup; migration 010 then 011; deploy integrated image with Paid OFF;
   verify flag-OFF parity, schema `1.6.0`, 49 tables, grants and immutable
   triggers; pause/observe router; Owner approval; set
   `PHASE3_PAID_EVENTS_ENABLED=1`; verify list/detail/reporting; keep financial
   posting separate. Rollback is setting the flag to `0`; do not delete events.

**Migration 011 does not implement a complete business workflow by itself.** It
adds storage and constraints; activation requires application deployment, the
Paid flag, existing Cash routing, and explicit operational approval.
