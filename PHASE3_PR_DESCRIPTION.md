# Phase 3 (Revised) — Pull Request Description

**Branch:** `feature/phase3-router-cash-vessel`  
**Baseline:** `e6becfc`  
**Status:** Ready for review — local implementation only, no deployment  

## Scope Summary

Implement Phase 3 (Revised): shared WhatsApp message router with domain
classification, authorization enforcement, crash-safe processing state,
Review Queue integration for errors/ambiguity, source provenance linkage,
Cash Domain Handler, Vessel Domain Handler, CI workflows, and documentation.

**Explicitly out of scope:**
- No production deployment, no VPS access
- No automatic financial posting (all cash instructions go to REVIEW state)
- No expanded WhatsApp authorization scope (existing `whatsapp_chats.authorized` contract only)
- No automatic outbound WhatsApp sender expansion (confirmation uses admin's existing outgoing reply)
- No scope expansion beyond the six increments

## Changes by Increment

### Increment 1 — Router Foundation
- `lib/message-router.ts` — shared router: domain classification, authorization,
  processing state (PENDING/PROCESSING/COMPLETED/FAILED), retry with backoff,
  Review Queue submission for errors/ambiguity, source provenance
- `lib/message-classifier.ts` — pure CASH/VESSEL/UNKNOWN classifier from text
  + chat purpose
- `lib/standalone/whatsapp.ts` — added `routePending()` export calling
  `routePendingMessages()`
- `app/api/whatsapp/route.ts` — added `POST ?action=route` (ADMIN only)
- `db/standalone/004_phase3_router_state.sql` — additive migration:
  `processing_status`, `retry_count`, `last_error`, `last_processed_at` on
  `whatsapp_messages`; schema version bumped to 1.3.0

### Increment 2 — Cash Domain
- Incoming WhatsApp cash messages → `cash_instructions` in REVIEW state via
  `createInstruction()` (existing verified business rule, unchanged)
- Unparsable cash messages → `cash_submissions` PENDING_REVIEW with raw text
  and parse errors (uses established `cash_submissions` path, NOT
  `submitForReview` which rejects CASH domain by design)
- Idempotent by `(source_message_id, source_block_key)` — no duplicates from replay
- Provenance: `source_message_id`, `source_block_key` on `cash_instructions`

### Increment 3 — Vessel Domain
- Incoming WhatsApp vessel messages → `programs` in DRAFT state via
  `createProgram()` (existing verified business rule, unchanged)
- Duplicate detection via `potentialDuplicates()` (±1 day warning → Review
  Queue; exact same-day → skip, logged)
- Provenance: `source_message_id`, `source_chat_jid` on `programs`
- Admin outgoing confirmation matched by existing `applyConfirmation()` — no
  new outbound sender

### Increment 4 — Review Queue
- `review_items` domain PROGRAM for vessel parse errors and duplicate warnings
- `cash_submissions` domain CASH for cash parse errors (established path)
- No auto-decision: all review items require manual admin review via
  `POST /api/review` (existing endpoint, unchanged)

### Increment 5 — Frontend Integration
- No new UI required for minimal Phase 3 scope
- Existing UI pages unchanged: `messages/page.tsx`, `cash/page.tsx`,
  `vessel/page.tsx`, `review/page.tsx`
- Router accessible via existing API surface (`POST /api/whatsapp?action=route`)

### Increment 6 — CI / Tests / Docs
- `.github/workflows/ci.yml` — CI pipeline: dependency install (pnpm), lint,
  typecheck, unit tests, domain integration tests (disposable PostgreSQL),
  router tests, migration validation (disposable PostgreSQL), Next.js build,
  Docker build validation, synthetic fixtures only (no production creds)
- `tests/standalone/message-classifier.test.mjs` — pure classifier tests
- `tests/standalone/message-router.test.mjs` — router integration tests
- `DEVELOPER_START_HERE.md` — updated in place: Phase 3 entries marked
  IMPLEMENTED / LOCALLY TESTED / CI NOT RUN / PRODUCTION NOT DEPLOYED /
  LIVE NOT VERIFIED

## Verification Status (local environment)

| Check | Status | Notes |
|---|---|---|
| Classifier unit tests | Not run locally | Node.js v20 lacks `--experimental-strip-types`; run in CI |
| Router integration tests | Not run locally | Requires disposable PostgreSQL; run in CI |
| Lint / typecheck | Not run locally | pnpm not available locally; run in CI |
| Migration validation | Not run locally | No psql/PostgreSQL/Docker locally; run in CI |
| Next.js build | Not run locally | No pnpm locally; run in CI |
| Docker build | Not run locally | No Docker locally; run in CI |

No production credentials or messages are used anywhere. Tests use synthetic
fixtures against a disposable PostgreSQL container in CI.

## Release Gate (owner approval required before merge)

1. CI passes on `feature/phase3-router-cash-vessel`
2. Migration `004_phase3_router_state.sql` verified on disposable PostgreSQL
   → schema version 1.3.0
3. No automatic financial posting (cash instructions remain in REVIEW state)
4. No duplicates from replay (idempotency by source key)
5. Phase 2 intact — no changes to verified Cash/Vessel business rules
6. Documentation updated (`DEVELOPER_START_HERE.md` in place)

## VPS Deployment (after owner approval — NOT part of this PR)

See `PHASE3_VPS_RELEASE_CHECKLIST.md` for the deployment procedure and
`PHASE3_ROLLBACK_INSTRUCTIONS.md` for rollback steps.
