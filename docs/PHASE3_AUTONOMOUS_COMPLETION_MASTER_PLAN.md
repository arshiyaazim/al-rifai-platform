# AL-RIFA'I Standalone Platform — Phase 3 Autonomous Completion Master Plan

**Author:** autonomous engineering session, 2026-11-06
**Status:** IN PROGRESS — development authorized; production deployment expressly not authorized
**Canonical repository:** `/opt/al-rifai-platform` (GitHub `arshiyaazim/al-rifai-platform`)
**Development worktree:** `/opt/al-rifai-phase3-test` on `feature/phase3-router-cash-vessel`
**Production database:** `alrifai_v2` (PostgreSQL 16, schema `public`, currently `1.2.0`)
**Isolated test database:** `alrifai_v2_test` (PostgreSQL 16, schema `public`, currently `1.3.3`)
**Production application:** `local/al-rifai-platform:20261105-phase2`, HTTPS `https://app.al-rifai.iamazim.com`

---

## 1. Mission and hard safety boundaries

Complete the standalone Phase 3 application to a tested, documented production
release candidate. This plan is independent of the legacy application and does
not inherit the legacy Cash Freeze policy. The new platform must support the
full, role-authorized Cash lifecycle: instruction, review, approval, posting,
reversal, reconciliation and audit history.

Hard boundaries observed by this plan:

1. No changes to `/opt/vps`, the legacy `alrifai` database, the legacy running
   containers, the WhatsApp bridge stores, or production `alrifai_v2`.
2. No production migration, image build, deployment, restart or live activation
   without explicit Owner approval.
3. No real financial posting. All financial testing happens only in the
   isolated `alrifai_v2_test` database with synthetic fixtures.
4. No secrets, `.env` values, media keys, bridge session material or private
   evidence are committed, logged or copied into documentation.
5. No destructive Git operation (`reset --hard`, force-push) and no automatic
   merge to `main` without an explicit release decision.
6. Feature work is committed on `feature/phase3-router-cash-vessel`; production
   action remains a separate, gated event.

---

## 2. Verified environment baseline (evidence, not inference)

| Item | Verified state | Evidence |
|---|---|---|
| Git worktrees | `/opt/al-rifai-platform` = `main` at `e6becfc`; `/opt/al-rifai-phase3-test` = `feature/phase3-router-cash-vessel` at `79683d8` | `git worktree list`, `git rev-parse` |
| Feature branch distance | 22 commits ahead of `main`; remote feature branch at `79683d8` | `git log main..HEAD`, `git rev-parse origin/...` |
| Running app | `al-rifai-v2-app-1` healthy; `local/al-rifai-platform:20261105-phase2`; HTTPS health 200, schema `1.2.0` | `docker ps`, `curl /api/health` |
| Running sync | `al-rifai-v2-sync-1` up; both bridge stores mounted read-only | `docker ps`, `compose.yaml` |
| Production DB | `alrifai_v2` at `1.2.0`; 34,376 raw WhatsApp messages; 0 programs, 0 instructions, 0 postings, 0 employees; 3 users | SQL over `vps-infra-postgres-1` |
| Isolated test DB | `alrifai_v2_test` at `1.3.3`; 32 tables; runtime role grants present | SQL over `vps-infra-postgres-1` |
| Test database access | Host reaches PostgreSQL at `172.18.0.2:5432` on the Docker network; Node 22.23.4 + pnpm 11.25.0 installed locally for verification | direct connection + test run |
| Baseline unit tests | 67/67 pass | `node --test` on six unit files |
| Baseline router tests | 49/49 pass | `message-router.test.mjs` |
| Baseline cutover tests | 18/18 pass | `router-cutover.test.mjs` |
| Baseline review API | 7/7 pass | `review-api.test.mjs` |
| Baseline domain tests | 9/9 pass | `domain.test.ts` |
| Baseline WhatsApp adapter test | **0/1 fail** — `42P10` ON CONFLICT target does not match `whatsapp_messages_source_key` | `whatsapp.test.ts` |
| Baseline typecheck | **FAIL** — 3 TS18048 errors in `lib/standalone/whatsapp.ts` (`block` possibly undefined) | `pnpm typecheck` |
| Lint | 0 errors, 7 warnings | `pnpm lint` |
| Dependency audit | 8 production advisories: 2 critical, 2 high, 2 moderate, 2 low — `next 16.3.8` (critical RCEs, fixed ≥16.4.1), `zod <4.6.6` (high), `fast-uri <3.1.9` | `pnpm audit --prod` |
| CI workflow | Present but never executed (GitHub billing lock); migration job uses `install --force`, which currently re-runs the non-idempotent baseline and is expected to fail | `.github/workflows/ci.yml`, installer source |

**Important test-method finding:** the DB suites share one schema and reset
fixtures. Running `message-router`, `router-cutover` and `review-api`
concurrently produces false failures. The authoritative execution mode is
`--test-concurrency=1`, one file at a time (or a single ordered process).

---

## 3. Audit coverage and method

Read-only inspection of:

- all App Router pages and API routes;
- every `lib/standalone/*` domain service;
- the full baseline schema and migrations 002–007;
- authentication/session/capability code (`unified-auth*`, `proxy.ts`);
- the installer, reset CLI, WhatsApp sync worker and Docker/TLS entry;
- CI, deployment and rollback documents;
- the isolated test database and the running production surface.

Every gap below is tied to a concrete file, route, table or test result.
Claims from previous sessions were re-run where the environment allowed; the
two failing baseline checks above are newly verified.

---

## 4. Gap register

### P0 — blocks a production-grade release

| # | Gap | Evidence | Consequence | Planned fix |
|---|---|---|---|---|
| P0-1 | Typecheck fails | `pnpm typecheck`: 3 × `TS18048` in `lib/standalone/whatsapp.ts:342,348,349` | CI and image build cannot be trusted; release cannot be cut | Narrow `block` after the `find()` and use the narrowed value |
| P0-2 | WhatsApp adapter test fails | `whatsapp.test.ts` → `42P10` at `syncAccount()` insert | The optional MCP sync path cannot store a message on the current schema | Use the actual 3-column conflict target `(account_id, chat_jid, message_id)` |
| P0-3 | No incremental migration path | `scripts/database.mjs` is absent; `db:migrate` is declared but not implemented; `install --force` re-runs non-idempotent `schema.sql`; production is `1.2.0`, branch expects `1.3.3` | Phase 3 cannot be deployed safely; production stays on Phase 2 | Add idempotent `scripts/standalone/migrate.mjs`, fix `--force` to mean "additive extras + grants", test both fresh install and existing-schema upgrade |
| P0-4 | Critical dependency vulnerabilities | `pnpm audit --prod`: Next.js RCE advisories on `16.3.8`; patched `>=16.4.1` | Public app exposes known unauthenticated RCE surface | Upgrade Next.js/eslint-config-next to a patched 16.4.x, re-run build/tests/lint/audit |
| P0-5 | Cash review approval does not create a payable instruction | `decideCashSubmission()` only flips state to `APPROVED`; `cash_submissions` has no `instruction_id`; UI/API has no conversion | Approved Cash candidates are a dead end; the Cash lifecycle is incomplete | Add `instruction_id` and atomically create a `REVIEW` instruction on approval; preserve separation of review/approval/posting |
| P0-6 | No reversal | `cash_instructions.state` includes `VOID` but no service, route, table or UI writes it; `cash_postings`/`ledger_entries` are immutable | A posted payment cannot be corrected without mutating immutable financial data | Add `cash_reversals`, contra ledger entry, `reversePosting()`, API action, UI and tests |
| P0-7 | No reconciliation | No reconciliation table, service, route or UI | Cash cannot be reconciled against a counted balance; financial close is not auditable | Add `cash_reconciliations`, create/close services, API and UI |
| P0-8 | Capability model excludes posting and is not enforced | `unified-auth-policy.ts` says `cash.post` is "intentionally absent"; `CAPABILITIES` has no post/reverse/reconcile; API routes check only `actor.role` or nothing; `ledger.create` and `account.create` are callable by any authenticated USER | Role authorization is inconsistent; a USER can write a manual ledger debit or create an account; posting is not expressed as a capability | Add explicit capabilities, return them from `actorFor`, enforce server-side on every financial/administrative action, add tests |
| P0-9 | Audit writes are not atomic with business transactions | `recordAudit()` always uses the shared pool; called inside `tx()` in finance/programs/review/employees/attendance | A rollback can leave a false audit row, or an audit failure can occur outside the business transaction | Allow `recordAudit(input, client)` and pass the transaction client at every in-transaction call |
| P0-10 | Review decision applies domain writes in a nested transaction | `decideReview()` runs `tx()`, then `applyItem()` calls `createEmployee`/`createProgram`/`recordAttendance`, each opening another `tx()` on a different connection | Review state and applied business row are not atomic; deadlock/partial-apply risk | Extract client-aware domain writers and apply them on the review transaction's client |

### P1 — required for a complete, coherent product

| # | Gap | Evidence | Planned fix |
|---|---|---|---|
| P1-1 | Cash submission decision UI absent | `cash/page.tsx` lists submissions but offers no approve/reject controls; `/review` can decide them only indirectly | Add admin decision controls and show the resulting instruction |
| P1-2 | No Cash instruction detail / audit history page | Cash table has no link to a per-instruction view; audit is only a global latest-100 list | Add `/cash/[id]` showing instruction, posting, reversal, ledger and audit trail |
| P1-3 | Vessel/employee/attendance writes bypass capability scope | `/api/programs`, `/api/employees`, `/api/attendance` write directly for any authenticated user, although USER capabilities are described as "submit only" | Enforce `vessel.command`/`employee.manage`/`attendance.manage` for direct writes; route USER writes through `submitForReview` where the capability model promises staging |
| P1-4 | Report export permissions are uniform | `/api/reports` exports audit and cash to any authenticated user | Require `audit.read` for audit export and `cash.read` for cash/ledger exports |
| P1-5 | WhatsApp admin actions are partially guarded | `/api/whatsapp` requires ADMIN for POST but has no capability check; GET has none | Enforce `whatsapp.manage`/`whatsapp.route` and `whatsapp.read` |
| P1-6 | No user administration | Only installer seeds one admin; reset CLI resets a password; no API/UI to create users, change role or deactivate | Add a minimal Super-Admin user administration service/API/UI with lockout protection |
| P1-7 | Reconciliation/accounting reports are thin | `reports` exports raw rows only; no cash position, trial/ledger summary per account or date range | Add cash position and ledger summary exports/views |
| P1-8 | CI does not cover the full branch | CI misses `router-cutover.test.mjs`, `review-api.test.mjs` in the canonical suite, and migration job is invalid | Extend scripts/jobs; validate schema version `1.4.0` after this plan |
| P1-9 | `test:standalone` omits router/cutover/review suites | `package.json` only lists domain + whatsapp | Single canonical `test` command runs every suite sequentially |

### Resolution status after implementation

| Gap | Status | Evidence |
|---|---|---|
| P0-1 typecheck | Fixed | `pnpm typecheck` 0 errors |
| P0-2 WhatsApp adapter | Fixed | `whatsapp.test.ts` passes |
| P0-3 migration path | Fixed | `migrate.mjs`, fresh install + repeat run on disposable DB |
| P0-4 dependencies | Fixed | `pnpm audit --prod` clean |
| P0-5 candidate→instruction | Fixed | `decideCashSubmission()` + lifecycle test |
| P0-6 reversal | Fixed | `reversePosting()` + contra ledger + test |
| P0-7 reconciliation | Fixed | create/close services + UI + test |
| P0-8 capability enforcement | Fixed | capability matrix + route/service checks + negative tests |
| P0-9 audit atomicity | Fixed | `recordAudit(input, client)` used in every transaction |
| P0-10 review apply atomicity | Fixed | client-aware domain writers used by `decideReview()` |
| P1-1 submission UI | Fixed | approve/reject controls on `/cash` |
| P1-2 instruction detail | Fixed | `/cash/[id]` with ledger + audit |
| P1-3 staged USER writes | Fixed for employees/attendance/vessel creation | route-level `submitForReview` |
| P1-4 report permissions | Fixed | type-specific capability checks |
| P1-5 WhatsApp capability | Fixed | `whatsapp.read/manage/route` |
| P1-6 user administration | Fixed | Super Admin `/api/users` + Settings panel |
| P1-8/P1-9 CI coverage | Fixed | canonical `test:standalone`, cash job, 1.4.0 migration validation |
| P1-7 richer reports | Remaining P2 | CSV exports exist; cash-position summary is optional follow-up |
| P2 docs | In progress | README, developer map, release/rollback docs |

### P2 — quality, documentation and operational hardening

| # | Gap | Planned fix |
|---|---|---|
| P2-1 | Legacy modules still present in the tree (`cash-*.ts`, `vessel-*.ts`, `candidates/`) and can confuse maintainers | Document as legacy-reference only; do not delete without Owner approval; ensure runtime imports are guarded |
| P2-2 | `docs/` lacks the Master Plan and a current handoff | This document plus progress/handoff sections |
| P2-3 | `DEVELOPER_START_HERE.md` still describes `1.3.3` and "production blocked" | Update in the same commits to the verified `1.4.0` state |
| P2-4 | `PHASE3_VPS_RELEASE_CHECKLIST.md` predates the new lifecycle | Rewrite with the tested migration, backup, verification and rollback path |
| P2-5 | No retention policy for media / audit | Document operating policy; do not delete data |
| P2-6 | English-only UI, single currency | Document as installation scope, not a defect |
| P2-7 | No graphical browser validation in this environment | Use authenticated HTTP + DB assertions, record the limitation |

---

## 5. Implementation plan (ordered, each step independently verifiable)

### Phase A — Restore a trustworthy baseline

1. Fix `lib/standalone/whatsapp.ts` type narrowing.
2. Fix the `syncAccount()` conflict target.
3. Re-run typecheck, lint, all unit tests and all five DB suites sequentially.
4. Record exact results before changing behaviour.

### Phase B — Cash lifecycle completion

1. Add migration `008_phase3_cash_lifecycle.sql`:
   - `cash_submissions.instruction_id`, decision metadata;
   - `cash_reversals` (immutable, one per posting, ledger link);
   - `cash_reconciliations` (expected/counted/variance, OPEN/CLOSED);
   - `cash_instructions.reversed_at/by`, `reversal_reason`;
   - extend `ledger_entries.source` to allow `REVERSAL` and `RECONCILIATION`;
   - schema version `1.4.0`.
2. Refactor `createInstruction` into a client-aware insert; use it from
   `decideCashSubmission(APPROVED)` so approval atomically produces a `REVIEW`
   instruction linked by `instruction_id`.
3. Add `reversePosting()`: POSTED → VOID, immutable reversal row, contra ledger
   credit, audit; refuse double reversal and non-POSTED instructions.
4. Add `createReconciliation()` / `closeReconciliation()`:
   expected balance from opening + ledger; counted balance; variance; state;
   close requires a note when variance is non-zero; no automatic adjustment.
5. Add API actions, page controls and `/cash/[id]` audit detail.
6. Add `tests/standalone/cash-lifecycle.test.mjs` covering every transition,
   idempotency, forbidden role, double reversal, reconciliation variance and
   audit rows.

### Phase C — Authorization and audit integrity

1. Extend `CAPABILITIES` with `cash.post`, `cash.reverse`, `cash.reconcile`,
   `cash.ledger`, `cash.account.manage`, `payroll.manage`, `employee.manage`,
   `attendance.manage`, `vessel.release`, `review.decide`, `whatsapp.manage`,
   `whatsapp.route`, `whatsapp.read`, `payroll.read`.
2. Give ADMIN the operational set; keep USER read/submit only.
3. Return resolved capabilities from `actorFor` and `pageUser`.
4. Add `lib/standalone/authz.ts` with `assertCapability()`.
5. Enforce capabilities in every route listed in P0-8/P1-1…P1-5.
6. Route USER direct writes through `submitForReview` where the model says
   "submit"; keep ADMIN direct writes.
7. Make audit writes transaction-aware; pass the client in every `tx()`.
8. Make `decideReview` apply domain writes on the same client.
9. Add negative tests for USER posting, reversal, ledger, account, payroll and
   vessel command.

### Phase D — Migration, installer and CI

1. Add `scripts/standalone/migrate.mjs` with checksum tracking.
2. Make `install --force` skip the baseline and apply only additive layers +
   grants.
3. Add `008` to installer file list and `TARGET_TABLES`.
4. Add runtime grants for new tables/columns.
5. Add `db:migrate` script and test it against `alrifai_v2_test`.
6. Update CI: canonical test command, cash lifecycle job, migration validation
   at `1.4.0`, no invalid `--force` assumption.
7. Run the exact CI commands locally.

### Phase E — Product polish and documentation

1. User administration (Super Admin): list/create/update role/active/reset.
2. Cash position / ledger summary report.
3. Update `README.md`, `DEVELOPER_START_HERE.md`, release checklist and
   rollback procedure.
4. Add progress log and handoff to this Master Plan.
5. Final full test/build/audit run.

### Phase F — Release candidate

1. Commit in small, reviewable units on the feature branch.
2. Push the feature branch.
3. Produce a release evidence bundle (commit SHA, test output, image build,
   schema version, dependency audit).
4. Recommend a PR and main merge; do not merge without Owner approval.
5. Recommend production migration/deployment only after a fresh verified backup
   and explicit Owner approval.

---

## 6. Test matrix

| Layer | Command / suite | Database | Required result |
|---|---|---|---|
| Types | `pnpm typecheck` | none | 0 errors |
| Lint | `pnpm lint` | none | 0 errors |
| Unit | `pnpm test:unit` | none | all pass |
| Domain | `tests/standalone/domain.test.ts` | test DB | all pass |
| WhatsApp adapter | `tests/standalone/whatsapp.test.ts` | test DB | all pass |
| Router | `tests/standalone/message-router.test.mjs` | test DB | 49/49 |
| Cutover | `tests/standalone/router-cutover.test.mjs` | test DB | 18/18 |
| Review API | `tests/standalone/review-api.test.mjs` | test DB | 7/7 |
| Cash lifecycle (new) | `tests/standalone/cash-lifecycle.test.mjs` | test DB | all pass |
| Migration | `pnpm db:migrate` twice | test DB | idempotent; `1.4.0` |
| Fresh install | `install.mjs` on empty schema | disposable | 36 tables, `1.4.0` |
| Existing upgrade | `install --force` / `db:migrate` on `1.2.0` copy | disposable | additive; no data loss |
| Build | `pnpm build` | none | success |
| Docker | `docker build` | none | success |
| Audit | `pnpm audit --prod` | none | no critical/high |
| Runtime smoke | authenticated HTTP + `/api/health` | test instance | 200, schema `1.4.0` |

All DB commands run with `--test-concurrency=1` and an explicit
`PGDATABASE=alrifai_v2_test`. Production `alrifai_v2` is never the target.

---

## 7. Release, migration and rollback strategy

### Branch and commit strategy

- Develop only on `feature/phase3-router-cash-vessel` in
  `/opt/al-rifai-phase3-test`.
- One commit per coherent change: baseline fixes, schema, domain services,
  API/auth, UI, tests, docs.
- Push the feature branch after each green gate. No force-push.
- Open a PR to `main`; require the documented CI/test evidence and Owner review.
- Merge to `main` only after explicit approval. The merge itself is not a
  production deployment.

### Production migration strategy (recommended, not executed)

1. Owner approval with the exact commit SHA and change list.
2. Fresh verified backup of `alrifai_v2` (custom-format dump + SHA-256 +
   `pg_restore -l` check) stored outside `/tmp`.
3. Preserve the running image and tag it for rollback.
4. Deploy the new image only after the migration is verified on a **copy** of
   production data.
5. Run `db:migrate` (additive, idempotent, checksum-tracked).
6. Configure the Phase 3 router allowlist and cutover watermarks only when the
   Owner supplies the approved chats, participants and Admin JIDs.
7. Verify health, schema `1.4.0`, login, Cash read views, Review Queue, sync
   checkpoints and zero automatic postings.
8. Keep the previous image and a rollback runbook.

### Rollback strategy

- Application: redeploy the previous image; additive schema remains compatible
  with the Phase 2 application.
- Data: never drop Phase 3 columns/tables and never delete records created by
  Phase 3. Restore the database only if a verified corruption requires it.
- Router: disable `app_settings.phase3_router_enabled` first (fail-closed),
  leaving all raw messages and business rows intact.
- Financial: a mistaken posting is corrected by the reversal path, never by
  mutating `ledger_entries` or `cash_postings`.

### Owner decisions still required

1. Approve the exact release SHA, migration window and production backup
   location.
2. Approve the Cash capability matrix: who may post, reverse and reconcile;
   whether the approver and poster must be different people.
3. Supply the approved Phase 3 business chats, group participants and WA-01
   Admin JID(s), plus the cutover watermarks at the actual deployment.
4. Decide whether USER direct writes should remain staged for review (this plan
   implements staging where the capability model already promises it).
5. Decide whether historical WhatsApp backfill is ever approved (separate task;
   the Live Router remains watermark-gated).
6. Accept the CI evidence available in this environment if GitHub Actions
   remains billing-locked.

---

## 8. Progress log

| Date | Step | Result |
|---|---|---|
| 2026-11-06 | Location/worktree/DB/runtime verification | Complete; evidence in §2 |
| 2026-11-06 | Baseline test execution | Unit 67/67, router 49/49, cutover 18/18, review 7/7, domain 9/9; WhatsApp 0/1; typecheck fail |
| 2026-11-06 | Master Plan authored | This document |
| 2026-11-06 | Phase A baseline fixes | **Complete** — typecheck 0 errors; WhatsApp adapter test passes; conflict target corrected |
| 2026-11-06 | Phase B Cash lifecycle | **Complete in code + test DB** — migration 008, submission→instruction conversion, reversal, reconciliation, `/cash/[id]`, 5/5 lifecycle tests |
| 2026-11-06 | Phase C authorization/audit | **Complete in code + test DB** — capability matrix enforced, transaction-aware audit, client-aware review application, Super Admin user management |
| 2026-11-06 | Phase D migration/CI | **Complete** — checksum-tracked `db:migrate`, idempotent `--force`, fresh-install + upgrade checks, CI updated to 1.4.0 |
| 2026-11-06 | Dependency remediation | **Complete** — Next.js 16.4.1, Zod 4.6.6, fast-uri 3.1.9; `pnpm audit --prod` clean |
| 2026-11-06 | Verification | **91/91 integration tests**, 67/67 unit tests, typecheck, lint, Next build and Docker build pass |
| 2026-11-06 | Phase E polish/docs | **Complete** — README, developer map, PR description, release checklist and rollback runbook updated |
| 2026-11-06 | Phase F release candidate | **Pushed** — commits `39a9023`…`1a5d92e`; image `sha256:010e42bf…`; evidence in `docs/PHASE3_RELEASE_EVIDENCE.md`; main merge and production deployment await Owner approval |

### Newly verified during implementation

- `alrifai_v2_test` migrated from `1.3.3` to `1.4.0`; 35 tables (including the
  migration ledger); repeated `db:migrate` is a no-op.
- Fresh disposable database `alrifai_v2_ci_test`: install produced 34 tables and
  `1.4.0`; `db:migrate` produced 35 tables/7 migration rows; `install --force`
  then succeeded on the installed schema.
- The Live Router now attributes automated Cash/Vessel writes to the stable
  `system:whatsapp-router` identity, so the sole human Administrator can review
  and approve them without a self-review deadlock. The invoking human remains on
  the `WHATSAPP_ROUTER_BATCH` audit row.
- No production migration, image deployment, restart or live financial posting
  was performed.

---

## 9. Current handoff (2026-11-06)

**State:** Phase 3 release candidate is complete on
`feature/phase3-router-cash-vessel` at `1a5d92e`, pushed to GitHub. `main`
remains `e6becfc` (Phase 2). Production remains on image
`local/al-rifai-platform:20261105-phase2`, DB `alrifai_v2` at `1.2.0`.

**Verified:** 67/67 unit, 91/91 integration, typecheck, lint, Next build,
Docker build, dependency audit clean, test DB at `1.4.0`, fresh disposable DB
install/migrate/`--force` verified.

**Not done (requires Owner):**

1. PR review and merge to `main`.
2. Fresh verified production backup.
3. Production migration (`pnpm db:migrate`) and image deployment.
4. Enabling the Live Router with Owner-approved chats, participants, Admin JIDs
   and captured watermarks.
5. Any real Cash posting, reversal or reconciliation.

**Next safe action after approval:** restore the production dump to an isolated
copy, run `pnpm db:preflight` and `pnpm db:migrate`, verify `1.4.0` and the Cash
read/audit pages, then follow `PHASE3_VPS_RELEASE_CHECKLIST.md`.

**Do not:** edit the legacy application, production DB, bridge stores or
deployment `.env`; force-push; delete Phase 3 tables/records; auto-post funds.

## 9. Handoff rule

This file is the authoritative Phase 3 completion plan. Update the progress log
and the relevant section in the same commit as the work. Do not append a daily
diary; replace stale status. `DEVELOPER_START_HERE.md` remains the canonical
current-state map; this file owns the plan and the release decision record.
