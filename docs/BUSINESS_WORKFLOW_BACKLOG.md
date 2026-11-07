# Business workflow backlog — 2026-11-07

**Priority rule:** make existing business features work reliably before adding
new features. This file records what was verified/fixed this session and what
remains. It does not authorise production data changes.

**Migration ledger:** production `schema_meta` `1.5.0`, `schema_migrations` max
`009` — **NO MIGRATION APPLIED**. Pending additive layer
`010_vessel_draft_delivery.sql` (one table + 4 indexes) is written, applied and
rolled back on a disposable clone of the exact production schema, and **NOT
applied to production**. It requires 8 explicit Owner approvals
(`docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §7).

---

## 1. Fixed this session (safe, independently testable)

| # | Area | Defect | Fix | Test |
|---|---|---|---|---|
| 1 | Cash / Settings / Vessel UI | USER saw privileged forms that return 403 | Capability-gate forms (`cash.review`, `cash.post`, `cash.ledger`, `cash.account.manage`, `whatsapp.manage`, `whatsapp.route`, `vessel.command`, `vessel.release`, `review.decide`) | Clone role matrix; 6 privileged API actions 403 |
| 2 | Vessel assignment | `assignEscort` stored the mobile number as `escort_name` when only a mobile was given | Resolve the employee directory `preferred_name`; explicit name still wins | `domain.test.ts` |
| 3 | Release / cancel / food bill | Unstructured release-group messages produced opaque `RELEASE_UNSTRUCTURED` items | Pure `parseUnstructuredRelease()` + read-only `matchUnstructuredReleaseCandidates()` + enriched pending review payload | `release-slip.test.mjs`, `message-router.test.mjs` |
| 4 | Historical classification | Transfer messages ("boarded another vessel") were only marked cancellation | Added `TRANSFER` kind and `RELEASE_TRANSFER_CANDIDATE`; both kinds retained | `historical-release-review.test.mjs`, router integration test |
| 5 | **Employee update UI** | "Update employee" form always POSTed to `/api/employees`, which only creates/stages a CREATE — the update never applied | `ActionForm` now accepts an optional `method` (`POST` default, `PATCH`/`DELETE`); employee detail uses `method="PATCH"` and hits the existing PATCH handler | `action-form-request.test.mjs`, `domain.test.ts` (`updateEmployee` patch + capability) |
| 6 | **Payroll UI** | "Configure a rate" was shown to USERs although `/api/payroll` requires `payroll.manage` | Gate with `can(user,'payroll.manage')` | Clone role verification |
| 7 | **Vessel Draft delivery** | No internal queue/idempotency/gate for the missing transport stage | Pure `lib/vessel-draft-delivery.ts` + 12 tests + design doc | `vessel-draft-delivery.test.mjs` |
| 8 | **Production `.env`** | `.env` recorded `86d659a` while production ran `7da17f1`; a bare Compose command would roll back | Owner-approved single-line change to `ALRIFAI_TAG=phase3-ai-rc-7da17f1`; backup, config verification, containers untouched | `docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md` |
| 9 | **Authentication diagnosis** | Reported `400 CREDENTIALS_REQUIRED` was assumed to mean invalid hashes | Full read-only trace: empty-password requests, provisioning-only secrets, valid hashes, 6 successful logins, 2 live sessions, both hosts route auth correctly. **No defect, no credential change** | `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md` |
| 10 | **Durable Vessel Draft delivery** | Only a pure, in-memory queue existed | Postgres store + migration 010 + Admin status UI: idempotent records, SKIP LOCKED claim, retry/backoff, `DELIVERY_UNKNOWN`, restart recovery, audit trail, gate | 8 store integration tests, migration clone test, dev-server UI check |

All code is on `feature/phase3-router-cash-vessel`. Fixes 5–7 and 10 are **not
in the deployed image `7da17f1`**; they are implemented and tested in isolation
and require a new candidate + Owner approval before deployment. Fixes 1–4 are
in `7da17f1` and are **production-deployed**. Fix 8 is a production config
change (Owner-approved, no container change); fix 9 is diagnosis only.

### Clone verification of fixes 5–7 (image `phase3-ai-rc-675a3ef`)

- Payroll: ADMIN sees "Configure a rate" / "Save rate"; USER sees neither; both
  pages return 200.
- Employee detail: the RSC payload contains `method:"PATCH"` for the update
  form. A real `PATCH /api/employees` on the clone changed
  `preferred_name`/`designation`/`notes`/`state` and returned `revision: 2`;
  the temporary employee and its audit rows were deleted afterwards.
- `TRANSFER`: staging the exact item #7 text in the clone release group produced
  `RELEASE_TRANSFER_CANDIDATE` with `evidenceKinds=["CANCELLATION","TRANSFER"]`,
  `lighterVessel="Othoi"` and candidate program
  `lgcy-prg-b61591e0…`, with no program change; fixture removed.
- 19 Admin routes return 200 on the verification image.
- Production was **not** changed by any of these tests.

## 2. Verified working (clone-tested on `7da17f1`)

- Cash REVIEW → APPROVED → POSTED → reversal; reconciliation; ledger.
- Vessel DRAFT → draft UI → Admin reply → `CONFIRMED`; structured release slip →
  `RELEASED`; ambiguous slip → review, never released.
- Employees / Attendance / Payroll read views and CSV exports.
- 17 independent legacy routes, search, filters, pagination.
- USER/ADMIN capability boundaries on every state-changing API.

## 3. Remaining gaps, in priority order

| # | Area | Gap | Proposed next step | Starting files |
|---|---|---|---|---|
| 1 | Production authentication | Auth pipeline is healthy but the Agent has no plaintext password / production session cookie; authenticated UI NOT TESTED | Owner writes root-only `/etc/vps/apps/al-rifai/verification-credentials.json`; Agent reads without printing, verifies, deletes. **Never reset** | `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`, `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` |
| 2 | Vessel Draft delivery | Outbound transport not enabled (correctly gated); 8 approvals pending including migration 010 | Owner approves exact sender/recipient/account/chat scope/template/trigger/retry/migration/live+rollback plan | `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §5–§7, `lib/standalone/vessel-draft-delivery-store.ts` |
| 3 | Deploy current branch code | `675a3ef` + Task 4 code (employee PATCH, payroll gating, TRANSFER, durable delivery UI) not deployed | Fresh backup + new candidate + Owner approval; rollback `7da17f1` | `NEXT-HANDOFF.md` |
| 4 | Vessel release + attendance workflow | Attendance is recorded manually; there is no automatic link between a released program and duty attendance | Define the explicit link (no automation without approval); keep both workflows readable/auditable | `lib/standalone/attendance.ts`, `lib/standalone/programs.ts` |
| 5 | Program pay + payroll | `program_pay` can be `UNRESOLVED` when no rate is configured; salary is derived from released duty only | Verify unresolved cases read-only; add report of unresolved reasons; no auto-calculation changes | `lib/standalone/payroll.ts`, `app/(workspace)/payroll/page.tsx` |
| 6 | Legacy Cashbook / archive | Excel cashbook and legacy archive views are table substitutes | Owner decision on parity; do not redesign | `docs/LEGACY_PHASE3_COMPARISON.md` |
| 7 | Reconciliation / site settlements | Site settlements and the legacy reconciliation workspace are not migrated | Separate Owner-approved mapping | `docs/LEGACY_PHASE3_COMPARISON.md`, `lib/standalone/finance.ts` |
| 8 | Missing employee / transaction UI | Legacy employee typeahead, add-transaction drawer and charts are not reproduced | Decide whether to reimplement; low priority | `app/(workspace)/employees/`, `app/(workspace)/transactions/` |
| 9 | Historical release items | 7 items remain pending for human decision | Manual review in `/review`; do not auto-apply | `docs/HISTORICAL_RELEASE_REVIEW_20261107.md` |
| 10 | `al-rifai.iamazim.com` | Cloudflare 1014 (HTTP 403 body) | Owner DNS decision | `docs/DNS_CLOUDFLARE_1014.md` |
| 11 | Git sync | `main` `0861e05` does not contain the code fixes | Merge `feature/phase3-router-cash-vessel` after deployment | — |

## 4. Explicitly out of scope

- Resetting production credentials or creating replacement accounts.
- Enabling `messages.send`, widening bridge permissions or sending WhatsApp.
- DNS / Cloudflare / TLS changes.
- Production migrations, historical imports, retroactive program/payment/Cash
  updates, or restoring a database backup to roll back application code.
- Unrelated feature development or UI redesigns.
