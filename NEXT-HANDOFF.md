# NEXT-HANDOFF

**Session ended:** 2026-11-07
**Read first:** `docs/PROJECT_KNOWLEDGE.md`, `docs/VESSEL_ORDER_DRAFT.md`,
`docs/LEGACY_PHASE3_COMPARISON.md`, `docs/PRODUCTION_URLS.md`.

---

## Current versions

| Item | Value |
|---|---|
| Production runtime | `local/al-rifai-platform:phase3-ai-rc-86d659a` (digest `sha256:932ef856…`) |
| Candidate (built, tested, **not deployed**) | `local/al-rifai-platform:phase3-ai-rc-9e85e49` (digest `sha256:cb8de252663fc04462eacf23a8eb1bbd39fe3af6a2a81230cdf3fa43a26075a0`) |
| Git `main` | includes docs merge `9fcc2e7`; runtime release `86d659a` |
| Worktree / branch | `/opt/al-rifai-phase3-test`, `feature/phase3-router-cash-vessel` at `9e85e49` |
| Tags | `v2.6.1-vessel-drafts` (also `v2.5.1-legacy-pages`, `v2.6.0-vessel-drafts`) |
| Database schema | `1.5.0` |
| Compose project | `al-rifai-phase3` |

## What works (verified)

- `https://app.al-rifai.iamazim.com/api/health` → `ok`, DB `ok`, schema `1.5.0`.
- `https://alrifai.iamazim.com` reaches the origin (no `ORIGIN_DENIED`); login returns 401 until credentials exist.
- Production data: 218 employees, 94 programs, 439 attendance, 1,586 POSTED cash (85,225,900 minor), 2,221 REVIEW, 1,586 postings.
- Live Cash: 8 authorized Admin→Accountant messages produced 8 REVIEW instructions (335,000 minor), all sender-authorized, zero duplicates, zero postings.
- Router: enabled, cuts over at `wa-01=19634`, `wa-02=15184`; 9 WA-01 business chats allowlisted; WA-02 none.
- Candidate UI: all 32 authenticated routes return 200 on the isolated clone, including `/vessel/drafts`, program detail and review detail.
- Owner draft: exact layout, blanks preserved, missing-field blocking, copy-only.
- Unit tests 104/104, integration 120/120, typecheck clean, lint 0 errors, production build passes.

## What was changed this session

1. **Vessel order-draft stage implemented** (`1f73709`):
   - new `lib/order-draft-from-record.ts`
   - `renderOwnerDraftFields()` in `lib/order-draft-template.ts`
   - new `/vessel/drafts` page, `OwnerDraftPanel`, `CopyDraftButton`
   - draft shown on program detail and PROGRAM review detail
   - nav entry “Order Drafts”
   - unit tests `tests/standalone/order-draft-record.test.mjs`
2. **Vessel program detail 500 fixed** (`9e85e49`): `getProgram()` now returns
   `start_date`/`end_date` as ISO text instead of `Date` objects.
3. **Permanent knowledge base created**: `docs/PROJECT_KNOWLEDGE.md`.
4. **Root-cause document created**: `docs/VESSEL_ORDER_DRAFT.md`.

No production data, DNS, credentials, bridges, checkpoints, allowlists or
permissions were changed. No migration was added or applied.

## What was tested

- Pure draft tests: exact layout, destination handling, blank escort fields,
  missing required field, date/shift normalisation, review payload mapping,
  timestamp-vs-record equivalence.
- Clone fixture: one DRAFT program and one PROGRAM review item rendered the
  expected template; both fixtures were deleted after verification.
- Full authenticated route matrix: 32/32 HTTP 200 on image `9e85e49`.
- Full unit + integration suites, typecheck, lint, build.
- Production read-only snapshot and live Cash evidence.

## What remains broken or unverified

1. **Production logins unverified.** The three password files are still 0 bytes
   (re-checked 2026-11-07). No authorized production session exists; do not
   claim authenticated UI verification in production.
2. **Vessel draft delivery.** The platform cannot send the draft to WhatsApp.
   Current mode is `MANUAL_COPY_ONLY`. Automatic delivery needs Owner approval
   and a narrow WA-01 send capability.
3. **Unstructured release messages.** Six PROGRAM review items are
   `EXTRACTION_FAILED` / `RELEASE_UNSTRUCTURED` (ship cancellation, food bills,
   free text). They are not parsed and do not update programs.
4. **`al-rifai.iamazim.com` 1014.** CNAME points to a foreign Cloudflare account.
   Needs Owner DNS choice A or B; no change made.
5. **Candidate not deployed.** Production lacks `/vessel/drafts` and the date fix.
6. **Legacy-only features** remain unmapped: site settlements, reconciliation
   workspace, Excel cashbook, public site/signup, platform release review.

## Resolved issues removed from the active queue

- Generic legacy redirects → 19 independent pages.
- `created_at.slice` 500 on nested employee route.
- `[object Date]` 500 on vessel program detail.
- Legacy-host `403 ORIGIN_DENIED`.
- Login lockout diagnostic rows for `Admin`/`owner`.
- Admin/user provisioning now explicit CLI, not startup reset.

## Issue priority order

1. Production credentials + authenticated verification.
2. Vessel draft transport decision (manual vs approved outbound).
3. Unstructured release/cancel parsing.
4. Cloudflare 1014 for `al-rifai.iamazim.com`.
5. Candidate deployment approval.
6. Legacy table/feature migration decisions.
7. Cosmetic/legacy UI parity (typeahead, charts).

## Database migration status

- Production schema `1.5.0`; verified after the previous deploy.
- This session added **no migration**.
- Do not run migrations without Owner approval.
- Latest verified pre-import backup:
  `phase3-pre-import-20261106T224024Z.dump`
  SHA-256 `83dfe6d0284a1f16d1109aee0cb0b29273bbc3a739955194bada2fd8c8daaad9`.

## Git / push status

- `main` includes docs merge `9fcc2e7` (docs commit `81c376c`) pushed to `origin`.
- `feature/phase3-router-cash-vessel` `9e85e49` pushed.
- Tags `v2.6.0-vessel-drafts`, `v2.6.1-vessel-drafts` pushed.
- No uncommitted deploy; no force-push.

## Exact next task and starting files

1. Check `ls -l /etc/vps/apps/al-rifai/*-password`; if non-empty, run:
   ```bash
   cd /opt/al-rifai-platform
   PGHOST=172.18.0.2 PGDATABASE=alrifai_v2_phase3 \
     node --env-file=/opt/vps/al-rifai-standalone/apps/al-rifai/.env \
     --experimental-strip-types scripts/standalone/provision-admin.mjs
   PGHOST=172.18.0.2 PGDATABASE=alrifai_v2_phase3 \
     node --env-file=/opt/vps/al-rifai-standalone/apps/al-rifai/.env \
     --experimental-strip-types scripts/standalone/provision-users.mjs
   ```
   Do not reset passwords without explicit approval.
2. If valid, verify real login, roles and read-only Cash/Vessel/Employee/
   Attendance/Reports pages; then request approval to deploy `9e85e49`.
3. Deployment command (only after approval):
   ```bash
   cd /opt/al-rifai-platform
   ALRIFAI_TAG=phase3-ai-rc-9e85e49 docker compose \
     --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
     -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
   ```
4. Then verify `/api/health`, schema `1.5.0`, `/vessel/drafts`, a program detail,
   review detail, and checkpoint advancement.
5. Start files for the next feature: `lib/release-slip.ts`,
   `lib/message-router.ts` (`handleReleaseSlip`), `docs/VESSEL_ORDER_DRAFT.md`.
