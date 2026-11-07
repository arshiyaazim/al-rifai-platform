# Phase 3 — GO/NO-GO report for candidate `phase3-ai-rc-7da17f1`

**Date:** 2026-11-07
**Decision:** **TECHNICAL GO** — the candidate is safe to deploy.
**Deployment status:** **NOT DEPLOYED.** Explicit Owner approval is required and
has not been given. Production remains on `phase3-ai-rc-86d659a`.

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

## 4. Deployment and rollback (only after explicit Owner approval)

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

## 5. Open items (do not block a safe deployment, but stay open)

1. Production credentials / authenticated UI verification (Owner-supplied).
2. Owner decision on vessel-draft transport (manual copy vs approved outbound).
3. Manual review of the 7 legacy `RELEASE_UNSTRUCTURED` items.
4. Cloudflare 1014 for `al-rifai.iamazim.com`.
5. Merge `feature/phase3-router-cash-vessel` into `main` after deployment.

---

## 6. Sign-off request

**Recommendation: GO**, subject to explicit Owner approval. No deployment has
been performed. Nothing was changed in production business data, DNS,
credentials, bridges, sessions, checkpoints, allowlists or permissions during
this phase.
