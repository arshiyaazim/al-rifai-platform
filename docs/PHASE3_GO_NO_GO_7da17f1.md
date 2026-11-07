# Phase 3 — GO/NO-GO report for candidate `phase3-ai-rc-7da17f1`

**Date:** 2026-11-07
**Decision:** **TECHNICAL GO** — the candidate was safe to deploy.
**Owner approval:** **GRANTED** — the Owner explicitly answered
"Approve deployment (GO)" after the Task 1 safety report.
**Deployment status:** **DEPLOYED 2026-11-07** — `app` and `sync` were recreated
on `phase3-ai-rc-7da17f1`; no migration, import, data restore or rollback.

This report intentionally separates three kinds of evidence:
**clone-tested**, **production-deployed** and **live-verified**.

---

## 1. What would change

Image `local/al-rifai-platform:phase3-ai-rc-7da17f1`
(digest `sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa`),
built from commit `7da17f1` on `feature/phase3-router-cash-vessel`.

| Commit | Change |
|---|---|
| `8b9b779` | Capability-gate privileged forms on Cash, Settings and Vessel pages (UI only; server checks unchanged and still authoritative) |
| `ecdd186` | `assignEscort` resolves the employee directory name when only a mobile is supplied |
| `7da17f1` | Parse unstructured release-group cancellation/replacement/food-bill/empty messages into enriched pending review evidence, with read-only candidate program matching; never auto-releases or updates a program |

Plus the earlier `9e85e49` content (`/vessel/drafts`, Owner draft projection,
`getProgram` ISO date fix) and `81c376c`/`08b050e`/`76d5d00` documentation.

**No schema change, no migration, no SQL/migration file changed since
`9e85e49`.** Commits `e3e8537` and `1f50321` after the image build are
documentation-only (`git diff 7da17f1..HEAD` contains no non-Markdown file).

---

## 2. Verification evidence

### Automated (local, disposable DB `alrifai_v2_test`)

| Check | Result |
|---|---|
| Unit tests | **110/110 pass** (7 new release-evidence tests) |
| Integration tests | **123/123 pass** (3 new router release tests) |
| `tsc --noEmit` | clean |
| Lint | 0 errors (3 pre-existing warnings) |
| Production Docker build | passes (`pnpm typecheck && pnpm build` inside the image) |

### Clone-tested (isolated DB `alrifai_v2_import_test`, image `7da17f1`)

- 29/29 Admin routes and 12/12 USER routes return HTTP 200; headings and table
  columns intact; all 7 CSV exports return `text/csv`; search, filters and
  pagination work.
- USER receives 403 from 11 privileged API actions; legitimate staging
  (`instruction.create` 201, program `create` 202 pending review) still works.
  USER no longer sees privileged Cash/Settings/Vessel forms; ADMIN still does.
- Vessel pipeline verified end to end: WA-01 order → `DRAFT` program with
  Mother Vessel, Lighter Vessel, Master Mobile, Destination, date and shift →
  `/vessel` + `/vessel/drafts` Owner draft (`MANUAL_COPY_ONLY`) → Admin outgoing
  reply → `applyConfirmation()` → `CONFIRMED` with escort and
  `confirmation_message_id`. No outbound WhatsApp message was sent.
- Cancellation, food-bill and empty release-group messages produced enriched
  pending review items with extracted fields, evidence kinds, matched tokens,
  candidate program IDs and reasons; candidate matching is read-only and the
  matched program stayed `CONFIRMED` — nothing released, voided or posted.
- All fixtures deleted; clone returned to baseline (94 programs, 218 employees,
  0 review items, 3,799 cash instructions).

### Production-deployed / live-verified (read-only only)

- `app` and `sync` run `86d659a`; `/api/health` → `ok`, DB `ok`, schema `1.5.0`.
- Production flags: `ALRIFAI_VESSEL_PROCESSING_ENABLED=1`,
  `PHASE3_ROUTER_WORKER_ENABLED=1`, `ALRIFAI_LIVE_CASH_SYNC=0`, all `AI_*` = `0`.
- Production DB: 218 employees, 439 attendance, 102 programs (94 imported +
  8 live WA-01 `DRAFT` created 2026-11-07), 2,231 Cash `REVIEW`, 1,586 legacy
  postings, **zero non-legacy postings**, 13 pending review items, zero
  outbound AI rows.
- Sync checkpoints advanced to `wa-01=19728`, `wa-02=15238`; cutover watermarks
  remain `wa-01=19634`, `wa-02=15184`.
- `app.al-rifai.iamazim.com` and `alrifai.iamazim.com` return health 200;
  `al-rifai.iamazim.com` returns HTTP 403 with `error code: 1014`.
- **Production authenticated UI verification is blocked**: the three password
  files are 0-byte. This is a pre-existing condition, not introduced by the
  candidate; no credentials were reset.

### Compatibility

- Production and clone both report schema `1.5.0`; candidate has no migration.
- `docker compose ... config` dry-run with `ALRIFAI_TAG=phase3-ai-rc-7da17f1`
  resolves `app` and `sync` to the new image while preserving
  `PGDATABASE=alrifai_v2_phase3`, both router flags `1`,
  `ALRIFAI_LIVE_CASH_SYNC=0`, ports, TLS, networks and restart policy.
- Shell `ALRIFAI_TAG` overrides the `.env` value (`86d659a`) at deploy time;
  the `.env` is **not** edited until approval.
- Legacy routes, permissions and capabilities were re-checked on the clone.

---

## 3. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Production router worker is active and processing live WA-01 traffic during restart | Claim uses `FOR UPDATE SKIP LOCKED`; messages left `PROCESSING` are recovered after 30 min; writes are idempotent by source identity. Deploy during a quiet window if possible; no message is lost. |
| Existing 7 `RELEASE_UNSTRUCTURED` production items | Preserved as pending manual-review items. New parser applies to future messages only; no retroactive rewrite, no program update. |
| Production login verification still impossible | Pre-existing; does not affect deployment safety. Keep as an open high-priority item. |
| Automatic draft delivery / outbound WhatsApp | Not enabled by this change; `MANUAL_COPY_ONLY` retained, all `AI_*` flags remain `0`, bridge permissions unchanged. |
| `al-rifai.iamazim.com` 1014 | Unchanged; needs Owner Cloudflare/DNS decision, unrelated to this image. |
| New review payload keys | JSON-only (`payload.extractedFields` etc.); no column or enum change. |

---

## 4. Deployment (executed after approval) and rollback (available)

```bash
cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-ai-rc-7da17f1 docker compose \
  --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
```

Rollback (no data restore needed for this UI/logic-only change):

```bash
cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-ai-rc-86d659a docker compose \
  --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
```

Verified rollback image: `phase3-ai-rc-86d659a`,
`sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5`.
Verified pre-import backup (available, not required for rollback):
`/var/lib/vps/al-rifai/backups/phase3-pre-import-20261106T224024Z.dump`,
SHA-256 `83dfe6d0284a1f16d1109aee0cb0b29273bbc3a739955194bada2fd8c8daaad9`.

### Post-deploy verification checklist (read-only)

1. `/api/health` → `ok`, `database ok`, `schemaVersion 1.5.0`.
2. `docker ps` shows both containers on `phase3-ai-rc-7da17f1`.
3. `/vessel/drafts` renders the 8 live `DRAFT` programs; one program detail
   renders without `[object Date]`.
4. A review detail shows the new cancel/food-bill fields where present.
5. USER no longer sees privileged forms; ADMIN still does (if credentials exist).
6. Sync checkpoints continue to advance; no new `ai_outbound_messages` rows.
7. No change to cutover watermarks, allowlists, bridge sessions or DNS.

---

## 4b. Deployment execution (performed after approval)

```bash
cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-ai-rc-7da17f1 docker compose \
  --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
```

Only `al-rifai-phase3-app-1` and `al-rifai-phase3-sync-1` were recreated.
PostgreSQL, both WhatsApp bridge containers, bind-mounted stores, TLS files,
networks and ports were untouched. The `.env` was not edited **during the
deployment**. In a later, separately approved step the Owner authorised
aligning `ALRIFAI_TAG` to `phase3-ai-rc-7da17f1` (one line, no restart,
owner/mode preserved); see
`docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`. A bare Compose command now
keeps the deployed image. Rollback still uses the explicit
`ALRIFAI_TAG=phase3-ai-rc-86d659a` override.

| Post-deploy check | Result |
|---|---|
| Container images | both `local/al-rifai-platform:phase3-ai-rc-7da17f1`, digest `sha256:5f3de875…` |
| App health | `Up (healthy)`; `✓ Ready`; `Phase 3 router worker started (interval=5000ms, limit=100)` |
| `/api/health` (both hosts) | `200 {"status":"ok","database":"ok","schemaVersion":"1.5.0"}` |
| `schema_meta` | `1.5.0` |
| Business counts | **identical** to the pre-deploy snapshot (diff empty): 218 employees, 102 programs, 439 attendance, 3,817 instructions, 2,231 REVIEW, 1,586 postings, 13 review items, 34,595 messages, 83 COMPLETED / 0 PROCESSING / 0 FAILED |
| Sync checkpoints | unchanged `wa-01=19730`, `wa-02=15243` |
| Router | resumed with `processed=1` ticks, zero errors, no duplicate instructions or programs |
| `/vessel/drafts` | route present (401 unauthenticated); legacy routes intact |
| Rollback | **not executed** — no release-related failure |

### Fresh backup used for this deployment

`/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-20261107T124612Z.dump`
— 8,864,137 bytes, SHA-256
`61c73a1a29e0f96b30dc62a0f45d778a19471a87f6d185984b3c4ca68ebb48aa`,
`pg_dump -Fc`, `pg_restore -l` valid, full restore into a disposable database
verified. Details and restoration procedure:
`docs/PHASE3_PREDEPLOY_BACKUP_20261107.md`. No backup was overwritten and no
backup restore was used to roll back code.

---

## 4c. Authenticated production UI test matrix (Task 3)

**Exact authentication blocker (refined 2026-11-07):** the three password files
are 0 bytes but they are **provisioning-only** and do not invalidate the stored
hashes. The earlier `400 CREDENTIALS_REQUIRED` came from an **empty password**
submission (`lib/unified-auth.ts:118`), before any lookup. All three accounts
have valid PBKDF2 hashes, correct roles/capabilities, 6 historical successful
`LOGIN` events and 2 live production sessions — the pipeline is healthy. The
Agent simply has no plaintext password and no production session cookie. No
password was reset, no account created, no role changed. Full trace:
`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`; full matrix:
`docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`.

Status legend: **VERIFIED** (read-only live check passed), **PARTIAL**,
**FAILED**, **NOT TESTED** (blocked by credentials).

| Feature | `app.al-rifai.iamazim.com` | `alrifai.iamazim.com` | Notes |
|---|---|---|---|
| Health `/api/health` | VERIFIED | VERIFIED | 200, DB ok, schema 1.5.0 |
| Login page `/login` | VERIFIED | VERIFIED | 200 HTML, form renders |
| Unauthenticated protection | VERIFIED | VERIFIED | `/cash` 307→/login; `/vessel`, `/employees`, `/attendance`, `/reports`, `/review`, `/income-expenditure`, `/vessel/drafts` 401; APIs 401 |
| Login (existing accounts) | **NOT TESTED** | **NOT TESTED** | 400 `CREDENTIALS_REQUIRED`; empty password files |
| Logout / session handling | **NOT TESTED** | **NOT TESTED** | no session obtainable |
| Role permissions (production) | **NOT TESTED** | **NOT TESTED** | clone-tested only (see §2) |
| Dashboard cards | **NOT TESTED** | **NOT TESTED** | auth required |
| Cash / Transactions / Submissions / Archive | **NOT TESTED** | **NOT TESTED** | auth required |
| Vessel / Vessel Register / Drafts / Program Details | **PARTIAL** | **PARTIAL** | `/vessel/drafts` route presence VERIFIED (401); rendered content NOT TESTED |
| Employees / profiles / payment history | **NOT TESTED** | **NOT TESTED** | auth required |
| Attendance / Reports / Review / Income & Expenditure | **NOT TESTED** | **NOT TESTED** | auth required |
| Navigation, nested URLs, tables, search, filters, pagination | **NOT TESTED** | **NOT TESTED** | auth required; clone-tested |
| CSV exports | **NOT TESTED** | **NOT TESTED** | 401 unauthenticated; clone-tested `text/csv` |
| Add/Edit/View/Delete controls and approval workflows | **NOT TESTED** | **NOT TESTED** | production state-changing actions intentionally not attempted |

`al-rifai.iamazim.com` was left unchanged (Cloudflare 1014 / HTTP 403 body
`error code: 1014`); no DNS or proxy change was made.

---

## 4d. Sign-off resolution

Owner approval was received and acted upon. No further deployment is authorised
by this record: the post-deployment workflow fixes (`675a3ef`) are **not
deployed** and require their own backup, candidate and approval.

---

## 5. Open items (do not block a safe deployment, but stay open)

1. Production credentials / authenticated UI verification (Owner-supplied).
2. Owner decision on vessel-draft transport (manual copy vs approved outbound).
3. Manual review of the 7 legacy `RELEASE_UNSTRUCTURED` items.
4. Cloudflare 1014 for `al-rifai.iamazim.com`.
5. Merge `feature/phase3-router-cash-vessel` into `main` after deployment.

---

## 6. Sign-off resolution

**Recommendation GO, Owner approval GO, deployment COMPLETE.** No credentials,
DNS, migrations, bridges, sessions, checkpoints, allowlists, permissions or
production business data were changed. The backup exists for data recovery
only; application rollback would use `ALRIFAI_TAG=phase3-ai-rc-86d659a`.

A later commit `675a3ef` contains additional workflow fixes (employee PATCH,
payroll gating, TRANSFER classification) that are implemented and tested but
**not deployed**; they require a separate candidate build and Owner approval.
