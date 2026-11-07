# NEXT-HANDOFF

**Session ended:** 2026-11-07 (second session — deployment + workflow completion)
**Read first:** `docs/PHASE3_GO_NO_GO_7da17f1.md`,
`docs/PHASE3_PREDEPLOY_BACKUP_20261107.md`, `docs/PROJECT_KNOWLEDGE.md`,
`docs/BUSINESS_WORKFLOW_BACKLOG.md`, `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`,
`docs/HISTORICAL_RELEASE_REVIEW_20261107.md`, `docs/PRODUCTION_URLS.md`.

**Report language:** English only. Always state whether a finding is
**implemented**, **clone-tested**, **production-deployed** or **live-verified**.

---

## Current versions

| Item | Value |
|---|---|
| **Production runtime (DEPLOYED)** | `local/al-rifai-platform:phase3-ai-rc-7da17f1`, digest `sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa` |
| Rollback image (available) | `local/al-rifai-platform:phase3-ai-rc-86d659a`, digest `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5` |
| Superseded candidate | `phase3-ai-rc-9e85e49`, digest `sha256:cb8de252…` |
| Verification image (built, **NOT deployed**) | `phase3-ai-rc-675a3ef` — contains the post-deployment workflow fixes |
| Git `main` | `0861e05` (clean; does **not** contain the code fixes) |
| Working tree / branch | `/opt/al-rifai-phase3-test`, `feature/phase3-router-cash-vessel` at `675a3ef`, pushed, clean |
| Database schema | `1.5.0`; **NO MIGRATION** in either image |
| Compose project / env | `al-rifai-phase3`; `.env` still records `ALRIFAI_TAG=phase3-ai-rc-86d659a` (overridden by command line at deploy) |
| Clone | `alrifai-ui-check` on `127.0.0.1:3007`, DB `alrifai_v2_import_test` |

## What changed this session

1. **Fresh production backup** (`docs/PHASE3_PREDEPLOY_BACKUP_20261107.md`):
   `phase3-predeploy-7da17f1-20261107T124612Z.dump`, 8,864,137 bytes,
   SHA-256 `61c73a1a29e0f96b30dc62a0f45d778a19471a87f6d185984b3c4ca68ebb48aa`.
   `pg_restore -l` valid; **full restore into a disposable DB passed** with exact
   schema/count/checkpoint match; scratch DB dropped; previous backups preserved.
2. **GO/NO-GO safety report** (`docs/PHASE3_GO_NO_GO_7da17f1.md`), then
   **explicit Owner approval ("Approve deployment (GO)")**.
3. **Deployed `7da17f1`** by recreating only `app` + `sync`:
   `ALRIFAI_TAG=phase3-ai-rc-7da17f1 docker compose ... up -d app sync`.
   No migration, no import, no backup restore, no bridge/DNS/credential change.
4. **Vessel Draft delivery internal work** (`ed78ec2`): pure
   `lib/vessel-draft-delivery.ts` — idempotency, queue, bounded retry, terminal
   states, five-block gate, prepared-but-never-executed outbound request,
   confirmation invariant; 12 isolated tests + design/activation-gate doc.
   **Outbound stays disabled.**
5. **Historical release review** (`d533939`): added `TRANSFER` classification,
   regression tests pinned to all seven exact production texts, a router
   integration test, and a per-item analysis with read-only candidate program
   matches. **No production program, release, payment or Cash change.**
6. **Business workflow fixes** (`675a3ef`): employee "Update employee" now uses
   `PATCH` (previously always POST, so the update never applied); payroll rate
   form capability-gated; pure `buildActionFormRequest()` + tests; domain test
   for `updateEmployee`; reprioritised backlog.
7. Documentation, Git commits and pushes after each logical change.

## Deployment verification (live-verified, read-only)

- Both containers recreated on `7da17f1`; app `healthy`; image digest matches.
- `/api/health` on `app.al-rifai.iamazim.com` and `alrifai.iamazim.com` →
  `{"status":"ok","database":"ok","schemaVersion":"1.5.0"}`; `schema_meta` `1.5.0`.
- Business counts **identical** before/after: 218 employees, 102 programs
  (8 DRAFT), 439 attendance, 3,817 cash instructions (2,231 REVIEW),
  1,586 cash postings, 13 review items (all pending), 34,595 WhatsApp messages,
  83 COMPLETED / 0 PROCESSING / 0 FAILED.
- Sync checkpoints preserved `wa-01=19730`, `wa-02=15243`; router worker
  restarted (`interval=5000ms`) with no duplicate processing; no release-related
  failure, so **rollback was not executed**.
- `/vessel/drafts` route exists (401 unauthenticated); legacy routes still
  present on the deployed image.

## Production authenticated UI — exact blocker

Task 3 could **not** be completed. The three production accounts exist with the
correct roles (`Admin` ADMIN, `officeassistant` USER, `officeazzistant2` USER,
all active), but:

- `/etc/vps/apps/al-rifai/{admin-bootstrap-password,user-1-password,user-2-password}`
  are **0 bytes**, mode `400 root:root`.
- Check-only `provision-admin.mjs` / `provision-users.mjs` report
  `password_configured: false`, `password_source: missing`,
  `password_matches: null`, `apply: false`. No account or password was changed.
- Login attempts using those sources on both hosts returned
  `400 {"error":"CREDENTIALS_REQUIRED"}` for all three usernames; no throttle
  rows were created.
- Therefore **login, logout, sessions, role permissions, every authenticated
  page/form/table/CSV/approval workflow is NOT TESTED in production**.
  Unauthenticated surfaces are VERIFIED (health 200, `/login` 200, protected
  pages 307→/login or 401, `/vessel/drafts` route present).
- Do not reset credentials, create replacement accounts or change roles.

Full per-feature matrix: `docs/PHASE3_GO_NO_GO_7da17f1.md` §"Authenticated UI".

## Vessel Draft delivery — remaining authorization gate

Implemented (clone/unit-tested): pure queue, idempotency key
`vdd_<sha256(programId + sha256(draft text) + recipientJid)>`, dedup, 3-attempt
backoff, `SENT`/`DELIVERY_UNKNOWN` terminal, no auto-retry on ambiguity,
five-block gate, prepared outbound request, UI view model.

**Not enabled:** no `messages.send` capability exists in either bridge policy;
`AI_*` flags remain `0`; no WhatsApp message was sent; no migration applied;
`MANUAL_COPY_ONLY` remains the delivery mode. WA-01 is the only viable sender,
WA-02 is identity-read only and its outbound tables are WA-02-only.

Owner must separately approve the exact sender, recipient, account, chat scope
and delivery behavior, plus the WA-01-safe durable-table migration, before §5
of `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` can be activated.

## Seven historical review items

All classified, all preserved `PENDING`, **no production changes**:

| # | Kind | Candidate program |
|---|---|---|
| 1, 3, 6 | `EMPTY` | none — manual review |
| 2 | `FOOD_BILL` (`195000` paisa) | `lgcy-prg-6460107a…` (`Poavosa-Wisdom / Deowan-Jobayer-1`) |
| 4 | `REPLACEMENT` | same `lgcy-prg-6460107a…` |
| 5 | `CANCELLATION` + `FOOD_BILL` | same; lighter name differs by `-1` → ambiguous |
| 7 | `TRANSFER` + `CANCELLATION` | `lgcy-prg-b61591e0…` (`Union-Odyssey / Othoi-1`) |

Details: `docs/HISTORICAL_RELEASE_REVIEW_20261107.md`.

## Test evidence

- Unit **133/133**, integration **125/125**, focused new tests **34/34**.
- `tsc --noEmit` clean; lint 0 errors (3 pre-existing warnings).
- Production Docker build passes for `7da17f1` and `675a3ef`.
- Backup restore test passed; production unchanged.
- Clone role matrix and 17 legacy routes re-verified.

## Issue priority order

1. Owner-supplied production credentials → authenticated UI verification.
2. Owner decision on Vessel Draft outbound transport (sender/recipient/scope).
3. Manual review of the 7 historical items.
4. Decide whether to build/deploy a candidate containing `675a3ef` fixes
   (employee PATCH, payroll gating, TRANSFER classification) — **not deployed**.
5. Vessel release ↔ attendance linkage; program pay / payroll unresolved cases.
6. Legacy Cashbook/archive, reconciliation and site settlements mapping.
7. `al-rifai.iamazim.com` Cloudflare 1014 (Owner DNS decision).
8. Merge feature branch into `main`.
9. Low-priority legacy UI parity (typeahead, charts).

## Database / WhatsApp / credential safety

- **NO MIGRATION** in `7da17f1` or `675a3ef`; production `schema_meta` `1.5.0`.
- No production business record changed; counts identical before/after deploy.
- No backup restore was used to roll back application code.
- Bridge containers, sessions, checkpoints, allowlists, cutover watermarks,
  processing state and DNS untouched.
- No credential reset, no new production account, no role change, no secret in Git.

## Git / push status

- `main` `0861e05` clean, not merged.
- `feature/phase3-router-cash-vessel` `675a3ef` pushed to `origin`; clean.
- Image `7da17f1` built from commit `7da17f1`; image `675a3ef` built from
  `675a3ef`. Neither branch state was force-pushed.

## Exact next task and starting files

1. If the Owner supplies credentials, run the check-only provisioners, then
   perform the full authenticated production UI matrix on the **deployed**
   `7da17f1` (login/logout/session/roles, Cash, Vessel, Drafts, program detail,
   employees, attendance, reports, review, income/expenditure, CSV, filters,
   approval workflows — read-only in production, state-changing tests on clone).
   Start: `docs/ADMIN_AUTH.md`, `docs/PHASE3_GO_NO_GO_7da17f1.md` §"Authenticated UI".
2. If the Owner approves a further release, build/deploy the `675a3ef` content
   with a fresh backup and the same Compose command; rollback stays `7da17f1`.
3. For outbound delivery: `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`,
   `lib/vessel-draft-delivery.ts`, `lib/order-draft-from-record.ts`.
4. For historical decisions: `/review` UI, `docs/HISTORICAL_RELEASE_REVIEW_20261107.md`.
5. For workflow backlog: `docs/BUSINESS_WORKFLOW_BACKLOG.md`.
