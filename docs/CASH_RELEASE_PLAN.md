# AL-RIFA'I — Cash Dashboard & Release Plan

Status: Planning and source changes; not deployed.
Repository: /opt/al-rifai-platform
Branch: main

## 1. Completed source commits

- 3afa286 — Add Insights and AI Assistant sidebar links.
- 6750d46 — Preserve sanitized post-login return URL.

Both changes are committed locally.
Build validation and production deployment remain pending.

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
