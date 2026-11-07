# Phase 3 File Manifest

**Branch:** `feature/phase3-cash-paid-events` (Phase 3 Cash Paid worktree)
**Baseline:** `13d660c`
**Schema:** `1.6.0` target (production still `1.5.0`; migrations are explicit CLI only)

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
| `tests/standalone/ai-assistant.test.mjs` | WA-02 AI integration tests |
| `tests/standalone/ai-policy.test.mjs` | AI policy unit tests |
| `tests/standalone/ai-worker.test.mjs` | AI worker gate tests |
| `tests/standalone/ai-sender.test.mjs` | Outbound sender tests against a mock MCP socket |
| `tests/standalone/ai-llm.test.mjs` | Optional LLM adapter and numeric-guard tests |
| `tests/standalone/reset.mjs` | Shared test-fixture reset |
| `lib/phase3-router-worker.ts` | Optional continuous router loop (default-disabled) |
| `tests/standalone/router-worker.test.mjs` | Router worker gate tests |
| `docs/PHASE3_AUTONOMOUS_COMPLETION_MASTER_PLAN.md` | Evidence-based completion plan and release decision record |
| `docs/PHASE3_CUTOVER_RUNBOOK.md` | Evidence-backed final sync, separate-project cutover and divergence rollback |
| `docs/PHASE3_AI_ASSISTANT.md` | WA-02 AI boundaries, schema, tools, gates and remaining blockers |
| `docs/PHASE3_PRODUCTION_GATES.md` | Gate 1–4 release package, commands, rollback and Owner inputs |
| `db/standalone/009_phase3_ai_assistant.sql` | AI conversation, applicant, order-draft, outbound, tool and escalation tables |
| `lib/ai/policy.ts` | Deterministic AI policy, intent, extraction and privacy rules |
| `lib/ai/store.ts` | AI conversation, draft and outbound persistence |
| `lib/ai/tools.ts` | Scoped employee/Cash/Vessel/applicant/order/message tools |
| `lib/ai/engine.ts` | WA-02 engine and Admin assistant query path |
| `lib/ai/worker.ts` | Default-disabled WA-02 AI worker |
| `lib/ai/sender.ts` | Controlled outbound lifecycle, idempotency and ambiguity handling |
| `lib/ai/llm.ts` | Optional OpenAI-compatible rephrasing layer with numeric guard |
| `scripts/standalone/wa01-activation.mjs` | Dry-run WA-01 activation applier from the protected artifact |
| `app/(workspace)/vessel/[id]/page.tsx` | Program detail: edit, assign/replace escort, in-duty, release, complete, void, evidence and events |
| `lib/release-slip.ts` | Pure escort release-slip parser |
| `lib/business-rules.mjs` | Versioned phone/name/vessel normalization rules |
| `lib/identity-resolution.mjs` | Identity decision levels |
| `lib/employee-identity.ts` | DB-backed employee identity resolution |
| `lib/authorized-contacts.ts` | Effective-dated Accountant/contact registry |
| `scripts/standalone/manage-authorized-contact.mjs` | Registry update CLI |
| `scripts/standalone/provision-admin.mjs` | Explicit `.env` Admin provisioning/check/reset CLI |
| `docs/ADMIN_AUTH.md` | Admin authentication diagnosis and secure setup |
| `docs/PRODUCTION_URLS.md` | Verified URLs and legacy compatibility matrix |
| `docs/DNS_CLOUDFLARE_1014.md` | Cloudflare 1014 diagnosis and correction proposal |
| `docs/LEGACY_PHASE3_COMPARISON.md` | Legacy/Phase 3 page, feature and database comparison |
| `app/(workspace)/assistant/page.tsx` | Admin Assistant page |
| `app/(workspace)/transactions/page.tsx` | Cash transactions/ledger page |
| `app/(workspace)/cash/transactions/page.tsx` | Cash transactions route |
| `app/(workspace)/cash/archive/page.tsx` | Posted Cash archive/ledger |
| `app/(workspace)/cash/submissions/page.tsx` | Cash submissions/review |
| `app/(workspace)/submissions/page.tsx` | My Submissions |
| `app/(workspace)/register/page.tsx` | Vessel register (legacy URL) |
| `app/(workspace)/vessel-register/page.tsx` | Vessel register (legacy URL) |
| `app/(workspace)/vessel/register/page.tsx` | Nested vessel register |
| `app/(workspace)/vessel/vessel-register/page.tsx` | Nested legacy vessel register |
| `app/(workspace)/sources-review/page.tsx` | Review queue page |
| `app/(workspace)/insights/page.tsx` | Operational insights |
| `app/(workspace)/income-expenditure/page.tsx` | Income/expenditure report |
| `app/(workspace)/archive/page.tsx` | Audit/ledger archive |
| `app/(workspace)/conversations/page.tsx` | Conversation list |
| `app/(workspace)/message-mirror/page.tsx` | Message mirror |
| `app/(workspace)/employee/page.tsx` | Employee directory alias |
| `app/(workspace)/employee/[phone]/page.tsx` | Employee profile alias |
| `app/(workspace)/transactions/employee/[phone]/page.tsx` | Employee transaction history |
| `components/standalone/cash-transactions-view.tsx` | Shared Cash table |
| `components/standalone/cash-submissions-view.tsx` | Shared submissions table |
| `components/standalone/vessel-register-view.tsx` | Shared vessel table |
| `components/standalone/assistant-console.tsx` | Assistant query UI |
| `scripts/standalone/provision-users.mjs` | Two USER account provisioner |
| `scripts/standalone/set-secret-password.mjs` | Secure interactive password-file writer |
| `docs/ADAPTIVE_RULES.md` | Rule/identity/registry operating guide |
| `scripts/standalone/backfill-cash-coverage.mjs` | Idempotent Cash coverage backfill; REVIEW only |
| `scripts/standalone/repair-legacy-program-links.mjs` | Idempotent assignment/source/event repair for imported programs |
| `tests/standalone/release-slip.test.mjs` | Release-slip parser tests |
| `lib/order-draft-from-record.ts` | Read-only projection: DRAFT/CONFIRMED program or PROGRAM review payload → exact Owner draft + blocking gaps; `MANUAL_COPY_ONLY` |
| `components/standalone/owner-draft-panel.tsx` | Server-rendered Owner draft block with gap warnings and delivery note |
| `components/standalone/copy-draft-button.tsx` | Clipboard-only copy button (no API, no send) |
| `app/(workspace)/vessel/drafts/page.tsx` | Vessel Order Drafts workspace for Admin copy/assignment |
| `tests/standalone/order-draft-record.test.mjs` | 7 pure tests: exact layout, dates/shifts, missing-field blocking, review mapping |
| `docs/PROJECT_KNOWLEDGE.md` | Permanent project map: layout, feature-to-file, APIs, workflows, DB, env, issue queue |
| `docs/VESSEL_ORDER_DRAFT.md` | Order-draft root cause, implemented stage, transport options and rollback |
| `NEXT-HANDOFF.md` | Session handoff: versions, tests, blockers, exact next task |
| `tests/standalone/history-extraction.test.mjs` | Cash payment-block parser tests |
| `db/standalone/010_vessel_draft_delivery.sql` | Inert WA-01 vessel draft-delivery queue (recovered from `3e0dd01`; not activated) |
| `db/standalone/011_cash_payment_events.sql` | Append-only Business Paid Events, corrections/reversals and financial posting link |
| `lib/standalone/finance.ts` (`insertBusinessPaidEvent`, `correctBusinessPaidEvent`, `reverseBusinessPaidEvent`) | Business Paid write/correction/reversal services; never writes the ledger |
| `tests/standalone/cash-paid-events.test.mjs` | 12 tests: single-mobile, WhatsApp automatic Paid, Office Paid, replay/concurrency, flag, reporting, append-only, no ledger |
| `tests/standalone/migration-integrity.test.mjs` | 5 tests: 010→011 order/checksums, schema, indexes, constraints, idempotent re-apply |
| `AGENTS.md` | Non-negotiable Cash/WhatsApp/Paid-vs-POSTED/migration invariants |
| `phase3-implementation-plan.md` | Corrected implementation record (was a proposal) |
| `phase3-technical-decision-report.md` | Corrected final design and evidence |
| `app/api/assistant/route.ts` | Admin assistant/draft/applicant/order API |
| `compose.phase3.yaml` | Production override for `alrifai_v2_phase3` and flags off |

## Modified files (highlights)

| Path | Change |
|---|---|
| `lib/standalone/finance.ts` | Full lifecycle, reversal, reconciliation, candidate→instruction, audit atomicity; Phase 3 Business Paid Events, single-mobile payout, strict method/identity, posting link |
| `lib/history-extraction.mjs` | Cash parser: single-mobile rule, hyphenated numbers, multi-line blocks, `(C)/(R)/BANK`, amount variants, no fabricated method |
| `lib/message-router.ts` | Processes all clean Cash blocks; WhatsApp automatic Business Paid at the authorized routing point |
| `lib/standalone/cash-dashboard.ts` | Flag-gated Business Paid reporting union with legacy POSTED; business detail list; lazy timezone binding |
| `scripts/standalone/install.mjs` | Fresh install includes 010/011 and verifies the new tables |
| `scripts/standalone/grants.mjs` | Append-only grants for Business Paid tables; read-write grant for the inert vessel queue |
| `lib/standalone/review.ts` | Client-aware review application, transaction-aware audit |
| `lib/standalone/programs.ts`, `employees.ts`, `attendance.ts` | Client-aware writers + capability enforcement; `getProgram()` returns `start_date`/`end_date` as ISO text (fixes `[object Date]` 500) |
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

- Code, migrations, tests and documentation are complete on
  `feature/phase3-cash-paid-events`.
- Production migration, deployment and flag activation were NOT executed.
- Owner approval is required before merge/deploy/migration.
- `PHASE3_PAID_EVENTS_ENABLED` remains OFF by default; rollback is setting it
  to `0`.
