# Legacy Business Data Inventory and Import Plan

**Status:** investigated and rehearsed on an isolated clone. **No production import performed.**
**Source:** legacy PostgreSQL database `alrifai` (read-only).
**Target:** `alrifai_v2_phase3`, schema 1.5.0.

---

## 1. Source inventory (read-only)

| Source | Location | Schema | Business state |
|---|---|---|---|
| Legacy | PostgreSQL `alrifai` (679 MB) | 83 tables | **Authoritative historical data** |
| Phase 2 | PostgreSQL `alrifai_v2` (78 MB) | 30 tables, schema 1.2.0 | Structurally present, **0 business rows** |
| Phase 3 | PostgreSQL `alrifai_v2_phase3` | 46 tables, schema 1.5.0 | Live application, **0 business rows before import** |
| WhatsApp archive | `alrifai.public.whatsapp_archive_messages` | native archive | 5,943 archive messages; 14,578 original / 42,817 processing rows |
| Bridge stores | `/var/lib/vps/whatsapp/wa-01|wa-02/store/messages.db` | SQLite | Live ingestion source; not modified |

Phase 2 is not a data source: its employee, program, attendance and cash tables are empty.
The legacy `alrifai` database is the only source with historical business records.

---

## 2. Entity counts and quality

| Entity | Legacy source | Rows | Target | Quality |
|---|---|---|---|---|
| Employees | `employee_master` | **216** | `employees` | all 216 valid `+880…` mobiles, 207 distinct names, aliases present, all `CONFIRMED`; no joining dates |
| Escort/client roster | `escort_roster` | 10 | AI/contact configuration (not employees) | clients/admins, not workforce |
| Vessel orders | `escort_order_register` | 1,030 | review evidence | 616 DRAFT, 413 REVIEW, 1 CONFIRMED; all WA-01; 633 missing duty date; 136 with confirmation evidence |
| Normalized programs | `programs` | **99** | `programs` | 94 Confirmed (valid start/shift), 5 Draft (no start/date); 41 released, 53 assigned; no exact/near duplicates |
| Program pay | `program_pay` | **93** | `program_pay` | 41 CALCULATED (19,100,000 minor), 52 UNRESOLVED |
| Attendance | `attendance_entries` | **439** | `attendance` | 35 employees, all `CONFIRMED`, all `source_ref` match a confirmed program, 0 duplicate keys, hours blank |
| Rates | `escort_rate_config` | **23** | `rate_config` | 23 unique active destination keys |
| Cash instructions | `cash_instructions` | **3,747** | `cash_instructions` | 2,161 REVIEW (107,249,400 minor), 1,586 MANUAL_READY (85,225,900 minor); unique source refs; 23 orphan mobiles; zero blank names |
| Cash postings | `cash_postings` | **1,586** | `cash_postings` | all linked, amount/account match 1,586/1,586 |
| Cash movements | `cash_movements` | 3,172 | provenance | double-entry: Cash Payment −85,225,900; EMPLOYEE_CLEARING +85,225,900 |

`programs.details` (text JSON) contains the authoritative `orderMessageId`,
`confirmationMessageId`, `clientChat`, `endShift`, `releaseConfirmed` and
`releasePoint`, so historical confirmation provenance can be preserved.

---

## 3. Mapping

### Employees
`employee_master.employee_mobile → employees.employee_mobile` (normalized, already
`+880…`), `preferred_name`, `name_aliases`, `duty_type`, `designation`;
`CONFIRMED → ACTIVE`; `joined_on = NULL` (not invented); provenance note.

### Vessel programs
Import only the **94 confirmed** normalized programs with a valid start date and
D/N shift. `DRAFT` rows with no start date are not imported.
`state = RELEASED` when `endDate`, `endShift` and `releaseConfirmed` are present;
otherwise `ASSIGNED`. Never `IN_DUTY`/`COMPLETED` without actual start evidence.
`source_channel = IMPORT`; `source_message_id`/`confirmation_message_id` from the
legacy details; duplicate key = mother + lighter + start date.
Two escort mobiles not present in `employee_master` become derived employee
records from the confirmed program (name + mobile), marked with provenance.

### Attendance
Import only `status = CONFIRMED`; map to `PRESENT`, `hours = NULL`, `source = IMPORT`.
No attendance is inferred from drafts. Every imported row writes a
`LEGACY_ATTENDANCE_IMPORTED` audit event with the legacy `source_ref`.

### Rates and pay
Import 23 active legacy rates, then the legacy `program_pay` values (41 calculated,
52 unresolved). Historical pay is preserved rather than recomputed with incomplete
destination aliases. Pay is derived data; it never creates a financial posting.

### Cash
- `MANUAL_READY` → `POSTED`, `legacy = true`, one `cash_postings` row and one
  `ledger_entries` DEBIT row (`source = IMPORT`), dated by legacy `source_time`.
- `REVIEW` → `REVIEW`, `legacy = true`, no posting.
- Account: the existing `CASH / Main Cash` account (`acc-cash`).
- Balance impact is the historical Cash Payment leg only: **−85,225,900 minor
  (−852,259 BDT)**. The legacy EMPLOYEE_CLEARING credit leg is not recreated,
  because Phase 3 is single-entry per account and no clearing account exists.
  This is mathematically consistent with the legacy Cash Payment balance.

All rows use deterministic `lgcy-*` IDs, `legacy = true`, `source_channel = IMPORT`
and legacy source hashes, so a repeat run inserts nothing.

---

## 4. Isolated rehearsal result

Target: `alrifai_v2_import_test`, a fresh clone of current production
(schema 1.5.0, 9 WA-01 chats, 26 participants).

| Item | Result |
|---|---|
| Employees | 216 imported + 2 derived escorts = 218 |
| Rates | 23 |
| Programs | 94 (41 RELEASED, 53 ASSIGNED) |
| Historical pay | 41 CALCULATED = 19,100,000 minor; 53 UNRESOLVED |
| Attendance | 439 + 439 provenance audit rows |
| Cash instructions | 3,747 (1,586 POSTED, 2,161 REVIEW) |
| Cash postings / ledger | 1,586 / 1,586 |
| Ledger total | 85,225,900 minor |
| Cash account balance | −85,225,900 minor |
| Duplicate employees / programs / attendance | 0 / 0 / 0 |
| Orphan attendance / programs missing escort | 0 / 0 |
| Confirmation without source | 0 |
| WA-01 settings after import | 9 chats, 26 participants, router unchanged |
| Repeat import | 0 new employees/programs/attendance/cash; pay values stable |

Authenticated four-domain verification on the clone:

- Login as a temporary clone-only Admin; `/dashboard`, `/cash`, `/vessel`,
  `/employees`, `/attendance`, `/reports` all 200.
- Cash: create → REVIEW → approve → POSTED → ledger + posting; reverse → VOID.
- Employee: create → PATCH designation.
- Attendance: record → correct with reason → `ATTENDANCE_CORRECTED` audit.
- Vessel: create DRAFT → assign → IN_DUTY → release → COMPLETED; five events.
- General USER: approve/post denied `CAPABILITY_REQUIRED` (403).
- CSV exports contain the full dataset.

---

## 5. Production import scope requiring approval

| Scope | Rows | Financial effect |
|---|---|---|
| A. Master data: employees, rates, programs, pay, attendance | 218 / 23 / 94 / 93 / 439 | None (derived pay only) |
| B. Posted cash history | 1,586 instructions + postings + ledger | Account balance becomes −85,225,900 minor |
| C. Cash review backlog | 2,161 REVIEW instructions | None until an Admin approves/posts |

Recommended order: A first, verify; then B and C only if the Owner confirms the
historical cash account treatment and the negative Cash Payment balance. No
automatic posting is enabled.

**Rollback:** all imported rows are identifiable (`created_by = import:legacy`,
`legacy = true`, `source = IMPORT`, `source_channel = IMPORT`, `lgcy-*` IDs).
Delete in reverse dependency order inside a transaction, or restore the verified
pre-import backup. No existing production row is updated.

**Import command (after approval, production):**

```bash
SOURCE_PGUSER=<read-only-legacy-role> SOURCE_PGPASSWORD=<secret> \
PGHOST=vps-infra-postgres-1 PGDATABASE=alrifai_v2_phase3 \
node --env-file=.env --experimental-strip-types \
  scripts/standalone/import-legacy-business.mjs \
  --domains=employees,rates,programs,pay,attendance \
  --source-db=alrifai --apply
```

Cash domains are separate and require a second approval.

---

## 6. Owner decisions

1. Approve Scope A (master data) for production.
2. Approve or reject Scope B (posted cash history) and confirm the negative
   Cash Payment balance is acceptable.
3. Approve or reject Scope C (2,161 historical REVIEW instructions).
4. Confirm derived escorts (2) are acceptable as employee records.
5. Confirm the 5 legacy Draft programs stay out of production.

---

## 7. Release candidate and production dry-run

- Code commit: `98c9642`
- Image: `local/al-rifai-platform:phase3-ai-rc-98c9642`
- Digest: `sha256:e82d9450f2eea75b0950a3ffde61dea37826f25d386795746d64b87bbea68beb`
- Tests: 83/83 unit, 112/112 integration; typecheck, lint and production audit clean.
- Production dry-run (read-only): 216 employees, 23 rates, 94 programs,
  93 pay rows, 439 attendance, 1,586 postings and 2,161 review instructions
  would be imported; 0 rows exist today; **nothing was written**.
- Production remained schema 1.5.0 with 0 employees, 0 programs, 0 attendance,
  0 instructions and 0 postings after the dry-run.
- The candidate also fixes cash pagination/filters and full CSV export, which
  the current production image lacks. Activating the import therefore needs a
  new approved image deployment in addition to the data import.

---

## 8. Cash coverage investigation (2026-11-06)

| Stage | Count | Date range |
|---|---|---|
| Authorized Admin→Accountant mirror (Phase 3) | 2,582 messages (2,388 OUTGOING) | 2026-07-12 → 2026-11-06 |
| Legacy original messages in that chat | 2,538 | 2026-07-12 → 2026-11-05 |
| Native archive in that chat | 2,247 | 2026-07-12 → 2026-10-25 |
| Parsed payment messages (linked to instructions) | 2,137 | 2026-07-12 → 2026-11-05 |
| Cash instructions | 3,747 (551×1, 1,562×2, 24×3 per message) | 2026-07-12 → 2026-11-05 |
| Posted (`MANUAL_READY`) | 1,586 | 2026-07-12 → 2026-10-18 |
| REVIEW | 2,161 | 2026-07-12 → 2026-11-05 |
| Earliest employee-wise allocation | **2026-07-12 14:26:32 UTC** | same as earliest source message |

**Unlinked payment-like messages:** 191.
- 151 were ingested and classified `NO_PAYMENT_BLOCK_PARSED` / `financialAction: NONE` (parser gap).
- 40 are below the 19634 cutover watermark (historical backlog, not live).
- 28 are exact text duplicates of already-linked messages.
- 42 outgoing messages after the last instruction are all below the watermark (rowids 19434–19624), so the live router correctly does not treat them as post-cutover events.

**Parser correction:** `parsePaymentBlocks` now accepts common `MD:` names and duplicate
`ID:` prefixes; recoverable clean blocks rose from 37 to 96. It still refuses a
single-phone message rather than inventing the second identity.

**Backfill rehearsal on a fresh production clone:**

| Result | Count |
|---|---|
| Already linked | 2,137 |
| Clean blocks | 97 |
| New REVIEW instructions | **52** |
| New REVIEW amount | **5,431,100 minor (54,311 BDT)** |
| Duplicate candidates sent to review | 45 |
| Incomplete/ambiguous candidates sent to review | 68 |
| Cash postings created | **0** |
| Repeat run | **0 new instructions**, 45 duplicate candidates, 68 ambiguous |

The backfill creates REVIEW instructions only. It never approves or posts, and it
uses the instruction unique index plus payload hashes for idempotency.

---

## 9. Escort Release integration

The approved scope includes the **Escort Release Slip** group (1,073 mirrored
messages). Phase 3 previously sent release-slip text into the order parser, which
could create false programs. A dedicated parser (`lib/release-slip.ts`) and a
release-first router path now:

- parse `---(Escort Release)---` blocks with mother/lighter/escort/start/end/total/food;
- match exactly one open program by escort mobile, optional lighter, start date and release date;
- update only that program (`RELEASED`, end date/shift), the open assignment, events and source link;
- send incomplete, ambiguous, unmatched, unstructured or failed releases to the Review Queue;
- never create an order from the release group.

Regression tests cover structured release, ambiguous match, unstructured
release-group chatter and incomplete slips. Historical released programs (41)
remain as imported; no historical attendance or pay is inferred from a release.

---

## 10. Program assignment, source-link and lifecycle repair

The initial program import created `programs` and `program_pay` but not the
integration rows. `scripts/standalone/repair-legacy-program-links.mjs`
idempotently adds, for each imported program:

- one `program_assignments` row (open for ASSIGNED, closed for RELEASED);
- a primary source-message link and a confirmation link;
- `CREATE_PROGRAM`, `ASSIGN_ESCORT` and, for released programs,
  `RELEASE_PROGRAM` events.

It does not change program dates, state, escort identity or amounts. Clone
rehearsal: 94 assignments (53 open / 41 released), 188 source links, 229 events;
repeat run inserts 0.
