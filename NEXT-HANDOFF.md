# NEXT-HANDOFF

**Session ended:** 2026-11-21 — `v3.3.23-review-workflow-next16.4.6` is deployed (app + sync, same tag).
**Current state:** `main` = `44d72ad` contains the security update, USER review
workflow and Task 07/08 business rules; Next.js `16.4.6`, React/React DOM
`19.2.6`; migration 030 applied (29 history rows), schema label `1.13.8`. Health
ok. Rollback tags: `v3.3.21-review-workflow-next16.4.6` and
`v3.3.19-next16.4.6`.
**Feature status:** merged (no rebase); lint 0/0, typecheck 0, unit 201/201,
full DB suite 258/258, staging QA 15/15. Cash toolbar and migration 030 live.
**Cash status:** not frozen; protection is capability-based (`cash.post`,
`cash.reverse`) plus immutable triggers and explicit posting. `PHASE3_PAID_EVENTS_ENABLED=0`
only disables optional Business Paid reporting, not core Cash.

## 2026-11-22 — Escort order / office-assignment backfill (staging only)

**Status:** STAGING VERIFIED — production untouched. Branch
`feature/escort-order-backfill`; `main`/`origin/main` remain at `c875d18`.
No WhatsApp message was sent (outbound count unchanged at 13,922 on the clone).

**Parser tolerance added**
- Unlabelled `M.V.` cards: mother on the first line, one lighter line, `PLACE`
  destination, `NUMBER`/`MOB`/`MASTER NUMBER` master mobile.
- Starred header cards (`*M.V.BULK BEQUIA*` + `1 *M.v.Bismillah* ...`).
- `MV,` / `M,V,` / numbered lighters, 2-lighter messages, serial suffixes.
- A master-mobile line that glued two numbers keeps the first valid mobile and
  records `MULTIPLE_MOBILES_FIRST_USED`.
- Cancellation notices never become orders.

**Backfill audit (`scripts/backfill-vessel-orders.ts`)**
- Dry-run by default, `--apply` for the staging clone only; forces the vessel
  draft transport off; never sends WhatsApp messages. Program creation runs on
  an explicit transaction client, so the draft-delivery hooks are skipped and
  historical drafts are not queued (`vessel_draft_deliveries` unchanged).
- Identity dedupe: source message + lighter, plus a dry-run model of
  `createProgram`'s same-vessel/same-day duplicate rule.
- Office matching: exact first; spelling-tolerant rows are added only when the
  exact set has no live row covering the duty date (mother ≥ 0.85, lighter
  ≥ 0.82), and a glued master-mobile line is treated as untrusted.
- Office duty start comes from the template body (`28/10/26 ((D)`), not from the
  forwarding timestamp; the shift likewise comes from the body.
- Row model respected: a closed row whose start..end window covers the message
  counts as matched history, never as a missing program. Only active
  `DRAFT`/`ASSIGNED`/`CONFIRMED` rows are written; a duty row that no longer
  covers the message is Review (`OUTSIDE_DUTY_WINDOW`).
- Escort-change notices are handled: the short header quotes the original
  assignment and the detail line supplies name/mobile/start/shift. The previous
  row is closed at the shift before the new start and a new row is inserted for
  the same mother/lighter. The BULK BEQUIA/BAITULLAH pair is the proof:
  Rakib ended 26/10 N, Payel-Hossain started 27/10 D as CONFIRMED.
- The row being continued is repaired to the canonical `vessels` name only on a
  unique close match (BULK BEQUA → BULK BEQUIA), so the new row does not inherit
  an old typo.
- `confirmation_*` is never overwritten with an office-group message id; the
  client confirmation chain keeps ownership.
- Fixed `handleEscortChangeOn` reading a pg `date` as `Thu Oct 01`, which made
  every live escort change fail with `invalid input syntax for type date`.

**Staging clone result (01/10/2026–22/11/2026, WA-01)**
- Client: 157 incoming messages, 93 parsed blocks, 78 existing, 15 missing;
  10 programs created, 4 absorbed by the six-field duplicate rule, 1 block left
  without a master mobile; 0 duplicate blocks.
- Office: 78 assignment-like messages, 77 parsed; 40 matched (19 fuzzy),
  28 closed rows matched as history (2 with an escort conflict), 8 no-match,
  6 escort conflicts, 1 ambiguous overlap; 12 escort assignments, 1 duty
  date/shift update, 1 escort change, 21 no-op.
- Second `--apply` on the same clone: 0 created, 0 updated (idempotent); the
  escort change reports one no-op instead of a new row.
- Closed programs revived: 0. No WhatsApp message sent; draft deliveries
  unchanged.

**Open**
- 17 office rows still need a human decision (8 no-match, 6 bare-assignment
  conflicts, 2 closed-history conflicts, 1 overlapping-window ambiguity) and
  one client block lacks a master mobile. Nothing was written for them.
- The 24/10 Baitullah assignment overlaps two rows because the previous Phase2
  backfill created a second row without closing the first at the boundary; the
  escort-change pass closes the later row correctly from 27/10 onward.
- Production apply has NOT been run and needs explicit Owner approval.

## 2026-11-21 — Task 08: final merge, migration 030 and production deploy

**Status:** COMPLETE. Branch merged into `main` as `44d72ad` (no-ff); Production
runs `local/al-rifai-platform:v3.3.23-review-workflow-next16.4.6` (app + sync).
Migration 030 applied through the repo runner; schema label remains 1.13.8 and
migration history is 29 rows. Health ok; Next 16.4.6; React 19.2.6.

**Cash toolbar**
- Desktop: 36px × 320px search input; search, state filter, Add Payment and
  export/actions on one line; 10px gaps, 16px card padding, 10px toolbar
  bottom margin.
- Mobile: 44px full-width search; 50/50 All states + Add Payment row; export
  checkbox + action icons row; 8px vertical gaps. Mobile Search submit is hidden
  because the backend typeahead is the search action.
- Cash search input bug (old 220px flex-basis height) is fixed; card/table
  vertical gaps are compact; floating Ask has a 56px table clearance.

**Rates and migration**
- Approved rates: Nowapara 1200, Nagor Bari 1100, **Bagha Bari 1100** (Owner
  confirmed 110 was a typo), Jhalokathi 1100, Barishal/Vhola 1000, Local/CTG 0,
  Faridpur 1000.
- Migration 030 contains only `rate_config` upserts. It contains no QA user,
  synthetic seed or test fixture. Candidate `alrifai_staging_aligned` has 29
  migration-history rows and label 1.13.8; the label stays 1.13.8 because 030 is
  data-only. Production will get 030 through the repo migration runner only,
  never by restoring the candidate.
- Staging is switched to the verified candidate (`PGDATABASE=alrifai_staging_aligned`),
  health schema 1.13.8, Playwright 15/15.

**Backup**
- Custom-format production dump created before deploy in the root-only backup
  area; size 12,027,400 bytes; `pg_restore --list` 507 objects; SHA-256 recorded
  beside the dump. Rollback images v3.3.19-next16.4.6 and
  v3.3.21-review-workflow-next16.4.6 are retained.

**Verification**
- Lint 0/0, typecheck 0, unit 201/201, full DB suite 258/258, staging QA 15/15.

## 2026-11-21 — Task 07: business rules + 258/258 DB suite (local branch only)

**Status:** implemented on `chore/task05-lint-schema-parity`; **not merged, not
pushed, not deployed**. `main` / `origin/main` remain `3631b49`; Production
remains `v3.3.21-review-workflow-next16.4.6` and healthy.

**Implemented business rules**
- Employee ID: escort mobile is the identity; existing employee is attached to
  duty, missing identity is created once. Cash `ID:` mobile is the employee,
  the mobile after the name is payout; a single mobile is the identity.
- Join date: assignment/cash creates use the real WhatsApp event day (Dhaka);
  no duplicate employee row. Timezone tests now compare the DB `date` text, not
  a JS `Date` re-projection.
- Payroll: escort stays BDT 200 per 12-hour shift (BDT 400/day). Security adds
  the Owner's one-shift BDT 400 minimum premium in the attendance summary.
- Vessel duplicate: primary identity = mother + lighter + master + escort
  (lighter is the multi-vessel barrier). Same date/shift is duplicate; a new
  date/shift auto-corrects the existing row to the latest date. The old
  duplicate-warning-review branch was removed. Front-end edit/correction stays.
- Release/food bill: existing 150-divisor and ±1-day matching rules remain and
  pass the release tests.
- Destination: spelling aliases + 50% similarity normalization (N. Gonj,
  Narayangonj, n.para, b.bari, etc.). Migration 030 seeds/updates the Owner
  conveyance rates: Nowapara 1200, Nagor Bari 1100, Bagha Bari 1100,
  Jhalokathi 1100, Barishal/Vhola 1000, Local/CTG 0, Faridpur 1000.
- Cash search CSS bug fixed: the old flex-basis stretched the input to 220px;
  it is now 36px desktop / 44px mobile with 8px vertical and 10px horizontal
  padding. Home search input is 40px desktop / 44px mobile.

**Verification**
- `npm run lint`: **0 errors / 0 warnings**.
- `npm run typecheck`: **0 errors**.
- `npm run test:unit`: **201/201**.
- Full `test:standalone` on a disposable clone from the aligned candidate:
  **258/258 pass, 0 fail, 0 skip**; Review alone 7/7.
- Staging aligned candidate (`alrifai_staging_aligned`, schema 1.13.8, 29
  migrations including 030) with temporary image
  `v3.3.22-task07-verify`: Dockerized Playwright **15/15 pass** (feature 6/6,
  baseline 8/8, concurrent 1/1).
- Main/production were not touched; temporary image/containers/clones were
  removed after QA. Existing staging DB/volume remains.

**Pixel measurements requested by the Owner (staging aligned candidate)**
- Cash search input: desktop 36px high × 320px wide; padding 8px top/bottom,
  10px left/right. Search card padding 16px top/bottom; toolbar margin-bottom
  12px. Mobile: 44px high × 320px wide, same 8px vertical padding.
- Home search typing area: desktop 40px high × 1074px wide; mobile 44px high ×
  351px wide; horizontal padding 32px left / 42px right.

**Next:** Owner approval is required to commit/merge/push this branch and to
apply migration 030 to Production. Do not deploy the branch as-is.

## 2026-11-21 — Task 05: lint cleanup + aligned staging candidate (superseded by Task 07)

**Status:** implemented and committed on `chore/task05-lint-schema-parity`
(`1a92636`); **not merged, not pushed, not deployed**. `main` and Production
remain at `3631b49` / `v3.3.21-review-workflow-next16.4.6`.

**Lint and static checks**
- `npm run lint`: 9 warnings → **0 errors / 0 warnings** (exit 0).
- `npm run typecheck`: 0 errors.
- `npm run test:unit`: 201/201 pass.
- Root causes fixed: missing stable `load` callbacks in two history tables,
  unused state setter, browser `assign` redirect changed to `replace`, unused
  filter props/imports, and unused test helpers/variables. No blanket disables.

**Schema alignment**
- Created a new candidate DB, `alrifai_staging_aligned`, from a schema-only
  Production dump plus only `schema_meta` / `schema_migrations` metadata and a
  small synthetic baseline (default cash account, AI job catalog, feature flags,
  recruitment setting).
- Candidate: schema 1.13.8, 28 migrations (latest 029), 68 public tables.
  Existing `alrifai_staging`: 1.12.0, 62 tables. Existing DB/volume was not
  modified.
- Full schema dump diff: **0 lines**. Catalog diff (tables/columns/indexes/
  constraints/triggers): **0 lines**, 1,451 items compared.
- The six extra Production tables are diagnostic snapshots; their definitions
  match exactly after restore. No migration was run and no raw Production rows
  were copied.
- Candidate is **prepared only**; staging was not switched because the full
  suite did not pass (see below).

**Full DB suite (historical — superseded by Task 07)**
- Command: `npm run test:standalone` on a disposable clone created from the
  aligned candidate. Guard verified the host was the staging PostgreSQL
  container and the database name was the run clone; Production credentials were
  never used.
- Historical result: **258 tests — 247 pass, 11 fail, 0 skip**. Task 07 fixed
  them and reached **258/258**; see the Task 07 section above.
- Remaining failures (needs investigation before any claim of completion):
  domain `programs: create, duplicate...` (pkey conflict instead of
  `DUPLICATE_PROGRAM`), domain late-rate payroll recalculation, escort
  ±1-day duplicate, confirmation classification
  (`CONFIRMATION_SCORE_BELOW_THRESHOLD` vs unmatched), register formatting/
  pagination, escort join-date, one element-based cash auto-post, vessel ±1-day
  review, review duplicate candidate, and ambiguous Admin confirmation.
- The run created disposable clones (`alrifai_task05_*`) and dropped them after
  the run. The aligned candidate remains for the next session.

**Staging/UI verification**
- Built a temporary staging-only image `v3.3.22-task05-lint-verify` and ran the
  Dockerized Playwright suites against the existing staging DB: **14/14 pass**
  (feature 6/6 + baseline 8/8), including cash typeahead, Review, vessel,
  attendance and employee flows.
- Temporary image, staging app container and override file were removed after
  verification; the old staging DB volume remains intact. No Production action.

**Safe next verification**
1. Start from a new local worktree/branch; never run the suite on Production.
2. Recreate the aligned candidate from the schema-only Production dump plus
   metadata and synthetic baseline; check `schema_meta`, migrations and the
   catalog diff before testing.
3. Create a fresh disposable clone from that candidate; include
   `employee_documents` in every truncate reset; run the full suite with the
   host/database-name guard.
4. Treat 11 failures above as blockers until explained/fixed; do not call the
   suite passed or switch staging on a partial run.
5. Only after 258/258 (or an Owner-approved documented exception) should the
   staging database pointer be switched, and then health/schema must be checked.

**Next session state (2026-11-21):**
- Current production release: `v3.3.21-review-workflow-next16.4.6` (app + sync, same tag).
- Next.js advisory state: **RESOLVED by 16.4.6** (OSV 0; React 19.2.6 unchanged).
- Staging E2E: **COMPLETED — 6/6 feature + 8/8 baseline + 1/1 concurrent PASS**.
- Production: deployed and healthy; Owner completed a manual authenticated smoke
  (domain visits + Review approval). Agent production smoke was limited to
  health/login/auth-guard because the bootstrap admin credential returned 401.
- Future Next.js advisories: re-check and plan separately; never disable the nudge.
- Escort Release `/release`: **Not Started** (separate future project).
- Home Search total vs Employee Profile `Total Paid`: **Owner Decision Pending**.

**Next session:** read the 2026-11-20 section below, then the Known issues.
**Read first:** `AGENTS.md`, `docs/PROJECT_KNOWLEDGE.md`,
`docs/VESSEL_ORDER_DRAFT.md`, `docs/LEGACY_PHASE3_COMPARISON.md`,
`docs/PRODUCTION_URLS.md`, `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`,
`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`, `docs/MAIN_RECONCILIATION_PLAN.md`,
`docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`,
`docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`, `docs/BUSINESS_WORKFLOW_BACKLOG.md`,
`docs/PHASE3_GO_NO_GO_7da17f1.md`, `docs/WHATSAPP_MESSAGE_MIRROR.md`, `docs/WHATSAPP_MESSAGE_INTELLIGENCE.md`, `docs/ESCORT_ORDER_RELEASE_WORKFLOW.md`.

**Report language:** English only. Always state whether a finding is
**implemented**, **clone-tested**, **production-deployed**, **live-verified**,
**OWNER-CONFIRMED** or **BLOCKED**.

---

## High Priority Technical Debt & Future Fix Guidelines (2026-11-21)

These are required follow-ups before the next feature or database change. They
are ordered by urgency and must not be silently skipped.

1. **Lint — resolved on the Task 07 branch.** `npm run lint` is 0 errors /
   0 warnings without disables. The branch is not merged; keep the 0/0 gate
   after approval.

2. **Schema alignment — candidate verified, not switched.** `alrifai_staging_aligned`
   is 1.13.8 with 29 migrations (030 data-only); schema/catalog diff against the
   Production schema was 0 before 030. The existing `alrifai_staging` (1.12.0)
   remains the default staging DB. Switch only with Owner approval.

3. **Full DB suite — 258/258 on Task 07.** Always use a disposable clone from
   the aligned candidate, with a host/database-name guard, and drop it
   afterwards. Never run it against live Production. Task 07 result:
   258 pass, 0 fail, 0 skip; Review alone 7/7.

### Agent verification tools and lessons

- Playwright MCP server and browser tools were installed/available, but the
  automated runs in this session used **Dockerized Playwright v1.65 via CLI**.
  The MCP browser-tool path was not exercised against this app; do not claim it
  was. Next agent: try the MCP browser tools first for interactive verification;
  if they are unavailable or cannot reach the TLS host, fall back to the
  Dockerized Playwright suite and record which path was used.
- Automated verification is mandatory before commit/deploy. A green
  health/login check is not a substitute for authenticated domain QA. Production
  authenticated smoke in this session was **OWNER-CONFIRMED manually**, not
  agent-run; the agent saw 401 from the bootstrap credential.
- Keep the Dockerized suites: baseline 8 tests, feature workflow 6 tests,
  concurrent submissions 1 test, and Review DB 7 tests. Add a test for every new
  USER/ADMIN workflow before merging.
- Staging DB tests must use a clone; the reset helper truncates business data and
  is not safe against a database whose data must be preserved.

### Deployment and Git guardrails observed

- Never deploy a feature branch built on an older Next.js after a security
  merge. Build from `main` and verify `next`/React versions inside the image.
- `feature/user-review-workflow` and `security/nextjs-upgrade` both tracked
  `origin/main`; always push with an explicit refspec to avoid accidentally
  updating `main` from the wrong branch.
- Resolve CHANGELOG/NEXT-HANDOFF conflicts by preserving both sides; never drop
  the security or feature section.
- Use explicit `git add <file>` calls; do not use `git add .` or `git add -A`.
- Remove temporary verification images and staging containers after QA; keep
  the staging volume and rollback image unless the Owner explicitly approves
  their removal.

---

## 2026-11-20 — v3.3.18-ui: home search, mobile cards, cash lookup/icons, draggable assistant

**Status:** implemented, committed, production-deployed, and browser QA is
**OWNER-CONFIRMED OK** (reported by the Owner; the agent did not run a browser).

**Commit:** `faa98ec785b83474e5f6ce2ea60d699f42d65ebe` —
`feat(ui): home search, cash lookup/icons, mobile cards, draggable assistant`
(18 files). Local `main` = `origin/main` = `faa98ec`.

**Image:** `local/al-rifai-platform:v3.3.18-ui`
(`sha256:d100317a01cc66ae6f74a65e30508f87f0b018dab9bf95dde4875a444d8d22ad`),
built from the `faa98ec` tree; Docker build exit 0. The image was verified before
deploy: the 18 changed files predate the image build, its compiled output carries
the new strings, and copied `db/standalone/schema.sql` / `scripts/sync-worker.mjs`
hashes match the commit.

**Deployed:** 2026-11-20 08:13:50Z — app + sync only, no migration, no database
change. `/api/health` = `{status: ok, database: ok, schemaVersion: 1.13.8}`.

**Rollback:** image tag only — set `ALRIFAI_TAG=v3.3.17-final` and run
`docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app sync`
(the old image is retained; no schema rollback).

**Delivered**
- `/home`: employee search below the All Time cards (name / alias / partial mobile;
  two-column suggestion with the posted Cash total; clear; opens the profile);
  dashboard cards two per row at 320/375/390 px with compact type.
- `/employees`, `/attendance`: two-word card labels; values wrap inside the card;
  two-line label handling preserved.
- `/cash`: `Paid Via WA` card with third line `Source: WA`; partial mobile/Employee
  ID Lookup fixed in both list and count SQL; compact Search submit; Import /
  Export / Print icon group; mobile state filter and Add New Payment aligned at
  44 px.
- `/employees/[mobile]` (and `/cash/employee/[id]`): cash statement shows
  `Total Amount` (POSTED running balance) and `Payout Mobile`; `State` / `Source`
  hidden from the table only (data still in API); Export + Print icons. Profile
  and attendance forms remain side-by-side above 1000 px and stacked at/below.
- Floating assistant: pointer drag (mouse/touch), viewport clamp, position in
  `localStorage`, drag no longer opens the panel.
- Card groups: equal heights, overflow guards; approved clamps only.

**Verification**
- Typecheck 0; unit suite 201/201; `git diff --check` clean.
- Docker build exit 0; image/production image IDs match.
- Production health ok; login page 200; live CSS hash matches the image.
- Browser viewports: OWNER-CONFIRMED OK (agent has no browser on the host).

**Known issues / next steps**
1. Home-search totals use `/api/employees/summary` (POSTED postings); the profile
   header `Total Paid` is instruction-based. At audit time 6 employees differed by
   ৳7,299 (their 6 REVIEW rows). Not changed — decide the authoritative basis.
2. 1024 px keeps the profile forms side-by-side (1000 px breakpoint, Owner decision).
3. Employee Profile has no CSV import (Owner decision: Export + Print only).
4. `/release` (Escort Release) remains untouched; separate future project.
5. Next.js 16.4.1 advisories were resolved by the 16.4.6 upgrade deployed
   2026-11-20 (OSV 0; React 19.2.6 unchanged). Future advisories require a new
   review; never disable the nudge or upgrade just to make a build pass.
6. The application tree was clean at deploy time; this handoff (with AGENTS.md,
   PLATFORM-GUIDE.md and CHANGELOG.md) is committed in the session-closure
   documentation commit.

---

## 2026-11-20 — Staging E2E verification (production untouched)

**Status:** COMPLETED — **8/8 PASS**. Staging evidence only; this is **not**
Production authenticated regression.

- Isolated `al-rifai-staging` Compose project: separate network, Postgres
  container and volume; app at `https://127.0.0.1:8443` with a self-signed
  certificate. No production volumes, tokens, DB or `.env` values were used.
- Synthetic data: 3 employees, 4 cash instructions (3 POSTED, 1 REVIEW), 3
  postings. Staging schema upgraded 1.12.0 → 1.13.8 with migrations 018–029.
- Dockerized Playwright v1.65 (`@playwright/test`): 8/8 PASS — login,
  home/search, employee profile, cash, CSV/PDF export, SSE `/api/events`,
  assistant read-only and browser console-error sweep.
- Evidence retained in `/opt/al-rifai-staging/artifacts`: screenshots (Home at
  320/375/768/1024/1366 plus login/profile/cash/assistant), traces, HTML report,
  CSV and PDF.
- Staging app+DB containers are stopped; the DB volume and config are retained
  for future Vessel/Release/Review work. Restart from `/opt/al-rifai-staging`
  with `docker compose --env-file .env.staging -p al-rifai-staging -f compose.yaml up -d`.
- Limitations: synthetic data only; assistant runs with `AI_LLM_ENABLED=0`
  (deterministic read-only only); mobile Profile/Cash screenshots were not
  taken; Production authenticated regression is **NOT VERIFIED**.

**No Production deployment, restart, migration or rollback was performed in this
session. No deployment is pending or authorized by this task.**

---

## 2026-11-08 — Escort order → confirmation → register → release workflow

**Branch:** `feature/phase3-010-011-activation`
**Status:** implemented, clone-tested and runtime-verified on a disposable
database; **production migration 013 and deployment pending Owner approval.**

- Added explicit conversation source roles (`whatsapp_chats.source_role`):
  direct verified Escort Client chats are `ORDER_INTAKE`; the Accountant chat is
  `CASH_ONLY`; the approved Support group is `SUPPORT_ONLY`; the Release
  Information group is `RELEASE_ONLY`; the remaining approved vessel group is
  `OTHER_APPROVED`; unclassified groups are `REVIEW_REQUIRED`.
- Order Drafts now require WA-01 + DIRECT + ORDER_INTAKE + INCOMING + an EXACT
  canonical PN identity match. Groups never create Drafts; Cash/WA-02 never
  enter the vessel workflow.
- Admin confirmation is restricted to a verified Admin OUTGOING reply in the same
  original client chat, matched through `lib/vessel-match.ts`, and persists
  confirmation message/chat/sender/account/timestamp.
- Release is restricted to the approved Release Information group; it updates
  the exact existing program with `end_date`, `end_shift` and release
  provenance, preserves start date/shift, and is idempotent.
- Migration `013_escort_workflow_authorization.sql` (additive, schema 1.8.0).
- Tests: `pnpm test:standalone` **231/231** (40 new workflow tests), unit
  **149/149**, typecheck clean, lint 0 errors. Fresh install and 1.7.0 → 1.8.0
  upgrade verified on the disposable database.
- Runtime: order → DRAFT, Admin reply → CONFIRMED, Release group → RELEASED with
  End Date/Release Shift while Start Date/Shift were preserved; `/vessel`,
  `/vessel/{id}`, `/messages` and `/api/programs` returned HTTP 200.
- No production migration, deployment, restart, WhatsApp send or Cash/Ledger
  write. No Git push.

---

## 2026-11-08 — WhatsApp Message Intelligence (unified table) implemented

**Branch:** `feature/phase3-010-011-activation`
**Status:** implemented and runtime-verified on an isolated dev server against
`alrifai_v2_test`; **production migration/deployment pending Owner approval.**

### What was added

- Migration `012_whatsapp_message_intelligence.sql` (additive, schema `1.7.0`,
  51 tables): `whatsapp_messages.mirrored_at`, `whatsapp_calls`,
  `whatsapp_message_intelligence`, read-only
  `whatsapp_message_intelligence_view`, indexes and grants.
- Sync worker: `mirrored_at`, bridge `calls` mirror, `whatsapp.db` contact
  evidence (saved name / Owner contact name / push name / lid↔pn), full reconcile
  and explicit media status.
- Existing `/messages` repository/API/table extended: all mandatory columns,
  search/filter/sort/pagination, column visibility/pinning, row detail,
  identity/domain review (`POST /api/messages`, `whatsapp.manage`, audited).
- Calls panel shows actual `whatsapp_calls` events; per-message call columns are
  `NOT_AVAILABLE` because calls have no message_id.
- `docs/WHATSAPP_MESSAGE_INTELLIGENCE.md` records the data contract, sources,
  timestamp rules, media/call semantics and rollback.

### Verification

- `pnpm typecheck` clean; `pnpm lint` 0 errors.
- `pnpm test:unit` 149/149.
- `pnpm test:standalone` **190/190**.
- Isolated dev server against `alrifai_v2_test`:
  - `/messages` HTTP **200** with the Message Intelligence table and all required
    column labels.
  - `/api/messages?limit=2` returned event/ingestion/mirror times, names, mobile,
    identity, role, domain, media and call fields.
  - `POST /api/messages` classification **200**; role filter returned exactly the
    reviewed row; audit row present.
- No production migration, build deploy, container restart or data write.

### Remaining approvals

1. Apply migration 012 to production (49 → 51 tables, schema 1.7.0).
2. Deploy the app and updated sync worker; verify `/messages`, API, call panel
   and role/domain review.
3. Run the previously approved mirror reconcile/media-status steps after backup.
4. Bridge 2 → Bridge 1 draft delivery remains the separate blocked business
   workflow.

---

## 2026-11-08 — WhatsApp MCP → Main Database mirror audit and fix

**Read-only audit + code fix; production repair/redeploy pending approval.**
Bridge stores: `/var/lib/vps/whatsapp/wa-01/store/messages.db`,
`/var/lib/vps/whatsapp/wa-02/store/messages.db`.
Main DB: `alrifai_v2_phase3`, `whatsapp_messages` / `whatsapp_media`.

### Current production evidence (17:01Z)

| Metric | WA-01 | WA-02 |
|---|---:|---:|
| Source messages | 19,490 | 15,333 |
| Main messages | 19,490 | 15,333 |
| Missing / extra / duplicate | 0 / 0 / 0 | 0 / 0 / 0 |
| Field mismatches | 3 timestamps (late edits) | 0 |
| Checkpoint lag | 0 | 0 |
| Source media messages | 3,414 | 2,351 |
| `whatsapp_media` rows | 133 (STORED 133) | 227 (STORED 121, FAILED 106) |
| Missing media rows | 3,281 | 2,124 |
| Source media with URL/key | 3,256 / 3,256 | 2,016 / 1,893 |

- The **message mirror is complete at record level** for both bridges; continuous
  tail sync is working (checkpoint caught up; new rows written).
- The three WA-01 timestamp mismatches are **late source edits** (content and all
  other fields match); the old worker never re-read old rows. New
  `--mode=reconcile` fixes this.
- The **media mirror is partial**: the main DB has metadata (type/filename/SHA/
  length) for every source media message, but 5,405 source media messages have no
  `whatsapp_media` row and only 254 files are stored. Historical import skipped
  media by design. Most missing rows still have a source URL/key; a controlled
  media backfill can copy many, subject to CDN expiry.

### Code changes (branch `feature/phase3-010-011-activation`)

- `scripts/sync-worker.mjs`
  - full `--mode=reconcile` (startup + every `SYNC_RECONCILE_EVERY` rounds; default 60);
  - update predicate now compares all mirrored fields, so late edits/revocations
    are applied;
  - `raw_payload.content_base64` preserves exact bytes when PostgreSQL cannot
    store NUL/lone surrogates;
  - `--mode=media-status --confirm` creates explicit `STORED`/`FAILED`/`SKIPPED`
    rows for every capturable source media message, with
    `SYNC_MEDIA_BACKFILL_LIMIT` (default 200) and permanent-skip handling;
  - checkpoint still advances only after the committed insert/update; failed
    batches do not advance and retry.
- `scripts/verify-message-mirror.mjs` — read-only source↔main field comparison,
  media coverage and checkpoint report; `--strict` / `--strict-media`.
- `tests/standalone/message-mirror.test.mjs` — disposable SQLite + test DB:
  historical import, late-edit reconcile, idempotency, media `SKIPPED`, verifier.

Tested in the disposable DB: import 3/3 per bridge; late edit updated; second
reconcile `written=0`; media status `SKIPPED MEDIA_SOURCE_METADATA_ABSENT`;
verifier `COMPLETE`; failed 70k-text batch did not advance checkpoint and
recovered after correction.

### Remaining approvals / work

1. Rebuild/recreate the **sync** service with the updated worker (production
   image/container change; requires approval).
2. Run `--mode=reconcile` once on production (3 late-edit updates; requires
   approval).
3. Run `--mode=media-status --confirm` in bounded batches (creates 5,405 status
   rows; attempts up to 5,272 files with URL/key; requires approval and storage/
   expiry monitoring).
4. Bridge 2 → Bridge 1 Escort Draft delivery remains a separate blocked
   business/authorization change (WA-02 `admin_jids=[]`, identity-only policy;
   WA-01 draft worker disabled).

---

## 2026-11-08 — Vessel Draft activation deployed; first send awaiting exact approval

**Branch:** `feature/phase3-010-011-activation`
**Source commit:** `b379dd2`
**Image:** `local/al-rifai-platform:phase3-ai-rc-vd-b379dd2`
**Image ID / digest:** `sha256:aec08d34f7f04b1a49495f74ec33ff29f21c7268e6e58e7948c83459ffa5602a`
**Rollback image:** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`
**Backup:** `/var/backups/al-rifai/vessel-activation-20261108T110032Z.dump`
(SHA-256 `c093ec2d…aaee8`, 8.7 MB, 382 TOC entries)
**App:** recreated only; healthy. Sync remains on `phase3-ai-rc-8a6c2c6`.
**Schema:** unchanged `1.6.0`, 49 tables, migrations 002–011.

### Recipient correction

The previous Admin-participant fallback was removed. Delivery now targets the
**same original authorised order-giving conversation**:

- direct Escort Client chat → that exact direct JID/LID;
- approved ORDERS group → that exact group JID;
- source message must be unique; program source chat must match it exactly;
- chat must be in `app_settings.phase3_business_chats:wa-01` and authorised
  `ORDERS`/`BOTH`;
- group sender must be an active approved participant; direct sender must match
  the chat identity;
- missing/ambiguous/mismatched evidence blocks and audits.

The worker re-runs this resolution before every send.

### WA-01 transport

One new WA-01 consumer was added to the existing Bridge policy:

| Item | Value |
|---|---|
| Consumer | `alrifai-wa-01-send` |
| Capabilities | `messages.send`, `native.identity.read` |
| Token | `/etc/vps/apps/al-rifai/auth/wa-01-send.token` (0400, uid 10001) |
| Policy | `/etc/vps/services/whatsapp/wa-01-consumer-policy.json` (0600, uid 10002) |
| Native profile | identity-only entry `epoch:1, chats:[]` |
| App mount | `/var/lib/vps/whatsapp/wa-01/control` → `/wa-01-control` (ro), token → `/etc/alrifai/wa-01-send.token` (ro) |
| App group | supplementary GID 10002 |
| Verified | identity `8801880446111:27@s.whatsapp.net`; `send_message` capability probe returned “Recipient must be provided” without sending |

The secured MCP broker requires the standard lifecycle (`initialize`, then
`notifications/initialized`, then `tools/call`); `lib/standalone/whatsapp.ts` now
does this.

### Live gate and queue

- `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1`
- `app_settings.vessel_draft_outbound_enabled=true`
- `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0` (intentionally disabled until the
  first approved send is verified)
- 9 Owner-approved business conversations; 8 unqueued DRAFTs; 0 delivery rows.
- Host preflight: `mode=OUTBOUND_APPROVED`, no gate reasons, sender verified.

### Duplicate disposition

The five programs from the multi-lighter direct order are five distinct
lighters, not duplicates. `prog_b349…` and `prog_df6a…` are the only duplicate
conflict (same mother/lighter/date/mobile, different shift/source); both were
left out of the queue. Recommended unique candidate:
`prog_412b6c5476ee4992e0db1c6e` (Beltokyo / Nil-Doria, 2026-11-07 D) to the
original ORDERS group `120363426895117693@g.us`.

No message has been sent. The exact candidate and message text are in
`docs/VESSEL_DRAFT_ACTIVATION_APPROVAL_PACKAGE.md`; the first send requires the
Owner's explicit approval of that exact delivery.

---

## 2026-11-08 — Vessel Draft activation wiring + Cash eight-card verification

**Branch:** `feature/phase3-010-011-activation` (new isolated worktree
`/opt/al-rifai-phase3-activation`, from deployed release `03df822`).
**Production:** unchanged — image `phase3-ai-rc-8a6c2c6`, schema `1.6.0`,
migrations 002–011, 49 tables, 0 delivery rows, 0 Paid Events, 0 posting links.
**Status:** implemented, typechecked, linted, built and tested; **not deployed**
and **no message sent**.

Added:

- `lib/standalone/vessel-draft-recipient.ts` — resolves the recipient as the
  **same original authorised order-giving conversation**. It requires the
  source message to be unique, `programs.source_chat_jid` to match it exactly,
  the chat to be in the Owner-approved business allowlist and authorised for
  ORDERS/BOTH, an INCOMING message, and an approved group participant or a
  matching direct-chat sender. Admin JIDs are never a fallback; missing,
  ambiguous or mismatched evidence is audited and never queued.
- `lib/vessel-draft-delivery.ts` — the gate accepts only the Owner-approved
  business conversation list (and an optional exact pin);
  `isApprovedDraftRecipient()` is the single recipient rule.
- `lib/vessel-draft-transport.ts` — `verifyVesselDraftSender()` calls
  `get_native_account_identity` and compares it with the approved sender.
- `lib/vessel-draft-delivery-worker.ts` — re-resolves the source
  conversation and verifies the bridge identity before every `send_message`; a
  mismatch is a bounded `FAILED` with no transport call.
- `lib/standalone/vessel-draft-delivery-store.ts` + `programs.ts` — enqueue
  resolves the recipient instead of requiring a hardcoded JID; runtime config
  loads the WA-01 business conversation allowlist.
- `scripts/standalone/vessel-draft-activation.mjs` — read-only preflight by
  default, optional `--verify-sender`, controlled `--enqueue` / `--tick` behind
  confirmation flags; identities masked.

Verification (disposable `alrifai_v2_test`, schema 1.6.0):

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors, 2 pre-existing warnings |
| `pnpm test:unit` | 149/149 |
| `pnpm test:standalone` | 180/180 |
| `pnpm test:paid-events` | 23/23 |
| `pnpm build` | pass |

Image built locally (not deployed):
`local/al-rifai-platform:phase3-ai-rc-activation-03b1526`, digest
`sha256:d7ae28d210f97edda9d8f05e0ea79e0f2dce82b64f1377d12ef97e222342386f`.
Rollback/production image remains `phase3-ai-rc-8a6c2c6`
(`sha256:8b7ab534…e510`). The exact approval package is
`docs/VESSEL_DRAFT_ACTIVATION_APPROVAL_PACKAGE.md`.

Cash: no code change. Flag OFF keeps POSTED-only totals; flag ON uses verified
Paid Events plus legacy POSTED with no double count. All eight card values come
from the same summary and their links route to `/cash/paid` with server-side
filters; WhatsApp + Office equals the total card. `PHASE3_PAID_EVENTS_ENABLED`
remains OFF.

**Still blocked (Owner approval, not code):**

1. WA-01 consumer policy has no `messages.send`; the app container mounts no
   WA-01 socket/token. A narrow send token, mount and exact sender/recipient are
   required before any real draft can leave.
2. Production deployment of this branch.
3. `PHASE3_PAID_EVENTS_ENABLED=1`.
4. One controlled real send (`--tick --limit=1 --confirm-send`) with the exact
   sender/recipient/message reported first.

---

## 2026-11-08 — Migration 010/011 execution (staged, authorized)

**Branch:** `feature/phase3-010-011-release` (from integration `0b309b2`).
**Final release commit:** `8a6c2c6ae8d082fc15235bd37e126117ad06f8c7`.
**Production migrations:** 010 applied first (47 tables, schema 1.5.0), verified;
then 011 applied (49 tables, schema 1.6.0), verified. Both checksums match.
**Production image:** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`, image ID /
digest `sha256:8b7ab534838f670c9b6486015650711e266dea4d3f8b2ac4df287d5be1c3e510`.
App/sync recreated from that image; app healthy.
**Paid Events:** `PHASE3_PAID_EVENTS_ENABLED` remains OFF/absent; 0 Business
Paid Events, 0 posting links.
**Backup:** fresh `pg_dump -Fc` created and verified before migration
(`phase3-release-010011-20261108T084939Z.dump`, 8.6 MB, SHA-256
`d88b0f0f173732a1ca3cfcb812ed9489aa9d443f4bfc5ed3d3ace0be4c22ae77`, 344 TOC).
**Data:** critical row counts unchanged through migration (employees 218,
programs 102, attendance 439, instructions 3,840, postings 1,586, ledger 1,586,
submissions 117, review 20, messages 34,743 at migration gate).
**Migration 010 implementation:** durable queue + producer hook + default-
disabled worker + narrow WA-01 `send_message` adapter + retry/terminal states +
Admin status. Outbound gate remains OFF; no message sent.
**Router post-deploy:** worker started after verification; 147 messages
processed, 41 Cash REVIEW created, 4 Vessel DRAFT created, 0 Paid Events,
0 postings, 0 outbound sends.

---

## 2026-11-08 — Git completeness audit and migration technical documentation

**Branch:** `feature/phase3-docs-audit` (from integration `0b309b2`).
**Mode:** documentation-only; no source/SQL/runtime change.

Verified:

- Integration contains every router and cash feature commit; no commits are
  missing. All feature tips and integration are pushed and clean.
- Canonical `main` dirty files are preserved but superseded/duplicate/obsolete:
  the old `finance.ts` insert, old invalid 011, duplicate 010, earlier reports
  and a pre-sidebar layout backup contain no unique required work.
- New migration references:
  `docs/MIGRATION_010_VESSEL_DRAFT_DELIVERY.md`,
  `docs/MIGRATION_011_CASH_PAYMENT_EVENTS.md`.
- New Git audit: `docs/PHASE3_GIT_COMPLETENESS_AUDIT.md`.
- Current WA-02 scope (identity-only) is documented separately from the
  unverified Owner-intended Bridge-2 → Bridge-1 order-draft workflow. No
  permission or field rule was invented.
- 010 is a durable queue only; automatic WhatsApp delivery is **NOT IMPLEMENTED**
  (no worker caller, no `send_message` path). Current delivery is
  `MANUAL_COPY_ONLY`.
- 011 adds Business Paid storage; production remains schema `1.5.0`, with no
  Business Paid Events and no activation.

No production migration/deployment/restart/flag change or historical backfill
was performed.

---

## 2026-11-08 — Production release preparation audit (read-only)

**Candidate:** `feature/phase3-integration` @
`0b691a223949e9a413589db9e5f3dcd3366448e3`.
**Status:** production readiness evidence and runbook prepared; **no production
migration, deployment, restart or flag activation was performed.**

Key findings:

- Production still runs image `phase3-ai-rc-7da17f1`
  (`sha256:5f3de875…01fa`), schema `1.5.0`, 46 tables, 8 migrations.
- Production router gate is ON (WA-01 watermark 19634, 9 business chats; WA-02
  zero business chats). Router worker and Vessel processing are ON. Paid Events
  is absent/OFF.
- A verified 8.5 MB pre-deploy backup was restored into an isolated PostgreSQL
  16 copy. Migration 010+011 produced schema `1.6.0`, 49 tables, 10 migrations,
  preserved all restored row counts, repeat migration was a no-op, grants and
  immutable triggers are present, app health returned 200/`1.6.0`, and a
  temporary failing migration rolled back cleanly.
- Isolated HTTP checks: unauthenticated `/cash` redirects to login; Business
  Paid API returns 401 unauthenticated; admin routes 200; staff correction is
  403 `CAPABILITY_REQUIRED`; admin correction without CSRF is 403
  `CSRF_DENIED`; admin correction/reversal succeeds and leaves zero posting/
  ledger rows.
- Historical aggregates: 3,836 cash instructions, zero Business Paid Events,
  2,339 payment-format messages, 1 potential multi-block message, 117 pending
  submissions (72 missing core fields), 39 unregistered employee mobiles and
  1,401 unregistered payouts.
- **Critical deployment order:** apply 010/011 **before** starting the new
  image because `/cash/paid` queries the 011 table even with Paid Events OFF.
- Fresh backup, production migration window, image build/tag approval, router
  pause and Owner sign-off remain outstanding.

Full evidence/runbook:
`docs/PHASE3_PRODUCTION_RELEASE_AUDIT_20261108.md`.

---

## 2026-11-07 — Phase 3 integration + Admin Business Paid API/UI (isolated)

**Branch:** `feature/phase3-integration`
**Base:** `a4aabb6` (cash Paid) + merged router `4e2e3f4`.
**Status:** isolated integration implementation; **not merged to main, not
deployed, not migrated in production.** `PHASE3_PAID_EVENTS_ENABLED` remains OFF.

Delivered:

- Merged router/vessel/release work with cash/Paid work; preserved cutover
  watermark, business-chat allowlists, WA-01/WA-02 restrictions, Vessel draft
  and release evidence.
- Resolved the six known conflict files. `app/(workspace)/cash/page.tsx` keeps
  the cash dashboard/CashPaymentForm and the router `canSubmit`, `canPost`,
  `canLedger`, `canDecide` gates.
- Fresh install and migration chain include 010 + 011; schema `1.6.0`, 49 tables.
- `GET /api/finance?resource=business-paid` list with date/employee/source/search
  filters and pagination.
- `GET /api/finance?resource=business-paid-event&id=...` detail with root
  PAYMENT chain, employee, WhatsApp/Office evidence, instruction/posting link,
  correction/reversal history and audit.
- `/cash/paid` list and `/cash/paid/[id]` detail, plus nav link.
- `business-paid.correct` / `business-paid.reverse` API actions reusing existing
  ADMIN + `cash.review` server functions, CSRF path and append-only design.
- Dashboard summary and Business Paid views use the business basis when the flag
  is on; `/cash/transactions` is explicitly labelled Financial POSTED and links
  to the Business Paid view.
- Fixed `event_id` propagation in the business paid list so detail links work.

Evidence (isolated PostgreSQL 16 only):

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors |
| Unit | 147/147 |
| Integration | 163/163 |
| Build | pass; `/cash/paid` and `/cash/paid/[id]` emitted |
| Fresh install | schema 1.6.0, 49 tables, 10 ledger rows |
| Incremental 1.5.0 → 1.6.0 | 010 then 011; repeat no-op |
| Runtime grants | vessel READ_WRITE; Paid tables append-only |
| Production | unchanged |

Known limitations: no automatic retroactive Business Paid backfill, no historical
multi-block recovery for messages already linked, and old pending Office
candidates may need correction before strict approval.

---

## 2026-11-07 — Phase 3 Cash Business Paid implementation (isolated)

**Branch:** `feature/phase3-cash-paid-events` (worktree
`/opt/al-rifai-phase3-cash`), based on `13d660c`.
**Status:** implementation, tests, migrations and documentation complete in
isolation. **Not merged, not deployed, not applied to production.** Feature flag
`PHASE3_PAID_EVENTS_ENABLED` is OFF by default.

Delivered:

- WhatsApp automatic Business Paid without Office approval, at the verified
  Admin→Accountant routing point; no automatic `postInstruction()`, no
  `cash_postings`, no `ledger_entries`.
- Final single-mobile rule: one number is both `employee_mobile` and
  `payout_mobile`; two numbers keep ID + payout; 3+ are ambiguous.
- All clean payment blocks in one message are processed, not only the first.
- Parser regression coverage for hyphenated numbers, `(C)/(R)/BANK`, `Tk:`,
  next-line amounts, `{B)`, `---`, `500-` and missing methods. A method is never
  fabricated as `cash`.
- Office approval creates exactly one `OFFICE` event when the flag is on;
  pending/rejected submissions create none.
- Migration 011 repaired to valid PostgreSQL; append-only PAYMENT / CORRECTION /
  REVERSAL design; separate posting-link table; `1.6.0`.
- Migration 010 recovered byte-for-byte from `3e0dd01` and added to the fresh
  installer/grants. It remains inert; no sender or worker was activated.

Evidence (isolated PostgreSQL 16 container; production untouched):

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors, 2 pre-existing warnings |
| Unit | 117/117 |
| Integration | 144/144 |
| Build | pass |
| Fresh install | schema 1.6.0, 49 tables, 10 ledger rows |
| Incremental 1.5.0 → 1.6.0 | 010 then 011; repeat no-op |
| Failed migration probe | exit 1; probe table and ledger row rolled back |
| 010 SHA-256 | `fa299768…17e7c7` |
| 011 SHA-256 | `4203fdbe…964165` |

Canonical `/opt/al-rifai-platform` remains on `main` with its pre-existing dirty
files preserved, including
`app/(workspace)/layout.tsx.backup-20261107-192036`.

Next authorized steps (require separate approval): review/merge the branch,
back up production, rehearse 010/011 on a production copy, apply migrations,
deploy with the flag OFF, verify parity, then enable the flag. Rollback is
setting the flag to `0`.

---

## Earlier session state (2026-11-07)

| Item | Value |
|---|---|
| **Production runtime (DEPLOYED)** | `local/al-rifai-platform:phase3-ai-rc-7da17f1`, digest `sha256:5f3de875…01fa` |
| Rollback image (available) | `local/al-rifai-platform:phase3-ai-rc-86d659a`, digest `sha256:932ef856…a5` |
| Superseded candidate | `phase3-ai-rc-9e85e49`, digest `sha256:cb8de252…` |
| Verification image (built, **NOT deployed**) | `phase3-ai-rc-675a3ef` — post-deployment workflow fixes |
| `.env` `ALRIFAI_TAG` | **aligned to `phase3-ai-rc-7da17f1`** with Owner approval; backup `/var/lib/vps/al-rifai/backups/al-rifai.env.pre-tag-align-20261107T144038Z` preserves previous `86d659a` |
| Git `main` | `0861e05` (clean; does **not** contain the code fixes) |
| Working tree / branch | `/opt/al-rifai-phase3-test`, `feature/phase3-router-cash-vessel`, pushed, clean |
| Database schema | `1.5.0`; **NO MIGRATION APPLIED to production**; additive `010_vessel_draft_delivery.sql` written, clone-tested, **pending Owner approval** |
| Compose project | `al-rifai-phase3`; a bare `docker compose up -d` now keeps `7da17f1` |
| Clone | `alrifai-ui-check` on `127.0.0.1:3007`, DB `alrifai_v2_import_test` |

## What changed this session

1. **Task 1 — `.env` tag alignment (Owner-approved).** Read-only verification
   confirmed running containers on `7da17f1` while `.env` recorded `86d659a`,
   and that a bare Compose command would have reverted to the rollback image.
   After explicit approval, **only line 61** was changed to
   `ALRIFAI_TAG=phase3-ai-rc-7da17f1`. Backup created; `root:root 600` and file
   size preserved; raw `diff` shows exactly one line; `docker compose config`
   now resolves both services to `7da17f1`; running container IDs/uptime
   unchanged (no restart/recreate); health still OK.
   Docs: `docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`, commit `00e25a7`.
2. **Task 2 — authentication root cause (NO defect) + OWNER CONFIRMATION.**
   Traced the full pipeline. The earlier `400 CREDENTIALS_REQUIRED` came from
   requests with an **empty password**: `lib/unified-auth.ts:118` fires before
   user lookup/verification. The 0-byte bootstrap files are read **only** by
   provisioning CLIs, never by login. All three accounts have valid PBKDF2
   hashes (118 chars, correct format), unchanged roles/capabilities (ADMIN 30,
   USER 10/10), **8 successful `LOGIN` events + 4 live sessions**.
   **The Owner explicitly confirms `Admin`, `officeassistant` and
   `officeazzistant2` all log in with their current passwords — authentication
   is operational, no reset/replacement/provisioning/hash/role change needed.**
   Status distinction: **OWNER-CONFIRMED login** vs **AGENT-VERIFIED
   authenticated UI (pending)**. 15 saved cookie jars remain clone-only (zero
   production match). **No credential was changed.**
   Docs: `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`.
3. **Task 1 — authenticated UI still NOT TESTED (Agent).** The Owner selected
   the **root-only session cookie jar** as the minimum secure access
   (`/etc/vps/apps/al-rifai/verification-session.cookies`, `root:root`, `400`);
   **it does not exist yet**, so no automated verification is claimed. Added
   `scripts/owner-assisted-ui-verify.sh` — a read-only, `bash -n`-clean,
   no-secret-output Owner-assisted procedure (27 routes × 2 hosts, nested URLs,
   7 CSV exports, search/filters/pagination, role control counts). A full
   VERIFIED/PARTIAL/FAILED/NOT TESTED matrix with 41 read-only route checks on
   both hosts is in `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`. No 500s; all
   protected routes 401/307. Never ask for passwords in chat/Git/docs.
4. **Task 4 — durable Vessel Draft delivery infrastructure (implemented, NOT
   deployed, NOT enabled).**
   - Migration `db/standalone/010_vessel_draft_delivery.sql`: one new table
     `vessel_draft_deliveries` + 4 indexes, `CHECK account_id='wa-01'`,
     UNIQUE `(program_id, content_hash, recipient_jid)`. **Not applied to
     production.**
   - `lib/standalone/vessel-draft-delivery-store.ts`: Postgres store,
     `FOR UPDATE SKIP LOCKED` claiming, bounded retry with backoff,
     terminal `SENT`/`DELIVERY_UNKNOWN`/`DEAD`, worker-restart lease recovery,
     audit trail via existing `audit_events`, Admin status projection,
     five-block `runtimeDeliveryGate()`, prepared-but-never-executed request.
   - `/vessel/drafts` shows delivery mode, gate reasons, records and
     `CONFIRMATION_RULE`; degrades gracefully when the table is absent.
   - Migration tested on a disposable clone restored from the pre-deploy backup
     (46→47 tables, schema stays `1.5.0`, ledger `010`, all columns/indexes,
     legacy counts unchanged), rollback simulated (47→46), re-appliable.
   - Tooling: `install.mjs`, `grants.mjs`, CI table count 46→47, three test
     reset helpers updated to truncate the new table.
   - Integration tests: 8 store tests; Admin UI verified on a local dev server
     against the clone both with the table absent and with a synthetic QUEUED
     record; clone fixtures removed and the table dropped again.
   - **No `messages.send` capability, no outbound message, no `AI_*` change.**
     `MANUAL_COPY_ONLY` retained. `applyConfirmation()` untouched.
5. Docs, Git commits and pushes after each logically complete change.

## README / Git reconciliation (this session, docs only)

- **Verified facts:** running image `phase3-ai-rc-7da17f1` (digest
  `sha256:5f3de875…`), DB `alrifai_v2_phase3`, schema `1.5.0`,
  `schema_migrations` **002–009** applied (no `010`), 46 tables, router flags
  `PHASE3_ROUTER_WORKER_ENABLED=1` / `ALRIFAI_VESSEL_PROCESSING_ENABLED=1` /
  `ALRIFAI_LIVE_CASH_SYNC=0`, all `AI_*` flags `0`, `.env` tag aligned.
- **Found** both `main` and feature READMEs still opened with a
  `v1.4.0-phase3-rc2` / schema 1.4.0 / `phase3-rc-final5` "Current Release"
  block, plus stale schema/routing/AI/installer/test-count/deployment claims.
  `main` additionally claimed runtime image `86d659a` and pending `9e85e49`.
- **Corrected feature-branch README**: added a `Release status` table with the
  four required categories (Current Production / Historical Release / Built but
  Not Deployed / Pending Migration & Activation); preserved all historical tags,
  rollback instructions and cutover history in a clearly-labelled
  "Historical Release" section; corrected schema 1.4.0→1.5.0, migrations
  002–008→002–009, feature-flags-OFF→production overrides, "AI not
  deployed"→migration 009 applied with AI flags off, installer counts, test
  counts (83/112→133/133), stale cutover-era validation claims, and the
  auth/provisioning paragraph. Marked the active goal **BLOCKED** with the
  specific Owner action.
- **Git divergence (read-only):** `main` `0861e05`, merge base `76d5d00`;
  feature head advances with documentation commits (see `git log`). **22
  main-only** commits and a feature-only count that grows with each docs commit
  (re-run `git rev-list --left-right --count main...HEAD` for the current value).
  Criss-cross docs merges. **No force-push, reset, rebase or auto-merge
  performed.**
- **Merge plan:** `docs/MAIN_RECONCILIATION_PLAN.md` — GitHub PR (recommended)
  or a `--no-ff` local merge after Owner approval, taking feature-branch
  versions for documentation conflicts while keeping all 22 main-only commits.
  `main` README remains stale until that approved merge.
- **No production deployment, migration, credential, WhatsApp or DNS change.**

## Test evidence

- Unit **133/133**, integration **133/133**, focused store integration **8/8**,
  focused Task-3 re-run **31/31**, `tsc --noEmit` clean, lint 0 errors.
- Migration 010 checksum `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`;
  applied/rolled back/re-appliable on a disposable production-schema clone.
- **Compatibility verified:** current branch code runs unmodified against the
  deployed 46-table schema — `deliveryTableAvailable()=false`, gate fully
  disabled (`MANUAL_COPY_ONLY`, 5 reasons), `deliveryStatusForPrograms()` returns
  0 rows. `7da17f1` does not contain the delivery module (added later).
- No production image was built or deployed this session.

## Production safety evidence

- Production containers unchanged: `db7e0d888f28` / `e5fe4214d625`, image `7da17f1`.
- `/api/health` on both hosts → `ok` / DB `ok` / schema `1.5.0`.
- Business counts unchanged (218 / 102 / 439 / 3,817 / 1,586 / 13 review items);
  0 outbound AI rows; 0 non-legacy postings.
- Bridge containers, sessions, checkpoints, cutover watermarks, allowlists,
  processing state and DNS untouched. `al-rifai.iamazim.com` still 1014.
- No credential reset, no hash/role/capability change, no secret printed or
  committed, no production migration, no WhatsApp message sent.

## Issue priority order

1. **ACTIVE GOAL — Authenticated Production UI Verification: BLOCKED.**
   Login is OWNER-CONFIRMED for all 3 accounts, but AGENT-VERIFIED UI is NOT
   TESTED. **Specific Owner action:** write one valid `__Host-alrifai_cash`
   cookie into root-only `/etc/vps/apps/al-rifai/verification-session.cookies`
   (`root:root`, `400`), or run `scripts/owner-assisted-ui-verify.sh` and share
   only its non-secret output. Then complete
   `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` with GET-only checks.
   **Do not mark COMPLETE on a README correction or a merge.**
2. Owner approves the 8 outbound activation items in
   `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §7 (including migration 010, exact
   sender/recipient/scope/template/trigger/retry/live+rollback plan).
3. Decide whether to build/deploy a candidate containing the feature-branch
   code (fresh backup required; rollback `7da17f1`; compatible with 46-table
   schema).
4. Owner approves the `main` reconciliation in
   `docs/MAIN_RECONCILIATION_PLAN.md` (PR or `--no-ff` merge); `main` README is
   still stale until then. Do not auto-merge / force-push / reset.
5. Manual review of the 7 historical `RELEASE_UNSTRUCTURED` items.
6. Vessel release ↔ attendance linkage; program pay / payroll unresolved cases.
7. Legacy Cashbook/archive, reconciliation and site settlements mapping.
8. Cloudflare 1014 (Owner DNS decision).
9. Low-priority legacy UI parity (typeahead, charts).

## Database migration ledger

- Production `schema_meta` `1.5.0`, `schema_migrations` max version `009`.
- **NO MIGRATION APPLIED** this session.
- Pending `010_vessel_draft_delivery.sql` (additive, clone-tested, rollback
  simulated, needs 8 Owner approvals before application).

## Git / push status

- `main` `0861e05` clean, not merged; README **still stale** until the approved
  reconciliation in `docs/MAIN_RECONCILIATION_PLAN.md`.
- `feature/phase3-router-cash-vessel` pushed and clean; README corrected this
  session. Merge base `76d5d00`; 22 main-only commits and a feature-only
  count that advances with documentation commits (see `git rev-list
  --left-right --count main...HEAD`).
- No force-push, no reset, no rebase, no auto-merge, no production image built.

## Exact next task and starting files

1. **ACTIVE GOAL (BLOCKED) — Authenticated Production UI Verification.** Owner
   writes the root-only session cookie jar
   `/etc/vps/apps/al-rifai/verification-session.cookies` (`root:root`, `400`)
   with one valid production session, or runs
   `scripts/owner-assisted-ui-verify.sh` themselves and shares only its
   non-secret output. Agent then re-runs
   `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` with authenticated GET-only
   requests and deletes the artifacts. Login is OWNER-CONFIRMED; never reset.
   **This goal is not COMPLETE; do not close it on a README fix or a merge.**
2. Owner reviews `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §5 (exact draft example),
   §6 (single-message verification procedure) and §7 (8 approvals).
3. If a further release is approved: fresh backup, build/deploy the current
   branch content, rollback `7da17f1`.
4. Starting files for delivery work: `lib/standalone/vessel-draft-delivery-store.ts`,
   `db/standalone/010_vessel_draft_delivery.sql`,
   `app/(workspace)/vessel/drafts/page.tsx`, `lib/vessel-draft-delivery.ts`.
5. Historical items: `docs/HISTORICAL_RELEASE_REVIEW_20261107.md`, `/review`.
6. Backlog: `docs/BUSINESS_WORKFLOW_BACKLOG.md`.
