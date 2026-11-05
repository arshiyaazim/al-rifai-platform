# Phase 3 File Manifest

**Branch:** `feature/phase3-router-cash-vessel`  
**Baseline:** `e6becfc`  
**All files under `/home/user/phase3-work/`**

## New Files

| Path | Purpose | Status |
|---|---|---|
| `lib/message-router.ts` | Phase 3 shared router: domain classification, authorization, processing state, retry, Review Queue, source provenance | Created |
| `lib/message-classifier.ts` | Pure CASH/VESSEL/UNKNOWN classifier from text + chat purpose | Created |
| `db/standalone/004_phase3_router_state.sql` | Additive migration: processing_status, retry_count, last_error, last_processed_at on whatsapp_messages | Created |
| `tests/standalone/message-classifier.test.mjs` | Pure classifier unit tests | Created |
| `tests/standalone/message-router.test.mjs` | Router integration tests (requires disposable DB) | Created |
| `.github/workflows/ci.yml` | CI pipeline: lint, typecheck, unit tests, integration tests, migration validation, build, Docker validation | Created |
| `PHASE3_PR_DESCRIPTION.md` | Pull request description for reviewer | Created |
| `PHASE3_VPS_RELEASE_CHECKLIST.md` | VPS deployment checklist (after owner approval) | Created |
| `PHASE3_ROLLBACK_INSTRUCTIONS.md` | Rollback procedure (preserve data, no destructive git) | Created |
| `PHASE3_FILE_MANIFEST.md` | This file | Created |

## Modified Files

| Path | Change | Status |
|---|---|---|
| `lib/standalone/whatsapp.ts` | Added `import routePendingMessages` from `../message-router.ts`; added `routePending(actor, limit)` export | Modified |
| `app/api/whatsapp/route.ts` | Added `routePending` import; added `POST ?action=route` handler | Modified |
| `DEVELOPER_START_HERE.md` | Updated directory map, features table, pipeline inventory, database section, current priorities | Modified |

## Unchanged Files (referenced by Phase 3)

| Path | Role |
|---|---|
| `lib/standalone/db.ts` | `row`, `rows`, `tx`, `DomainError`, `Actor`, `newId`, `stableId`, `moneyMinor` |
| `lib/standalone/audit.ts` | `recordAudit` for router batch/audit events |
| `lib/standalone/finance.ts` | `createInstruction` (cash → REVIEW), `submitCash` (cash submissions) |
| `lib/standalone/programs.ts` | `createProgram` (vessel → DRAFT), `potentialDuplicates` |
| `lib/standalone/review.ts` | `submitForReview` (PROGRAM domain), `listReview` |
| `lib/conversation-scope.ts` | `loadConversationScope` (future roster-based authorization) |
| `lib/history-extraction.mjs` | `parsePaymentBlocks` (cash parsing) |
| `lib/escort-intake-candidate.mjs` | `parseEscortOrder` (vessel parsing) |
| `lib/shift-boundary.ts` | `orderDraftDateAndShift` (date/shift derivation) |
| `lib/standalone/whatsapp.ts` | `applyConfirmation` (existing confirmation matching) |
| `app/api/whatsapp/route.ts` | Existing `processPending` endpoint (unchanged) |
| `app/api/review/route.ts` | Existing review list/submit/decide/withdraw (unchanged) |
| `app/api/finance/route.ts` | Existing finance endpoints (unchanged) |
| `app/api/programs/route.ts` | Existing programs endpoints (unchanged) |
| `db/standalone/schema.sql` | 30-table baseline (unchanged) |
| `db/standalone/002_raw_import.sql` | Raw import layer (unchanged) |

## Test Coverage

| Test File | Type | DB Required | Local Run |
|---|---|---|---|
| `tests/standalone/message-classifier.test.mjs` | Unit (pure) | No | No (Node.js v20 no TS) |
| `tests/standalone/message-router.test.mjs` | Integration | Yes | No (no PostgreSQL) |
| `tests/standalone/domain.test.ts` | Existing | Yes | No |
| `tests/standalone/whatsapp.test.ts` | Existing | No | No |
| `tests/standalone/identity.test.mjs` | Existing | No | No |
| `tests/standalone/media.test.mjs` | Existing | No | No |

## CI Pipeline (`.github/workflows/ci.yml`)

| Job | Runs On | Services |
|---|---|---|
| lint-and-typecheck | ubuntu-latest | None |
| unit-tests | ubuntu-latest | None |
| domain-integration-tests | ubuntu-latest | PostgreSQL 16 (disposable) |
| router-tests | ubuntu-latest | PostgreSQL 16 (disposable) |
| migration-validation | ubuntu-latest | PostgreSQL 16 (disposable) |
| nextjs-build | ubuntu-latest | None |
| docker-build-validation | ubuntu-latest | None |
| ci-summary | ubuntu-latest | None (aggregation) |

## Delivery Boundary

- ✅ Local implementation package complete
- ❌ No VPS deployment
- ❌ No GitHub push
- ❌ No CI claims without evidence
- ❌ No production deployment
- Owner approval required before merge
