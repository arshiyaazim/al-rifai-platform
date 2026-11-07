# Business workflow backlog — 2026-11-07

**Priority rule:** make existing business features work reliably before adding
new features. This file records what was verified/fixed this session and what
remains. It does not authorise production data changes.

**Migration status:** **NO MIGRATION** for every fix listed here.

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

All fixes are on `feature/phase3-router-cash-vessel`. Fixes 5–7 are **not in
the deployed image `7da17f1`**; they are implemented and tested in isolation
and require a new candidate + Owner approval before deployment. Fixes 1–4 are
in `7da17f1` and are **production-deployed**.

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
| 1 | Production authentication | Three accounts exist but password files are 0 bytes; authenticated production UI verification impossible | Owner supplies secrets via `set-secret-password.mjs`, then check-only provisioners | `docs/ADMIN_AUTH.md`, `scripts/standalone/provision-*.mjs` |
| 2 | Vessel Draft delivery | Outbound transport not enabled (correctly gated) | Owner approves exact sender/recipient/account/chat scope/behavior; then apply the WA-01-safe migration and narrow token | `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`, `lib/vessel-draft-delivery.ts` |
| 3 | Vessel release + attendance workflow | Attendance is recorded manually; there is no automatic link between a released program and duty attendance | Define the explicit link (no automation without approval); keep both workflows readable/auditable | `lib/standalone/attendance.ts`, `lib/standalone/programs.ts` |
| 4 | Program pay + payroll | `program_pay` can be `UNRESOLVED` when no rate is configured; salary is derived from released duty only | Verify unresolved cases read-only; add report of unresolved reasons; no auto-calculation changes | `lib/standalone/payroll.ts`, `app/(workspace)/payroll/page.tsx` |
| 5 | Legacy Cashbook / archive | Excel cashbook and legacy archive views are table substitutes | Owner decision on parity; do not redesign | `docs/LEGACY_PHASE3_COMPARISON.md` |
| 6 | Reconciliation / site settlements | Site settlements and the legacy reconciliation workspace are not migrated | Separate Owner-approved mapping | `docs/LEGACY_PHASE3_COMPARISON.md`, `lib/standalone/finance.ts` |
| 7 | Missing employee / transaction UI | Legacy employee typeahead, add-transaction drawer and charts are not reproduced | Decide whether to reimplement; low priority | `app/(workspace)/employees/`, `app/(workspace)/transactions/` |
| 8 | Historical release items | 7 items remain pending for human decision | Manual review in `/review`; do not auto-apply | `docs/HISTORICAL_RELEASE_REVIEW_20261107.md` |
| 9 | `al-rifai.iamazim.com` | Cloudflare 1014 (HTTP 403 body) | Owner DNS decision | `docs/DNS_CLOUDFLARE_1014.md` |
| 10 | Git sync | `main` `0861e05` does not contain the code fixes | Merge `feature/phase3-router-cash-vessel` after deployment | — |

## 4. Explicitly out of scope

- Resetting production credentials or creating replacement accounts.
- Enabling `messages.send`, widening bridge permissions or sending WhatsApp.
- DNS / Cloudflare / TLS changes.
- Production migrations, historical imports, retroactive program/payment/Cash
  updates, or restoring a database backup to roll back application code.
- Unrelated feature development or UI redesigns.
