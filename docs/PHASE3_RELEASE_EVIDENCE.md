# Phase 3 Release Evidence

**Recorded:** 2026-11-06
**Branch:** `feature/phase3-router-cash-vessel`
**Release candidate code commit:** `06f7c66`
**Documentation tip:** this documentation commit (child of `06f7c66`)
**Schema:** `1.4.0`
**Feature branch:** pushed to `origin/feature/phase3-router-cash-vessel` at `1a5d92e`
**Production deployment:** NOT EXECUTED

## Image

| Field | Value |
|---|---|
| Tag | `al-rifai-platform:phase3-rc-final3` |
| Manifest digest | `sha256:d9e7f7652f9e9cdf15f0b5bf82361ea295108857fda35fca071f266b5b3b3884` |
| Build source | code commit `06f7c66` |
| Runtime | Node 22, Next.js 16.4.1, non-root `10001:10001` |

The image was built locally only. It was not pushed, tagged as production, or
deployed.

## Verification results

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors |
| Lint | `pnpm lint` | 0 errors, 6 pre-existing warnings |
| Unit tests | `pnpm test:unit` | 69/69 pass |
| Integration tests | `pnpm test:standalone` | 95/95 pass |
| Next.js build | `pnpm build` | pass |
| Docker build | `docker build -t al-rifai-platform:phase3-rc-final3 .` | pass |
| Dependency audit | `pnpm audit --prod` | no known vulnerabilities |
| Test DB migration | `scripts/standalone/migrate.mjs` | `1.3.3` → `1.4.0`, 35 tables, 7 ledger rows; repeat no-op |
| Fresh disposable DB | installer + migrate + `--force` | install 34 tables/1.4.0; migrate 35 tables; `--force` pass |
| Runtime smoke | release image `phase3-rc-final3` + authenticated HTTP | health 200/schema 1.4.0; dashboard/cash/review/vessel/settings 200; `/cash/[id]` 200 with audit |
| Production-copy migration rehearsal | restored real `alrifai_v2` dump into `alrifai_v2_phase3_rehearsal` | 1.2.0 → 1.4.0; 34,420 messages / 2,010 chats / 2,597 aliases / 261 media / 3 users preserved |
| Automatic WhatsApp pipeline | image `phase3-rc-final3` + rehearsal DB | post-cutover synthetic message → REVIEW instruction without manual route; history remained PENDING |
| Vessel activation gate | same image, flag 0 then 1 | deferred message stayed PENDING with flag 0; created DRAFT program after flag 1 |
| HTTP lifecycle on production copy | image `phase3-rc-final3` | create → assign account → approve → post → reverse → reconcile; ledger DEBIT+CREDIT; audit complete |

## Integration suite breakdown

| Suite | Tests |
|---|---|
| `domain.test.ts` | 10 |
| `whatsapp.test.ts` | 1 |
| `message-router.test.mjs` | 50 |
| `router-cutover.test.mjs` | 18 |
| `review-api.test.mjs` | 7 |
| `cash-lifecycle.test.mjs` | 7 |
| `users.test.mjs` | 2 |
| **Total** | **95** |

## Production-copy migration rehearsal (2026-11-06)

A real `pg_dump -Fc` of production `alrifai_v2` was restored into the isolated
database `alrifai_v2_phase3_rehearsal`. Production was read-only for this step.

- Dump: 7.6 MB, 227 TOC entries, SHA-256
  `a96f20f36eaaba778c751ad8038850600e99a136f5a4c2ba3f3cf03a67499e90`.
- Pre-migration: schema `1.2.0`, 30 tables, 34,420 messages, 2,010 chats,
  2,597 identity aliases, 261 media rows, 3 users, 0 programs/instructions.
- Post-migration: schema `1.4.0`, 35 tables, 7 migration-ledger rows, all raw
  data preserved, 34,420 unique message keys, 0 missing `source_rowid`.
- Historical rows remained `PENDING` (34,420) and unchanged; the router did not
  rewrite history.
- Runtime grants exist on `cash_reversals`, `cash_reconciliations` and the
  extended `cash_submissions`; the ledger source check includes
  `REVERSAL`/`RECONCILIATION`; the immutable reversal trigger is present.
- A synthetic post-cutover WA-01 Cash message was routed automatically by the
  actual release image: `CASH:REVIEW_CREATED`, one `REVIEW` instruction with
  `created_by=system:whatsapp-router`, zero postings. Exact replay produced no
  duplicate.
- The router-created instruction was assigned an account, approved, posted and
  reversed over authenticated HTTP; the ledger shows the original `DEBIT` and
  the contra `CREDIT`, and the audit trail contains all five actions.
- A synthetic Vessel message remained `PENDING` while
  `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`; after restarting with `=1`, the same
  message created a DRAFT program. This proves the deployment gate does not lose
  deferred orders.

## Safety confirmation

- Production `alrifai_v2` remains at schema `1.2.0`.
- Production application containers were not restarted or recreated.
- WhatsApp bridge stores were not modified.
- No live financial posting, reversal or reconciliation was executed.
- No `.env`, password, media key or private evidence is committed.
- The test DB `alrifai_v2_test` was the only database migrated to `1.4.0`.
- The disposable `alrifai_v2_ci_test` database was created solely for migration
  verification.

## Remaining release gates

1. Owner approval of commit `4e9ae01` and the Cash capability matrix.
2. Fresh verified production backup stored outside `/tmp`.
3. Production migration window and rollback image retention.
4. Owner-supplied business chats, group participants and WA-01 Admin JIDs.
5. Acceptance of local CI evidence while GitHub Actions remains billing-locked.
