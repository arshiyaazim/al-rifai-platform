# Phase 3 Release Evidence

**Recorded:** 2026-11-06
**Branch:** `feature/phase3-router-cash-vessel`
**Release candidate code commit:** `4e9ae01`
**Documentation tip:** `4c398a4` (docs-only; same application code as `4e9ae01`)
**Schema:** `1.4.0`
**Feature branch:** pushed to `origin/feature/phase3-router-cash-vessel` at `1a5d92e`
**Production deployment:** NOT EXECUTED

## Image

| Field | Value |
|---|---|
| Tag | `al-rifai-platform:phase3-rc-4e9ae01` |
| Manifest digest | `sha256:010e42bf149cfc1127afa51a39a3e21a1d94c1e55c933630d35f94be01f0b7ea` |
| Image ID | `010e42bf149c` |
| Build source | clean feature-branch code commit `4e9ae01` |
| Runtime | Node 22, Next.js 16.4.1, non-root `10001:10001` |

The image was built locally only. It was not pushed, tagged as production, or
deployed.

## Verification results

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors |
| Lint | `pnpm lint` | 0 errors, 6 pre-existing warnings |
| Unit tests | `pnpm test:unit` | 67/67 pass |
| Integration tests | `pnpm test:standalone` | 91/91 pass |
| Next.js build | `pnpm build` | pass |
| Docker build | `docker build -t al-rifai-platform:phase3-rc-4e9ae01 .` | pass |
| Dependency audit | `pnpm audit --prod` | no known vulnerabilities |
| Test DB migration | `scripts/standalone/migrate.mjs` | `1.3.3` → `1.4.0`, 35 tables, 7 ledger rows; repeat no-op |
| Fresh disposable DB | installer + migrate + `--force` | install 34 tables/1.4.0; migrate 35 tables; `--force` pass |
| Runtime smoke | local Next server + authenticated HTTP | health 200/schema 1.4.0; dashboard/cash/review/settings 200; `/cash/[id]` 200 with audit |

## Integration suite breakdown

| Suite | Tests |
|---|---|
| `domain.test.ts` | 9 |
| `whatsapp.test.ts` | 1 |
| `message-router.test.mjs` | 49 |
| `router-cutover.test.mjs` | 18 |
| `review-api.test.mjs` | 7 |
| `cash-lifecycle.test.mjs` | 5 |
| `users.test.mjs` | 2 |
| **Total** | **91** |

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
