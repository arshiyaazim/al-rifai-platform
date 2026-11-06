# Phase 3 — Complete Cash Lifecycle, Router, Review Queue and Release Readiness

**Branch:** `feature/phase3-router-cash-vessel`
**Baseline:** `e6becfc` (Phase 2 `main`)
**Status:** release candidate; production NOT deployed

## What this PR adds

### Shared WhatsApp router
- Domain classification, per-account cutover watermark, business-chat
  allowlist, crash-safe processing state and retry.
- Automated writes are attributed to `system:whatsapp-router`; the invoking
  human remains on the batch audit row. This lets a sole human Admin review
  automated Cash items without a self-review deadlock.

### Complete Cash lifecycle
- `REVIEW → APPROVED → POSTED / REJECTED / VOID`.
- Router-created instructions can be assigned a paying account before approval;
  approval fails closed until an account is present.
- Approved review candidate atomically creates a linked `REVIEW` instruction.
- Immutable posting + ledger entry.
- Reversal: one immutable `cash_reversals` row plus a contra `CREDIT` ledger
  entry; original posting and ledger are never edited.
- Reconciliation: expected/counted/variance, OPEN/CLOSED; non-zero variance
  requires an explanation; closing never posts an automatic adjustment.
- `/cash/[id]` shows instruction, posting, reversal, ledger and audit history.

### Review Queue and Vessel
- Category-aware queue, source evidence, corrections, decisions, withdrawal.
- Vessel multi-message correlation, group participant authorization,
  confirmation evidence and duplicate warnings.

### Authorization
- Explicit capabilities for cash review/post/reverse/reconcile/ledger/account,
  payroll, employees, attendance, vessel command/release, WhatsApp, review and
  user management.
- Server-side enforcement in routes and services; USER direct writes are staged
  through review where the model promises submission.
- Super Admin user administration with last-admin lockout protection.

### Continuous route
- Optional in-process router worker (`PHASE3_ROUTER_WORKER_ENABLED`, default off)
  routes new rows through the same shared router used by the manual API.
- Vessel has a separate deployment gate; disabled Vessel messages stay PENDING
  and are processed after activation.

### Database and release engineering
- Migration `008_phase3_cash_lifecycle.sql`, schema `1.4.0`.
- Checksum-tracked `scripts/standalone/migrate.mjs`; idempotent
  `install --force`; shared runtime grants.
- Next.js `16.4.1`, Zod `4.6.6`, fast-uri `3.1.9`; production audit clean.

### Audit integrity
- `recordAudit(input, client)` participates in the business transaction.
- Review decisions apply domain writes on the same transaction client.

## Verification

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors |
| Unit tests | 69/69 |
| Integration tests | 95/95 |
| Next.js build | pass |
| Docker build | pass |
| `pnpm audit --prod` | no known vulnerabilities |
| Test DB | `1.4.0`, 35 tables, repeat migration no-op |
| Fresh disposable DB | install 34 tables/1.4.0; migrate 35 tables/7 rows; `--force` passes |
| Production-copy rehearsal | 34,420 messages preserved, 1.2.0 → 1.4.0, automatic Cash and Vessel pipeline verified |

## Not included / not authorized

- No production deployment, migration, restart or image activation.
- No real financial posting, reversal or reconciliation execution.
- No automatic historical WhatsApp backfill.
- GitHub Actions has not run (account billing lock); local evidence is provided.

## Owner decisions required before production

1. Approve exact release SHA, backup and migration window.
2. Approve the Cash capability matrix and whether approver ≠ poster.
3. Supply approved business chats, group participants and WA-01 Admin JIDs.
4. Accept the local CI evidence if GitHub Actions remains unavailable.
