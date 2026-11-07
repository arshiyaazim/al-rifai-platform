# AL-RIFA'I — Cash Dashboard & Release Plan

Status: Planning and source changes; not deployed.
Repository: /opt/al-rifai-platform
Branch: main

## 1. Completed source commits

- 3afa286 — Add Insights and AI Assistant sidebar links.
- 6750d46 — Preserve sanitized post-login return URL.
- ab80793 — Add responsive Cash dashboard and collapsible workspace navigation.
- 4e4a4d3 — Add payment summaries, employee lookup and transaction filters (Phase 2 backend/UI).

The Phase 2 change is committed and pushed to `origin/main`. Build validation
and production deployment remain pending.

## 2. Cash Dashboard UI requirements

Replace the existing five summary cards with eight:

Row 1:
1. Total Paid Amount
2. Current Month Paid
3. Today's Paid Amount
4. Yesterday Paid

Row 2:
5. Paid Via WA
6. Paid By Office
7. Number of Employee
8. Last Month Paid

Requirements:
- Four cards per row on desktop.
- Responsive tablet and mobile layout.
- Approximately 2–4px spacing between card rows.
- Target approximately 10% narrower cards than the existing design,
  subject to actual container width.
- Every card opens a corresponding data-detail view.
- Sidebar must support expand/collapse and mobile overlay.
- Tables must be content-sized and horizontally scrollable if needed.

## 3. Payment detail tables

Common columns:
- Sl
- Employee ID
- Name of Employee
- Designation
- Date of Join
- Payout Number
- Amount
- Total Paid
- Three-dot action menu

Display payout method shorthand beside the payout number
in parentheses, as represented in the source message.
Do not create a separate method display column.

Transaction detail actions:
- View original source evidence
- Add new transaction
- View all transactions of the employee
- Edit
- Cancel
- Save
- Delete

Actions must be functional and permission-controlled.
Approved or paid financial records must preserve audit history.
Cancellation, deletion, and reversal semantics require
explicit review before implementation.

## 4. Forms and search

- New payment instruction: collapsible.
- Record income / expense: collapsible.
- Display the two forms side by side on desktop,
  with approximately 3–5px gap.
- Keep the existing income/expense form behavior for now.

Employee search:
- Backend-driven lookup/typeahead.
- Search by name, alias, employee ID, or mobile number.
- Maximum ten suggestions; fewer if fewer matches exist.
- Two dropdown columns: Name and Mobile / Employee ID.
- Selecting a suggestion fills the corresponding employee
  name and ID fields.
- Reuse this pattern in relevant pages, dialogs, and drawers.

Date filtering:
- Support a single date or a start/end date range.
- Allow combined employee and date filters.
- Match summary totals to detail rows.

## 5. WA-01 / Bridge-1 payment business rule

An eligible WhatsApp payment instruction is considered PAID
without a separate accountant approval when all conditions hold:

1. It is an outgoing message from the verified Admin
   account on WA-01 / Bridge-1.
2. It contains identifiable payment information, including
   the relevant employee identity, payout number and method,
   and amount, as represented in the authorized message format.
3. It was sent to the designated Accountant's authorized
   direct conversation.

The source message and provenance must be retained and
viewable from transaction details.

Automatic eligibility checks are required; an additional
human approval is not required for an eligible WA payment.

Prevent duplicate financial entries from message replay,
resynchronization, or repeated processing.

WA-02 remains identity-only unless separately authorized.
Do not broaden the authorized WhatsApp conversation scope.

## 6. Office payment rule

Paid By Office means user-submitted cash payment transactions.

A user-submitted transaction must not contribute to an
employee's paid total until the required approval is complete.

Pending, Draft, Rejected, and Unpaid transactions are excluded
from all Paid Amount totals.

Eligible WA payments and approved Office payments both
contribute to Total Paid Amount without double counting.

## 7. Implementation order

1. Read-only audit of /cash frontend, API, schema, and
   existing financial workflows.
2. Cash UI changes and dedicated Git commits.
3. Backend summary, employee lookup, date filters,
   and transaction detail APIs.
4. Authorized WA payment classification and recording.
5. Office submission and approval integration.
6. Migration 011 only if new database structure is required.
7. Validation, backup, migrations, image build, deployment,
   production verification, and cleanup.

## 8. Database migration policy

Migration 010 is an existing planned migration whose exact
content and status must be verified before deployment.

Cash UI work does not need to wait for Migration 010.

If schema changes are necessary for Cash, prepare a separate
Migration 011 after inspecting the existing schema.

Apply migrations in dependency order, after backup and
explicit production approval.

No production database migration is authorized by this plan.

## 9. Release and cleanup policy

- Keep the existing production image unchanged during development.
- Validate the integration of main and Phase 3 feature work
  before building the release image.
- Run appropriate typecheck, tests, and build validation.
- Verify authentication, Cash, Vessel, WhatsApp, and data
  integrity after deployment.
- Delete only confirmed unused Docker images after successful
  deployment and rollback readiness review.
- Preserve PostgreSQL volumes, WhatsApp stores, credentials,
  and database backups.

## 10. Outstanding verification

- Actual /cash source and backend API mapping.
- Existing payment tables, status semantics, and constraints.
- Employee ID, alias, and mobile identity mapping.
- WhatsApp source-to-payment persistence and deduplication.
- Existing approval and audit-trail behavior.
- Migration 010 contents and Migration 011 necessity.
- Client-bundle compatibility of login redirect change.
- Final image source provenance and release readiness.

## 11. Phase 2 implementation status (source only)

Status: implemented in `4e4a4d3`; not deployed. No migration, container
rebuild, production database write or production configuration change was
performed.

### Payment basis and timezone

- A paid amount is an existing `cash_postings` row whose instruction remains
  `state = 'POSTED'`.
- A reversed instruction becomes `VOID`, so its original posting is excluded
  from every summary and detail total. The immutable posting and reversal rows
  are retained.
- `cash_postings.instruction_id` is unique. Reporting joins cannot duplicate
  an instruction/posting pair, and `q` alias matching uses `EXISTS` rather than
  a row-multiplying join.
- The payment date is `cash_postings.posted_at`, interpreted in the explicit
  business timezone `Asia/Dhaka`.
- Legacy `IMPORT` postings remain included. `Paid By Office` means every
  non-WhatsApp source (`source_channel <> 'WHATSAPP'`), so WhatsApp plus Office
  equals the total.

This phase does not introduce business-classified Paid records. WA-01
automatic eligibility and Office approval integration remain future work.

### Read-only APIs

- `GET /api/finance?resource=summary` returns the eight card values and the
  Dhaka `asOfDate`.
- `GET /api/finance?resource=payments` accepts `date`, `from`, `to`,
  `employeeMobile` (or `employee`), `source` (`WHATSAPP` or `OFFICE`), `q`,
  `page` and `pageSize`.
- Both resources require `cash.read`.
- `GET /api/employees?lookup=1&q=...` returns at most ten suggestions and
  requires `employee.read`. Search covers preferred name, recorded aliases and
  mobile. The verified identifier is the existing primary key
  `employees.employee_mobile`; no second identifier was invented.

### Cash dashboard and transaction details

- Every summary card opens `/cash/transactions` with the filter that produces
  its value. Current month, today, yesterday and last month use the Dhaka
  business date; the same shared predicate computes the card and the filtered
  total.
- `/cash/transactions` lists posted payments with: Sl, Employee ID, Name of
  Employee, Designation, Date of Join, Payout Number, Amount, Total Paid and
  Actions.
- Payout Number includes the method shorthand in parentheses. There is no
  separate method column.
- `Total Paid` is the employee's all-time posted total. The page also shows the
  filtered total for the current date/employee/source selection.
- Filters support a single date or a start/end range, employee identifier,
  source and name/alias/mobile search. Invalid dates are reported in the UI and
  are never applied.
- The list is paginated on the server in pages of 25.

### Employee lookup and safe actions

- The new payment form uses a backend typeahead. Selecting a suggestion fills
  the name, verified mobile/ID and, when empty, the payout number.
- The form keeps the existing endpoint and action: `POST /api/finance` with
  `instruction.create`. Shared `ActionForm` behavior is unchanged.
- The three-dot menu exposes only implemented actions:
  - View original source evidence (when a source message ID exists).
  - View all employee transactions.
  - Add a new transaction (opens the payment form with the employee prefilled).
- Edit, Cancel, Delete and Save are intentionally absent because their backend
  semantics and audit protections are not implemented for posted payments.

### Validation

- TypeScript `tsc --noEmit`: passed.
- Lint: 0 errors; two pre-existing warnings in
  `tests/standalone/message-router.test.mjs`.
- Unit tests: 114/114 passed, including new Cash filter/date tests.
- Integration tests were not run in this workspace because no disposable test
  database is configured. `tests/standalone/cash-dashboard.test.mjs` is added to
  `npm run test:standalone` and can be run with `npm run test:cash-dashboard`
  against the isolated test database.
- Browser visual/responsive testing was unavailable.

### Known limitations

- Method shorthand uses the canonical method label (`bKash`, `Nagad`, `Rocket`,
  `Bank`, `Cash`). The raw source-message token is not stored as a separate
  structured field.
- Historical legacy payments are counted under Office because they are not
  WhatsApp-sourced.
- Deployment, production verification and any WA/Office classification work
  remain outside this phase.
