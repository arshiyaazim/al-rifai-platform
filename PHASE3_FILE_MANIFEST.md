# Phase 3 File Manifest

**Branch:** `feature/phase3-010-011-release` (release commit `8a6c2c6`)
**Baseline:** `a4aabb6` (cash) with merged router tip `4e2e3f4`; `main` `13d660c`
**Schema:** `1.6.0` deployed (49 tables, migrations 002–011).
**Migrations:** additive `010_vessel_draft_delivery.sql` and
`011_cash_payment_events.sql`; both applied in staged production work and verified.
**`.env` ALRIFAI_TAG:** aligned to deployed `phase3-ai-rc-8a6c2c6`; previous tag backup preserved.
**Production image (DEPLOYED 2026-11-08):** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`
(digest `sha256:8b7ab534838f670c9b6486015650711e266dea4d3f8b2ac4df287d5be1c3e510`)
**Previous/rollback image:** `local/al-rifai-platform:phase3-ai-rc-7da17f1`
(digest `sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa`)

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
| `lib/release-slip.ts` | Pure structured Escort Release parser plus `parseUnstructuredRelease()` for cancellation, transfer, replacement, food-bill and empty release-group evidence |
| `lib/vessel-draft-delivery.ts` | Pure Vessel Draft delivery queue: idempotency key, bounded retry, terminal states, five-block gate, prepared (never executed) outbound request |
| `lib/standalone/vessel-draft-delivery-store.ts` | Durable Postgres store: SKIP LOCKED claim, retry, DELIVERY_UNKNOWN, restart recovery, audit, Admin status |
| `db/standalone/010_vessel_draft_delivery.sql` | **PENDING** additive migration (NOT applied in production) |
| `tests/standalone/vessel-draft-delivery-store.test.mjs` | 8 durable-store integration tests |
| `docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md` | Approved `.env` tag alignment, backup, verification, rollback |
| `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md` | Auth pipeline root cause; no defect; credentials preserved |
| `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` | VERIFIED/PARTIAL/FAILED/NOT TESTED production UI matrix + OWNER-CONFIRMED / AGENT-VERIFIED distinction |
| `docs/MAIN_RECONCILIATION_PLAN.md` | `main` / feature Git divergence (22/17 commits, merge base `76d5d00`), README conflict list, approved PR/`--no-ff` merge plan; no merge performed |
| `README.md` | Reconciled release status: Current Production / Historical Release / Built but Not Deployed / Pending Migration & Activation |
| `scripts/owner-assisted-ui-verify.sh` | Read-only, `bash -n`-clean Owner-assisted verification script; prints no cookie/session body/secret |
| `lib/action-form-request.ts` | Pure ActionForm HTTP wiring (POST default, PATCH/DELETE) |
| `tests/standalone/vessel-draft-delivery.test.mjs` | 12 isolated delivery state-machine tests |
| `tests/standalone/historical-release-review.test.mjs` | Regression tests pinned to all seven exact historical production release texts |
| `tests/standalone/action-form-request.test.mjs` | ActionForm POST/PATCH/DELETE wiring tests |
| `docs/PHASE3_PREDEPLOY_BACKUP_20261107.md` | Fresh verified pre-deploy backup: size, checksum, restore test, restoration procedure |
| `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` | Bridge architecture, delivery direction, durable-record design, activation gate |
| `docs/HISTORICAL_RELEASE_REVIEW_20261107.md` | Seven historical item classifications, candidate program matches, proposed (not applied) corrections |
| `docs/BUSINESS_WORKFLOW_BACKLOG.md` | Resolved items, remaining gaps and priorities |
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
| `tests/standalone/release-slip.test.mjs` | Structured release-slip tests + 7 unstructured release-evidence tests (real production samples) |
| `tests/standalone/message-router.test.mjs` | Router/Vessel/Cash integration tests incl. 3 new unstructured-release review tests |
| `tests/standalone/domain.test.ts` | Domain lifecycle tests incl. escort directory-name resolution |
| `lib/order-draft-from-record.ts` | Read-only projection: DRAFT/CONFIRMED program or PROGRAM review payload → exact Owner draft + blocking gaps; `MANUAL_COPY_ONLY` |
| `components/standalone/owner-draft-panel.tsx` | Server-rendered Owner draft block with gap warnings and delivery note |
| `components/standalone/copy-draft-button.tsx` | Clipboard-only copy button (no API, no send) |
| `app/(workspace)/vessel/drafts/page.tsx` | Vessel Order Drafts workspace for Admin copy/assignment |
| `tests/standalone/order-draft-record.test.mjs` | 7 pure tests: exact layout, dates/shifts, missing-field blocking, review mapping |
| `docs/PROJECT_KNOWLEDGE.md` | Permanent project map: layout, feature-to-file, APIs, workflows, DB, env, issue queue, resolved history |
| `docs/VESSEL_ORDER_DRAFT.md` | Order-draft root cause, live production evidence, implemented stage, transport options and rollback |
| `NEXT-HANDOFF.md` | Session handoff: image digests, clone/production/live evidence, tests, blockers, GO/NO-GO deployment command |
| `docs/PHASE3_GO_NO_GO_7da17f1.md` | GO/NO-GO decision record: evidence, compatibility, risks, deploy/rollback commands, post-deploy checks, sign-off request |
| `tests/standalone/history-extraction.test.mjs` | Cash payment-block parser tests |
| `db/standalone/010_vessel_draft_delivery.sql` | Inert WA-01 vessel draft-delivery queue (recovered from `3e0dd01`; not activated) |
| `db/standalone/011_cash_payment_events.sql` | Append-only Business Paid Events, corrections/reversals and financial posting link |
| `lib/standalone/finance.ts` (`insertBusinessPaidEvent`, `correctBusinessPaidEvent`, `reverseBusinessPaidEvent`) | Business Paid write/correction/reversal services; never writes the ledger |
| `tests/standalone/cash-paid-events.test.mjs` | 12 tests: single-mobile, WhatsApp automatic Paid, Office Paid, replay/concurrency, flag, reporting, append-only, no ledger |
| `tests/standalone/migration-integrity.test.mjs` | 5 tests: 010→011 order/checksums, schema, indexes, constraints, idempotent re-apply |
| `AGENTS.md` | Non-negotiable Cash/WhatsApp/Paid-vs-POSTED/migration invariants |
| `app/(workspace)/cash/paid/page.tsx` | Business Paid list route |
| `app/(workspace)/cash/paid/[id]/page.tsx` | Business Paid detail, evidence, posting status, correction/reversal history, audit |
| `components/standalone/business-paid-view.tsx` | Server-rendered Paid list with filters, totals, source/evidence/detail links |
| `tests/standalone/business-paid-api.test.mjs` | List/detail filters, event_id, totals, posting link, RBAC/flag gate |
| `docs/PHASE3_PRODUCTION_RELEASE_AUDIT_20261108.md` | Read-only production baseline, verified backup, production-copy rehearsal, auth/UI evidence, historical impact, cutover and rollback runbook |
| `docs/PHASE3_GIT_COMPLETENESS_AUDIT.md` | Branch/worktree/commit completeness audit, canonical dirty-file assessment, file-level matrix |
| `docs/MIGRATION_010_VESSEL_DRAFT_DELIVERY.md` | Migration 010 SQL, draft workflow, exact template, delivery status and completion matrix |
| `docs/MIGRATION_011_CASH_PAYMENT_EVENTS.md` | Migration 011 SQL, Business Paid pipeline, API/UI, historical coverage and activation readiness |
| `lib/vessel-draft-delivery-worker.ts` | Default-disabled queue worker: gate check, claim, prepare, send, persist outcome, health/status |
| `lib/vessel-draft-transport.ts` | Narrow WA-01 MCP `send_message` adapter; mock-tested, production gate OFF |
| `tests/standalone/vessel-draft-delivery-worker.test.mjs` | 5 worker/transport tests: send, retry/backoff, terminal unknown, disabled gate, adapter mapping |
| `phase3-implementation-plan.md` | Corrected implementation record (was a proposal) |
| `phase3-technical-decision-report.md` | Corrected final design and evidence |
| `app/api/assistant/route.ts` | Admin assistant/draft/applicant/order API |
| `compose.phase3.yaml` | Production override for `alrifai_v2_phase3` and flags off |

## Modified files (highlights)

| Path | Change |
|---|---|
| `lib/standalone/finance.ts` | Full lifecycle, reversal, reconciliation, candidate→instruction, audit atomicity; Phase 3 Business Paid Events, single-mobile payout, strict method/identity, posting link, Business Paid detail service |
| `lib/history-extraction.mjs` | Cash parser: single-mobile rule, hyphenated numbers, multi-line blocks, `(C)/(R)/BANK`, amount variants, no fabricated method |
| `lib/message-router.ts` | Processes all clean Cash blocks; WhatsApp automatic Business Paid at the authorized routing point |
| `lib/standalone/cash-dashboard.ts` | Flag-gated Business Paid reporting union with legacy POSTED; business detail list with event/posting/employee fields; Dhaka timestamp helper; lazy timezone binding |
| `app/api/finance/route.ts` | Business Paid list/detail resources and correction/reversal actions |
| `scripts/standalone/install.mjs` | Fresh install includes 010/011 and verifies the new tables |
| `scripts/standalone/grants.mjs` | Append-only grants for Business Paid tables; read-write grant for the inert vessel queue |
| `lib/standalone/review.ts` | Client-aware review application, transaction-aware audit |
| `lib/standalone/programs.ts`, `employees.ts`, `attendance.ts` | Client-aware writers + capability enforcement; `getProgram()` returns `start_date`/`end_date` as ISO text (fixes `[object Date]` 500); `assignEscort` resolves the directory `preferred_name`; `updateEmployee` patch verified |
| `lib/standalone/audit.ts` | Transaction-aware `recordAudit` |
| `lib/standalone/whatsapp.ts` | Correct conflict target, type narrowing, capability checks |
| `lib/message-router.ts` | System actor for automated writes; capability-safe routing; `matchUnstructuredReleaseCandidates()` read-only program matching; enriched pending release-evidence payloads; TRANSFER review category |
| `lib/review-ui.ts` | Review field labels incl. cancel date/shift, total days, food bill (paisa); merges `payload.extractedFields` into the detail view |
| `lib/unified-auth-policy.ts` | Explicit full-lifecycle capability matrix |
| `app/api/*` | Capability enforcement, user admin, cash reversal/reconciliation |
| `components/standalone/action-form.tsx` | Optional `method` prop; uses pure `buildActionFormRequest()` |
| `app/(workspace)/cash/page.tsx` | Candidate decisions, reversal, reconciliation, audit links; all privileged forms capability-gated |
| `app/(workspace)/settings/page.tsx` | Super Admin user administration; account/relay forms capability-gated |
| `app/(workspace)/vessel/page.tsx` | Program register; assign/release/void forms capability-gated |
| `app/(workspace)/employees/[mobile]/page.tsx` | Update employee form uses `method="PATCH"` (previously POST, never applied) |
| `app/(workspace)/payroll/page.tsx` | Configure-rate form capability-gated with `payroll.manage` |
| `app/(workspace)/vessel/drafts/page.tsx` | Admin-visible draft delivery status panel (graceful when migration 010 absent) |
| `scripts/standalone/install.mjs` | Additive `--force`, migrations 008/009/**010**, shared grants |
| `scripts/standalone/grants.mjs` | Runtime grant for `vessel_draft_deliveries` |
| `.github/workflows/ci.yml` | Base-table expectation 46 → 47 (additive layer 010) |
| `tests/standalone/reset.mjs`, `message-router.test.mjs`, `router-cutover.test.mjs` | TRUNCATE lists include `vessel_draft_deliveries` (FK to `programs`) |
| `.github/workflows/ci.yml` | Full suite, Cash/users job, schema `1.4.0` validation |
| `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` | Test commands, patched dependencies, audit overrides |
| `README.md`, `DEVELOPER_START_HERE.md`, release/rollback docs | Current-state and release documentation |

## Delivery boundary

- `feature/phase3-integration` contains both router/vessel and cash/Paid work;
  code, migrations, API/UI, tests and documentation remain isolated.
- Production **runs `phase3-ai-rc-7da17f1`**; no production container, data,
  permission or feature flag was changed by this integration branch.- `.env` `ALRIFAI_TAG` remains aligned to `7da17f1`; previous tag backup intact.
- Authentication pipeline diagnosed as **healthy**; authenticated production UI
  remains NOT TESTED because the Agent has no plaintext password/session cookie.
- **NO MIGRATION APPLIED to production.** Additive `010` and `011` are tested on
  disposable databases only.
- Outbound WhatsApp delivery stays `MANUAL_COPY_ONLY`; no `messages.send` was
  enabled, no message sent, `applyConfirmation()` untouched.
- Owner approval is required before any merge to `main`, deploy, migration or
  outbound activation.
