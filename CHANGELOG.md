# Changelog

## v3.3.20-review-workflow — USER submissions, review delete, cash aliases (2026-11-20)

- Review Queue: Delete is now present in all four domain panels (equal `sm`
  outline buttons) and hard-deletes both the pending submission and, when the
  submission targets an existing row, that domain row; immutable ledger/audit
  rows are never touched. A row with dependent or financial history is refused
  instead of being half-deleted. Approving a USER Delete request applies the
  same domain deletion (program, employee, attendance or unposted cash).
- Review actions: `PENDING_REVIEW` cash submissions are actionable; the
  vessel panel no longer disables Approve for cash/confirmation/release rows.
  Vessel panel columns now include the domain Days/Salary/Conv./Total pay cells
  when the review item targets an existing program.
- USER flows: Employees gained Add/Edit/Delete (staged through Review); Attendance
  gained Edit/Delete (staged); Vessel escort/assign/release/void/end-date edits
  stage as PROGRAM review instead of returning 403; Cash manual payments create
  `cash_submissions` (PENDING_REVIEW), and Cash edit/delete requests use the
  same queue.
- Cash: Google-style backend typeahead in the transaction toolbar (max 10),
  selecting an employee filters to that Employee ID with the existing 20-row
  pagination. New read-only Name Aliases table distinguishes same-ID/different
  name from same-name/different-ID without merging employees.
- Audit: EMPLOYEE and ATTENDANCE domains added to the Audit Trail filters; the
  existing append-only audit tab remains the audit surface.
- Verification: typecheck 0, unit suite 201/201, production build compiled
  (exit 0 on retry after Next's security nudge), Docker build
  `local/al-rifai-platform:v3.3.20-review-workflow` exit 0.
- Staging verification (2026-11-20): review DB suite 7/7 PASS after adding
  `employee_documents` to the reset truncate list; Dockerized Playwright feature
  suite 6/6 PASS (admin pages, USER employee/attendance/vessel/cash submissions,
  approvals, Cash typeahead/aliases, Review Delete) and the original staging
  suite 8/8 PASS. QA found and fixed three real gaps: create submissions shared
  one pending slot (`target_ref` is now unique per create), an open
  `program_assignments` row blocked vessel approval (the reviewer now closes it
  before inserting the reviewed assignment), and Employees/Attendance had no
  toast host for USER submission confirmation.
- Staging schema remains `1.12.0` (production is `1.13.8`); this branch contains
  no migration. No production deployment in this commit.
- Emergency rollback: deploy the previous image tag; this change adds no schema.

## v3.3.18-ui — Home search, mobile cards, cash lookup/icons, draggable assistant (2026-11-20)

- Home: employee search below the All Time cards (name / alias / partial mobile,
  two-column suggestions with the posted Cash total, clear control, profile
  navigation); dashboard cards are two per row on 320–390 px with compact type.
- Employees / Attendance: card labels trimmed to two words; values wrap inside
  the card; the two-line label rule is preserved.
- Cash: `Paid Via WA` card with `Source: WA`; partial mobile/Employee ID Lookup
  fixed in both list and count queries; compact Search submit; aligned
  Import/Export/Print icon group; mobile state filter and Add New Payment at a
  common 44 px height.
- Employee profile cash statement: `Total Amount` (POSTED running balance) and
  `Payout Mobile` columns; `State` / `Source` hidden from the table only; Export
  and Print icons; profile/attendance forms unchanged (side-by-side above
  1000 px, stacked at or below).
- Floating AI assistant is draggable by mouse/touch, clamped to the viewport,
  remembers its position in localStorage, and a drag no longer opens the panel.
- Card groups keep equal heights and contain long values/labels.
- Commit `faa98ec`; image `local/al-rifai-platform:v3.3.18-ui`; app+sync deployed
  2026-11-20; schema unchanged (1.13.8), no migration. Docker build exit 0
  (agent-shell builds stop at Next's security nudge after successful compile).
- Verification: typecheck 0, unit suite 201/201, Docker build 0, /api/health ok.
  Browser QA at 320/375/768/1024/1366 px is OWNER-CONFIRMED (reported OK by the
  Owner; not executed by the agent).
- Known: home-search totals use the POSTED employee summary while the profile
  header `Total Paid` is instruction-based (can differ where REVIEW rows exist).
  `/release` untouched. Next.js security upgrade deferred by Owner decision.

## v3.3.13-ai-assistant — Phase E2 fuzzy search + assistant intelligence (2026-11-16)

- Fuzzy employee search with PostgreSQL pg_trgm: exact mobile, exact/alias name,
  word-level trigram ranking and a visible similarity badge in the lookup.
- Bengali-to-English character transliteration for employee, vessel and cash
  searches (NFC normalisation; decomposed rra/rhha/yya handled).
- AI Assistant intelligence: deterministic read-only planner for search,
  navigation, cash/attendance/vessel summaries, step-by-step guides and the
  Add Employee sidebar. Navigation and form opening always ask first.
- Security: blocked-topic denial (IP, ports, credentials, API keys, database,
  source, deployment) before any model call; no write tools; all data still
  flows through authenticated, capability-checked, read-only APIs.
- Chat window controls: minimize, maximize/restore, close, Escape-to-minimize,
  focus handling and reduced-motion support.
- Mobile-responsive chat at 375px with safe-area insets, scrollable messages
  and an always-reachable launcher; panels auto-minimize when a form opens.
- URL Registry for assistant navigation using the verified page params
  (/cash ignores from/to; dated cash requests target /cash/transactions).
- Unsupported explicit date ranges now return a clear message instead of an
  all-time total; one-digit-off mobiles stay suggestions only.
- Migration 029 registers pg_trgm and the two GIN indexes in the ledger
  (idempotent; live objects already existed).

## v3.3.12-hotfix — Employee workspace 500s + settings cleanup (2026-11-16)

- Fixed the employee detail card 500s: migration 028's employee_documents table
  had no runtime grant, so the profile query failed with Postgres 42501. The
  grant list now ships the table and the profile degrades to an empty document
  list instead of failing the whole request.
- Fixed the attendance and vessel sub-table 500s: empty date inputs were sent
  as `date_from=`/`from=`, which Postgres rejects as an invalid date
  (22007). Empty range values are now omitted, so "all dates" works.
- Uploads report a clear 503 (EMPLOYEE_DOCUMENTS_NOT_GRANTED) instead of a 500
  when the grant is missing.
- Settings: the unused "Authorized chats" table is hidden behind a flag; the
  WhatsApp API and the query remain intact.
- Recruitment provider guard now explains the OpenRouter rule directly.

## v3.3.11-employees — Employee workspace + file uploads (2026-11-16)

- Employee detail card on /employees: name, ID, secondary and family mobile,
  joining date, NID, current/permanent address, designation, salary, 80x80
  photo and document list; a collapsible "More details" block keeps birth
  certificate, passport, duty type, state, aliases and notes.
- Add/Edit employee form now carries exactly the same fields in the same order,
  with salary override (blank = derived ৳400/day) plus profile photo and
  multi-file document uploads.
- Employee sub-tables (attendance, cash, vessel) under the detail card, one
  date range drives all three, 20 rows per page.
- Employees page search box simplified: label removed, magnifier icon, 320px
  compact input matching the cash search.
- New /api/employees/upload, /api/employees/file and document DELETE endpoints
  (<=10MB, MIME whitelisted, path-traversal guarded); uploads persist through
  the ./uploads/employees bind mount.
- DB migration 028: employees.salary_amount, employees.photo_url and the
  employee_documents table with its employee index.
- API keys edit dialog now scrolls (max 85vh) with sticky Save/Cancel, and the
  inactive-key audit report was added.

## v3.3.10-ui-cleanup — UI cleanup + AI key repurpose (2026-11-16)

- API keys table: fixed column overlap (fixed layout, ellipsis cells, inline
  Edit/Test/On-Off/Delete actions), key-coverage summary table, key replacement
  in the edit modal, person/provider guards for recruitment keys.
- Global palette: orange primary (#F97316), white/off-white surfaces, #111827
  headings, #6B7280 secondary text, red danger, blue links, green success.
  Buttons share h-9/px-4/rounded-md and 44px touch targets on mobile.
- Employee lookup: bi-directional name ↔ ID fill with Enter-to-select in Cash,
  Vessel and Attendance forms; shared dropdowns show name + mobile + designation.
- Employees page: search box added (name/mobile/alias, dropdown navigation to the
  profile); Attendance search moved out of the filter row and restyled.
- Dashboard stat cards: 2-column grid below 768px across all dashboards.
- Removed verbose page subtitles (21 pages) and added a session-expired redirect
  to /login while keeping operational hints.
- DB: repurposed the legacy encrypted key to platform-llm (+ platform-assistant,
  ocr tags, gemini-2.5-flash); disabled the 404-looping Gemini row; synced
  app_settings recruitment.mode to LIVE.

## v3.3.0-escort-release — Escort Release parser + review UI (Batch 10)

- Structured release-slip parser now handles multiple escort numbers on one
  label and food bills written inline with the duty-day count.
- New `/release` page: 8 metric cards, search/date/status/mother filters,
  paginated review table, approve (applies the release) and decline
  (records a decision), plus a read-only cash cross-check.
- Structured backfill applied for the eligible slip (1 of 14; 5 already applied,
  3 incomplete, 5 without an eligible program). Payment-line slips were not
  bulk-applied.
- Previous releases: `v3.2.0-home-security` (Batch 9), `v3.0.0-phase4-merged`
  (Batch 8), `v2.9.1-cash-autoconfirm` (Batch 6).

## v1.12.0 — Cash Pipeline Overhaul

- Cash data re-derived from WhatsApp messages (`whatsapp_messages`) as the source of truth.
- Migration 017: `cash_instructions.event_at` stores the real WhatsApp event time.
- `created_at` remains database insertion time; `mirrored_at` remains mirror time.
- Admin WA-01 OUTGOING payment instructions auto-POST with posting + ledger entry; no approval step for this Cash path.
- 9-column `/cash` UI: Date, Employee ID, Name, Designation, Date of Join, Payouts, Amount, Total Paid, Actions.
- Date displays real event time in Asia/Dhaka (`DD-MM-YYYY` + `HH:MM AM/PM`); names are clean single-line values.
- Backfill: 2,359 POSTED instructions, 222 employees, ৳12,11,555.00 (1,211,555.00 BDT).
- 8 incomplete blocks preserved as `cash_submissions` in `PENDING_REVIEW`.
- Legacy IMPORT Cash rows replaced by WhatsApp-linked rows.
- Vessel, OCR, Bridge-2 and deferred tasks 13–15 unchanged.
