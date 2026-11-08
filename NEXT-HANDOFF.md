# NEXT-HANDOFF

**Session ended:** 2026-11-07
**ACTIVE GOAL (unchanged): Authenticated Production UI Verification — status
BLOCKED, not complete.** A README or source change does not complete it.
**Read first:** `AGENTS.md`, `docs/PROJECT_KNOWLEDGE.md`,
`docs/VESSEL_ORDER_DRAFT.md`, `docs/LEGACY_PHASE3_COMPARISON.md`,
`docs/PRODUCTION_URLS.md`, `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`,
`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`, `docs/MAIN_RECONCILIATION_PLAN.md`,
`docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`,
`docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`, `docs/BUSINESS_WORKFLOW_BACKLOG.md`,
`docs/PHASE3_GO_NO_GO_7da17f1.md`.

**Report language:** English only. Always state whether a finding is
**implemented**, **clone-tested**, **production-deployed**, **live-verified**,
**OWNER-CONFIRMED** or **BLOCKED**.

---

## 2026-11-08 — Migration 010/011 execution (staged, authorized)

**Branch:** `feature/phase3-010-011-release` (from integration `0b309b2`).
**Production migrations:** 010 applied first (47 tables, schema 1.5.0), verified;
then 011 applied (49 tables, schema 1.6.0), verified. Both checksums match.
**Paid Events:** `PHASE3_PAID_EVENTS_ENABLED` remains OFF; 0 Business Paid
Events, 0 posting links.
**Backup:** fresh `pg_dump -Fc` created and verified before migration
(`phase3-release-010011-20261108T084939Z.dump`, SHA-256
`d88b0f0f173732a1ca3cfcb812ed9489aa9d443f4bfc5ed3d3ace0be4c22ae77`).
**Data:** critical row counts unchanged (employees 218, programs 102,
attendance 439, instructions 3,840, postings 1,586, ledger 1,586, submissions
117, review 20, messages 34,743).
**Migration 010 implementation:** durable queue + producer hook + default-
disabled worker + narrow WA-01 `send_message` adapter + retry/terminal states +
Admin status. Outbound gate remains OFF; no message sent.

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
