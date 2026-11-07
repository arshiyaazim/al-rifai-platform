# AL-RIFA'I — Cash Phase 3: Implementation Record

**Repository:** `/opt/al-rifai-platform`
**Baseline:** `13d660cb0ecfcb9b87cf15f975f93e8aea8f6723` (`main`)
**Implementation branch:** `feature/phase3-cash-paid-events`
**Schema target:** `1.6.0` (migrations 010 + 011, pending production approval)

This document is the implementation record, not a proposal. The previous
"implementation complete" note was incorrect: it only added an Office-side
insert and did not implement WhatsApp automatic Paid, the single-mobile rule,
database validation, tests or documentation. Those gaps are corrected here.

## 1. Preserved baseline

- Canonical worktree `/opt/al-rifai-platform` was inspected and left intact.
  Its pre-existing dirty files (modified `lib/standalone/finance.ts`, untracked
  migrations/reports and the `layout.tsx.backup-20261107-192036` backup) were
  not discarded.
- Implementation was performed in a separate worktree
  `/opt/al-rifai-phase3-cash` on branch `feature/phase3-cash-paid-events`.
- Migration 010 was compared byte-for-byte with historical commit `3e0dd01`;
  the recovered file is identical (SHA-256
  `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`).

## 2. Delivered functionality

### 2.1 WhatsApp Cash pipeline

- `handleCash()` now processes **every** clean payment block in a message, not
  only the first. Each block gets its own `cash_instructions` row keyed by
  `(source_message_id, source_block_key)`.
- Existing authorization is preserved: WA-01 only, verified Admin sender,
  authorized Accountant direct conversation, OUTGOING direction. WA-02 is still
  rejected as `CASH:WRONG_ACCOUNT`.
- When `PHASE3_PAID_EVENTS_ENABLED=1`, `createInstruction()` appends exactly one
  `cash_payment_events` PAYMENT row in the same transaction as the instruction.
  It never calls `postInstruction()` and never writes a posting or ledger row.
- The event carries WhatsApp message ID, block key, canonical employee mobile,
  payout mobile, method, amount, business payment time and `REGISTERED` /
  `UNREGISTERED` employee-link status.

### 2.2 Single-mobile Employee ID rule

- `parsePaymentBlocks()` applies the final Owner rule:
  - one identifiable mobile → `employee_mobile = payout_mobile`;
  - two mobiles → canonical ID + payout structure;
  - three or more → `AMBIGUOUS_MOBILE_NUMBERS` and review.
- A missing canonical employee record is recorded as `UNREGISTERED`. No
  employee row is created or reassigned by the payment pipeline.

### 2.3 Parser evidence and changes

A bounded, read-only sample of the authorized WA-01 Admin→Accountant
conversation was inspected (2,395 textual outgoing messages; 2,320 with an
`ID:` block). Numbers and names are not committed.

Observed categories:

| Category | Observation |
|---|---|
| Canonical two-number block | `ID: <id> <name> <payout>(B) <amount>/-` |
| Single-number variants | name before number, or number before name; 10 messages |
| Hyphenated/separated numbers | `01712-345678`, `+880 1846-…` |
| Method markers | `(B)`, `(N)`, `(C)`, `{B)`, missing closing bracket |
| Amount shapes | `500/-`, `500/--`, `500-`, `Tk: 500/-`, amount on next line |
| Multi-line blocks | payout or method on a following line |
| Multi-block messages | one message containing two `ID:` blocks |
| Bangla | Bangla digits, `(বি)`, `(নগদ)` and Bangla notes |
| Incomplete/ambiguous | missing amount, missing method, 10-digit invalid number |

Parser changes:

- lenient phone extraction with spaces/dots/hyphens;
- single-number identity rule;
- `(C)`/`(R)`/`(BANK)` and word labels, preserving existing `B`/`N` behavior;
- multi-line block assembly up to the next `ID:` line;
- amount forms with one/two dashes, `Tk:` label, or amount on the next line;
- missing method is never fabricated as `cash`;
- all ambiguous blocks go to `cash_submissions` review.

Before/after on the sample: 2,243 → 2,309 clean blocks; remaining 11 blocks are
genuinely incomplete (5 missing amount, 4 unresolved name, 2 missing method).

### 2.4 Office payment processing

- `decideCashSubmission()` keeps `cash.review`, ADMIN-only, reviewer/submitter
  separation and the existing transaction boundary.
- APPROVED creates the linked REVIEW instruction and, when the flag is enabled,
  exactly one Business Paid Event with `source_category='OFFICE'` and
  `source_submission_id`.
- Pending/rejected submissions never create events.
- Office approval does not call `postInstruction()`.
- Method, employee name and employee mobile are no longer fabricated. A missing
  method fails with `PAYMENT_METHOD_UNRESOLVED`; one mobile becomes the payout.

### 2.5 Reporting

- Flag OFF: existing POSTED-based dashboard behaviour is unchanged.
- Flag ON: `cashDashboardSummary()` uses Business Paid Events plus historical
  POSTED rows that have no Business Paid Event. A posting whose instruction has
  a business event is not counted twice. Reversed events and their postings are
  excluded; corrections use the latest correction amount.
- `listBusinessPaidEvents()` returns the matching detail rows.
- All date boundaries use `Asia/Dhaka`.

## 3. Migrations

### 010 — `vessel_draft_delivery.sql`

- Recovered byte-for-byte from `3e0dd01`.
- Adds only `vessel_draft_deliveries`; no outbound sender, worker, permission or
  message send is activated.
- Added to the fresh installer and runtime grants. Not applied to production.

### 011 — `cash_payment_events.sql`

- Replaced invalid table-element `UNIQUE … WHERE` and `INDEX …` declarations
  with supported constraints and separate `CREATE UNIQUE INDEX` / `CREATE INDEX`
  statements.
- `cash_payment_events` is append-only: PAYMENT, CORRECTION and REVERSAL rows.
- `cash_payment_event_postings` records a financial posting link only when
  `postInstruction()` genuinely posts; it does not create an event.
- No foreign key to `employees(employee_mobile)` is assumed; the mobile is
  recorded with a `REGISTERED`/`UNREGISTERED` snapshot.
- `forbid_mutation()` is reused for both tables.
- Schema version becomes `1.6.0`.

Checksums:

| Migration | SHA-256 |
|---|---|
| 010 | `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7` |
| 011 | `4203fdbeff6eede80cc44799b6cdad4112b37e621ef44cf09d22d0ac58964165` |

## 4. Verification summary

- Typecheck: pass (0 errors).
- Lint: 0 errors (2 pre-existing test warnings).
- Unit: 117/117 pass.
- Integration: 144/144 pass (includes 12 Business Paid tests and 5 migration
  integrity tests).
- Build: pass.
- Fresh install: schema `1.6.0`, 49 tables, 10 migration-ledger rows.
- Incremental 1.5.0 → 1.6.0: 010 then 011 applied; second run no-op.
- Failed migration probe: exit 1, probe table absent, no ledger row.
- No production database, deployment, Docker restart or WhatsApp send occurred.

## 5. Remaining deployment steps (not authorized here)

1. Review and merge the implementation branch.
2. Back up production and rehearse migrations 010/011 on a production copy.
3. Apply migrations with the checksum-tracked runner.
4. Deploy with `PHASE3_PAID_EVENTS_ENABLED=0` first; verify flag-OFF parity.
5. Enable the flag only after Owner approval; keep `cash.post` separate.
6. Roll back by setting the flag to `0`; existing events remain immutable.