# NEXT-HANDOFF

**Session ended:** 2026-11-07
**Read first:** `docs/PROJECT_KNOWLEDGE.md`, `docs/VESSEL_ORDER_DRAFT.md`,
`docs/PRODUCTION_URLS.md`, `docs/LEGACY_PHASE3_COMPARISON.md`.

**Report language:** English only. Always state whether a finding is
**clone-tested**, **production-deployed** or **live-verified**.

---

## Current versions

| Item | Value |
|---|---|
| Production runtime (**deployed**) | `local/al-rifai-platform:phase3-ai-rc-86d659a`, digest `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5` |
| Superseded candidate (**not deployed**) | `local/al-rifai-platform:phase3-ai-rc-9e85e49`, digest `sha256:cb8de252663fc04462eacf23a8eb1bbd39fe3af6a2a81230cdf3fa43a26075a0` |
| **Current candidate (built, clone-tested, NOT deployed)** | `local/al-rifai-platform:phase3-ai-rc-7da17f1`, digest `sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa` |
| Git `main` | `0861e05` (docs merge; does **not** yet contain the three 2026-11-07 code fixes) |
| Working tree / branch | `/opt/al-rifai-phase3-test`, `feature/phase3-router-cash-vessel` at `7da17f1`, pushed to `origin` |
| Tags | `v2.6.0-vessel-drafts`, `v2.6.1-vessel-drafts` |
| Database schema | `1.5.0` (production and clone); **no migration added** |
| Compose project | `al-rifai-phase3`; `ALRIFAI_TAG=phase3-ai-rc-86d659a` in `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` |
| Clone | `alrifai-ui-check` on `127.0.0.1:3007`, DB `alrifai_v2_import_test`, image `7da17f1`, `ALRIFAI_VESSEL_PROCESSING_ENABLED=1`, `PHASE3_ROUTER_WORKER_ENABLED=0` |

## What works — evidence by environment

### Production-deployed, live-verified (read-only, 2026-11-07)

- `https://app.al-rifai.iamazim.com/api/health` →
  `{"status":"ok","database":"ok","schemaVersion":"1.5.0"}`.
- `https://alrifai.iamazim.com` legacy alias → health 200.
- `https://al-rifai.iamazim.com` → HTTP 403 with body `error code: 1014`
  (unchanged cross-account Cloudflare CNAME).
- Production containers `app` and `sync` both run `86d659a`; flags are
  `ALRIFAI_VESSEL_PROCESSING_ENABLED=1`, `PHASE3_ROUTER_WORKER_ENABLED=1`,
  `ALRIFAI_LIVE_CASH_SYNC=0`, all `AI_*` flags `0`.
- Production DB `alrifai_v2_phase3`: 218 employees, 439 attendance,
  102 programs (94 imported + **8 live WHATSAPP DRAFT programs created
  2026-11-07 08:28–10:28 UTC**), 2,231 Cash `REVIEW` instructions,
  1,586 legacy postings, **zero non-legacy postings**, 13 pending review items
  (7 `EXTRACTION_FAILED`, 6 `UNMATCHED_VESSEL_ASSIGNMENT`).
- Router cutover watermarks `wa-01=19634`, `wa-02=15184`; sync checkpoints
  advanced to `wa-01=19728`, `wa-02=15238` during this session — production is
  actively processing above-watermark traffic.
- `ai_outbound_messages`, `ai_outbound_attempts` and `ai_order_drafts` are all
  empty: **no outbound WhatsApp activation**.

> **Live authenticated UI verification in production is still blocked.** The
> three password files in `/etc/vps/apps/al-rifai/` are 0-byte, mode `400`.
> Do not claim it was performed. No credentials were reset.

### Clone-tested on candidate `7da17f1` (isolated DB, all fixtures removed)

- All **29** Admin workspace/legacy routes return HTTP 200 with distinct
  headings and table columns; all 12 checked USER routes return 200.
- Search (`ABM` → 1 row, `ZZZNOMATCH` → 0), state filters, pagination and
  all 7 CSV exports (`text/csv`) work.
- **Role enforcement:** USER gets 403 from `instruction.approve`, `instruction.post`,
  `ledger.create`, `account.create`, `assign`, `release`, `void`, `configure`,
  `route`, `/api/users`; USER still legitimately stages work (`instruction.create`
  201, program `create` 202 pending review). All server-side checks are
  capability-based and remain authoritative.
- **UI gaps fixed:** USER no longer sees privileged Cash approve/reject/post/
  ledger forms, Settings account/relay forms, or Vessel assign/release/void
  forms; ADMIN still sees them.
- **Vessel pipeline end to end:** WA-01 order message → `DRAFT` program with
  Mother Vessel, Lighter Vessel, Master Mobile, Destination, date and shift →
  appears on `/vessel` and `/vessel/drafts` with the exact Owner draft
  (`MANUAL_COPY_ONLY`, blank escort fields) → Admin outgoing reply →
  `applyConfirmation()` → state `CONFIRMED`, escort assigned,
  `confirmation_message_id` recorded. No outbound message was sent.
- **Release/cancel/food-bill evidence:** cancellation, food-bill and empty
  release-group messages produce enriched pending review items
  (`RELEASE_CANCELLATION_CANDIDATE`, `RELEASE_FOOD_BILL_CANDIDATE`,
  `RELEASE_EMPTY_MESSAGE`) with `extractedFields`, `evidenceKinds`,
  `matchedTokens`, `candidateProgramIds` and reasons. Candidate program matching
  is read-only; the matched program stayed `CONFIRMED` — nothing was released,
  voided or posted.
- Review detail renders the new Cancel date/shift, Total days and Food bill
  (paisa) fields.
- All clone fixtures (messages, program, assignments, review items, employee,
  audit rows) were deleted; clone returned to baseline 94 programs, 218
  employees, 0 review items, 3,799 cash instructions.

### Test suites (local, disposable DB `alrifai_v2_test`)

- Unit **110/110** pass (includes 7 new release-evidence tests).
- Integration **123/123** pass (includes 3 new router release tests).
- `tsc --noEmit` clean; lint 0 errors (3 pre-existing warnings).
- Production Docker build passes (`pnpm typecheck && pnpm build` inside the
  image); no schema/migration file changed since `9e85e49`.

## What was changed this session (committed and pushed)

1. `8b9b779` — **UI capability gating**: `app/(workspace)/cash/page.tsx`,
   `settings/page.tsx`, `vessel/page.tsx`. Hides forms whose API would 403;
   no functionality removed, `assertCapability` stays authoritative.
2. `ecdd186` — **Escort name resolution**: `lib/standalone/programs.ts`
   `assignEscortOn()` resolves the directory `preferred_name` when the operator
   supplies only a mobile; explicit names still win. Domain regression added.
3. `7da17f1` — **Unstructured release evidence**: `lib/release-slip.ts`
   (`parseUnstructuredRelease`), `lib/message-router.ts`
   (`matchUnstructuredReleaseCandidates` + enriched review payload),
   `lib/review-ui.ts` (new field labels), plus parser and router regression
   tests. Classifies empty/cancellation/replacement/food-bill traffic, extracts
   vessel/escort/mobile/date/shift/total-day/cancel-date/food-bill evidence,
   matches candidate programs read-only, and keeps every item **pending**.
   It never auto-releases or updates a program.
4. New candidate image `phase3-ai-rc-7da17f1` built and clone-tested.

No production data, DNS, credentials, bridges, sessions, checkpoints,
allowlists, permissions or migrations were changed. Production business data
was read only. The 7 existing `RELEASE_UNSTRUCTURED` production review items
were **preserved for manual review**; the new parser applies to future messages
only and no program update was attempted.

## What remains broken or unverified

1. **Production logins unverified.** Password files still 0 bytes. Requires
   Owner-supplied secrets; do not reset credentials.
2. **Automatic Admin draft delivery.** Not implemented. Mode remains
   `MANUAL_COPY_ONLY`. Needs explicit Owner approval plus a narrow WA-01
   `messages.send` capability and a WA-01-safe durable draft record.
3. **7 existing `RELEASE_UNSTRUCTURED` production items** (3 empty texts,
   1 Ship-Cancaled block, 1 food-bill `1950/-`, 1 replacement/office-car-rent,
   1 `Othoi-Cancaled` transfer). They stay pending for manual review; the
   improved parser does not retroactively rewrite them.
4. **`al-rifai.iamazim.com` 1014** (now surfaced as HTTP 403). Needs Owner
   Cloudflare/DNS decision (Option A/B in `docs/DNS_CLOUDFLARE_1014.md`).
5. **Candidate `7da17f1` not deployed.** Production still lacks
   `/vessel/drafts`, the date fix and all three 2026-11-07 corrections.
6. **Legacy-only features** unmapped: site settlements, reconciliation
   workspace, Excel cashbook, public site/signup, platform release review.

## Resolved issues removed from the active queue

- Generic legacy redirects → 19 independent pages.
- `created_at.slice` 500 on nested employee route.
- `[object Date]` 500 on vessel program detail.
- Legacy-host `403 ORIGIN_DENIED`.
- Login lockout diagnostic rows for `Admin`/`owner`.
- Admin/user provisioning now explicit CLI, not startup reset.
- **UI role gaps** (Cash/Settings/Vessel privileged forms shown to USER).
- **Escort name falling back to a mobile number** on assignment.
- **Unstructured release parsing for future messages** (extraction + read-only
  candidate matching + review evidence, with regression tests).

## Issue priority order

1. Owner decision on deploying candidate `7da17f1` (GO/NO-GO report below).
2. Production credentials + authenticated verification (Owner-supplied).
3. Vessel draft transport decision (manual copy vs approved outbound).
4. Manual review of the 7 legacy `RELEASE_UNSTRUCTURED` items.
5. Cloudflare 1014 for `al-rifai.iamazim.com`.
6. Merge `feature/phase3-router-cash-vessel` into `main` after deployment.
7. Legacy table/feature migration decisions.
8. Cosmetic/legacy UI parity (typeahead, charts).

## Database migration status

- Production schema `1.5.0`; candidate `7da17f1` contains **no schema or
  migration change**. Verified `git diff 9e85e49..HEAD` touches no SQL/migration
  file; both production and clone report `schemaVersion 1.5.0`.
- Do not run migrations without Owner approval.
- Latest verified pre-import backup:
  `/var/lib/vps/al-rifai/backups/phase3-pre-import-20261106T224024Z.dump`
  SHA-256 `83dfe6d0284a1f16d1109aee0cb0b29273bbc3a739955194bada2fd8c8daaad9`.
- Rollback target: `phase3-ai-rc-86d659a`
  (`sha256:932ef856…`), no data restore required for this UI/logic-only change.

## Git / push status

- `main` at `0861e05` pushed; it does **not** include the three code fixes.
- `feature/phase3-router-cash-vessel` at `7da17f1` pushed to `origin`.
- Tags `v2.6.0-vessel-drafts`, `v2.6.1-vessel-drafts` pushed.
- Worktree clean. No force-push, no uncommitted deployment.

## Exact next task and starting files

1. **Owner approval required** before any production deployment. Present the
   GO/NO-GO report (tests, backup, rollback, schema compatibility, legacy
   routes, permissions, deployment command).
2. After approval only, deploy from `/opt/al-rifai-platform`:
   ```bash
   ALRIFAI_TAG=phase3-ai-rc-7da17f1 docker compose \
     --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
     -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
   ```
   Rollback: repeat with `ALRIFAI_TAG=phase3-ai-rc-86d659a`.
3. Post-deploy live checks (read-only): `/api/health`, schema `1.5.0`,
   `/vessel/drafts`, a program detail, a review detail, USER form gating,
   sync checkpoint advancement, and no outbound message rows.
4. If credentials become available, verify real Admin/USER logins and the
   authenticated production UI; otherwise keep that item open.
5. Starting files for further work:
   - `lib/release-slip.ts` (`parseUnstructuredRelease`)
   - `lib/message-router.ts` (`handleVessel` release-group branch,
     `matchUnstructuredReleaseCandidates`)
   - `app/(workspace)/vessel/drafts/page.tsx` (delivery stage)
   - `docs/VESSEL_ORDER_DRAFT.md` (transport options)
   - `docs/PROJECT_KNOWLEDGE.md` (issue queue)
