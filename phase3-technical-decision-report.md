# AL-RIFA'I — Phase 3 Technical Decision Report

**Baseline:** `13d660cb0ecfcb9b87cf15f975f93e8aea8f6723`
**Implementation branch:** `feature/phase3-cash-paid-events`
**Schema target:** `1.6.0` (migrations 010 + 011)
**Status:** Implemented and tested in isolation; NOT deployed, NOT migrated in
production, feature flag default OFF.

## 1. Business Paid vs Financial POSTED

| Concept | Write path | Table | Permission |
|---|---|---|---|
| Business Paid | verified WhatsApp message or Office approval | `cash_payment_events` | existing routing / `cash.review` |
| Financial POSTED | explicit `postInstruction()` | `cash_postings` + `ledger_entries` | `cash.post` + ADMIN |

A verified WhatsApp payment therefore creates a Business Paid Event
automatically when the feature flag is on, but remains financially unposted
until an authorized person calls `postInstruction()`. The two timestamps are
separate: `cash_payment_events.paid_at` is the business time;
`cash_payment_event_postings.posted_at` is written only after a real posting.

## 2. WhatsApp eligibility

The existing authorization pipeline is unchanged:

1. `claimMessages()` requires the Live Router activation settings.
2. The chat must be allowlisted for business processing.
3. `cashSourceEligibility()` / `isCashScopeChat()` require WA-01 and the
   Accountant PN/LID direct chat.
4. `isChatAuthorized()` + Admin JID matching require the verified Admin sender.
5. `isAuthorizedCashConversation()` enforces the effective-dated ACCOUNTANT
   registry.
6. Only OUTGOING messages reach `handleCash()`.

WA-02 remains identity-only. No new account, chat or sender is authorized by
this change.

## 3. Single-mobile identity

Owner rule is implemented in the parser and the Office path:

- exactly one identifiable number → `employee_mobile = payout_mobile`;
- two numbers → first is employee ID, second is payout;
- three or more → `AMBIGUOUS_MOBILE_NUMBERS`, review only;
- missing or invalid number → review only.

`employees.employee_mobile` remains the canonical key. The event stores
`employee_link_status = REGISTERED` only when that key exists. An unregistered
number is never attached to another employee and the pipeline never creates an
employee record.

## 4. WhatsApp automatic Paid pipeline point

```
whatsapp_messages
  -> routePendingMessages()
  -> authorization gates
  -> handleCash()
  -> parsePaymentBlocks() (all clean blocks)
  -> createInstruction(..., { whatsAppVerified: true })
       -> cash_instructions (REVIEW)
       -> cash_payment_events (PAYMENT, WHATSAPP)  [flag ON]
  -> no postInstruction(), no cash_postings, no ledger_entries
```

The event and instruction are written in one transaction. A replay or losing
concurrent worker gets `ON CONFLICT DO NOTHING` on the instruction and the event
unique indexes; neither duplicates the payment.

## 5. Office approval point

```
cash_submissions (PENDING_REVIEW)
  -> decideCashSubmission(APPROVED)
     -> cash_instructions (REVIEW)
     -> cash_payment_events (PAYMENT, OFFICE)  [flag ON]
     -> cash_submission_reviews
     -> no posting
cash_submissions (REJECTED)
  -> no event
```

`source_category='OFFICE'` is deliberate even when the candidate carries a
WhatsApp source message: it was verified through Office review and must not be
labelled an independently verified WhatsApp automatic payment.

## 6. Idempotency and concurrency

- `cash_instructions_source_identity` unique index on
  `(source_message_id, source_block_key)`.
- `cash_payment_events_whatsapp_source` unique index on message + block.
- `cash_payment_events_office_submission` unique index on submission.
- `cash_payment_events_instruction_payment` unique index on instruction.
- One correction and one reversal per original event.
- `cash_submission_reviews.submission_id` stays unique.
- The submission row is locked `FOR UPDATE`; the event write is in the same
  transaction.

## 7. Append-only corrections and reversals

`cash_payment_events` has no UPDATE/DELETE path. A correction or reversal is a
new row:

- `CORRECTION` points at `corrects_event_id`, carries the corrected amount;
- `REVERSAL` points at `reverses_event_id`, carries the original amount.

Reporting uses the latest correction amount and excludes reversed events.
Neither operation writes `cash_postings`, `ledger_entries` or `cash_reversals`.
Conversely, a financial reversal does not mutate or auto-reverse the business
event; the two layers remain independent and auditable.

## 8. Migration 011 repair

The previous file used invalid PostgreSQL `CREATE TABLE` elements:
`UNIQUE (…) WHERE …` and `INDEX name (…)`. These were replaced with valid table
constraints plus `CREATE UNIQUE INDEX` / `CREATE INDEX` statements.

Additional corrections:

- no assumed foreign key to `employees(employee_mobile)`;
- `instruction_id` is nullable (a WhatsApp path is not assumed to always have a
  canonical instruction);
- posting timestamp moved to the append-only link table;
- correction/reversal rows replace mutable lifecycle fields;
- `forbid_mutation()` compatibility verified;
- schema version bumped to `1.6.0`.

## 9. Feature flag

`PHASE3_PAID_EVENTS_ENABLED`:

- default: unset / `'0'` → Phase 2 POSTED behaviour, no new events;
- `'1'` → WhatsApp automatic and Office approval create events;
- it is independent of `phase3_router_enabled` /
  `PHASE3_ROUTER_WORKER_ENABLED`;
- rollback is setting it to `'0'`; existing immutable events remain.

While disabled, no query touches the new tables, so an un-migrated database
continues to work.

## 10. Reporting

When ON, dashboard summary and business detail use:

```
Business Paid Events (latest correction, reversal excluded)
UNION ALL
historical POSTED rows with no Business Paid Event
```

This preserves Phase 2 history and prevents double counting. When OFF, the
original POSTED-only query is used unchanged. Calendar comparisons use
`Asia/Dhaka`.

## 11. Verification evidence

| Check | Result |
|---|---|
| `tsc --noEmit` | 0 errors |
| lint | 0 errors, 2 pre-existing warnings |
| unit tests | 117/117 |
| integration tests | 144/144 |
| Next.js build | pass |
| fresh install | schema 1.6.0, 49 tables |
| incremental 1.5.0 → 1.6.0 | 010 then 011, repeat no-op |
| failed migration probe | exit 1, rollback verified |
| production write/deploy | none |

## 12. Known limitations

- The real-message inspection is a bounded read-only sample; it is not a
  complete archive audit.
- 11 sampled blocks remain incomplete by design and go to review.
- Business corrections/reversals have no UI yet; they are server functions with
  tests.
- No production deployment, migration or flag activation is authorized by this
  report.