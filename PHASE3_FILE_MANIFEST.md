# Phase 3 File Manifest

**Branch:** `feature/phase3-router-cash-vessel`
**Baseline:** `e6becfc`
**Schema:** `1.4.0`

## New files

| Path | Purpose |
|---|---|
| `db/standalone/008_phase3_cash_lifecycle.sql` | Candidate→instruction link, immutable reversals, reconciliation, ledger source values |
| `lib/standalone/authz.ts` | Capability resolution and server-side enforcement |
| `lib/standalone/users.ts` | Super Admin user administration and lockout protection |
| `scripts/standalone/migrate.mjs` | Checksum-tracked incremental migration runner |
| `scripts/standalone/grants.mjs` | Shared least-privilege runtime grants |
| `app/api/users/route.ts` | Super Admin user admin API |
| `app/(workspace)/cash/[id]/page.tsx` | Instruction, posting, reversal, ledger and audit detail |
| `tests/standalone/cash-lifecycle.test.mjs` | Full Cash lifecycle integration tests |
| `tests/standalone/users.test.mjs` | User administration integration tests |
| `tests/standalone/reset.mjs` | Shared test-fixture reset |
| `lib/phase3-router-worker.ts` | Optional continuous router loop (default-disabled) |
| `tests/standalone/router-worker.test.mjs` | Router worker gate tests |
| `docs/PHASE3_AUTONOMOUS_COMPLETION_MASTER_PLAN.md` | Evidence-based completion plan and release decision record |

## Modified files (highlights)

| Path | Change |
|---|---|
| `lib/standalone/finance.ts` | Full lifecycle, reversal, reconciliation, candidate→instruction, audit atomicity |
| `lib/standalone/review.ts` | Client-aware review application, transaction-aware audit |
| `lib/standalone/programs.ts`, `employees.ts`, `attendance.ts` | Client-aware writers + capability enforcement |
| `lib/standalone/audit.ts` | Transaction-aware `recordAudit` |
| `lib/standalone/whatsapp.ts` | Correct conflict target, type narrowing, capability checks |
| `lib/message-router.ts` | System actor for automated writes; capability-safe routing |
| `lib/unified-auth-policy.ts` | Explicit full-lifecycle capability matrix |
| `app/api/*` | Capability enforcement, user admin, cash reversal/reconciliation |
| `app/(workspace)/cash/page.tsx` | Candidate decisions, reversal, reconciliation, audit links |
| `app/(workspace)/settings/page.tsx` | Super Admin user administration |
| `scripts/standalone/install.mjs` | Additive `--force`, migration 008, shared grants |
| `.github/workflows/ci.yml` | Full suite, Cash/users job, schema `1.4.0` validation |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Test commands, patched dependencies, audit overrides |
| `README.md`, `DEVELOPER_START_HERE.md`, release/rollback docs | Current-state and release documentation |

## Delivery boundary

- Code and integration tests complete on the feature branch.
- Production deployment, migration and live financial posting NOT executed.
- Owner approval required before merge/deploy.
