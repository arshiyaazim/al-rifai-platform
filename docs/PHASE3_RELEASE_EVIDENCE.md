# Phase 3 Release Evidence

**Recorded:** 2026-11-06
**Branch:** `feature/phase3-router-cash-vessel`
**Release candidate code commit:** `2c82936`
**Documentation tip:** `0d1a55a`
**Release tag:** `v1.4.0-phase3-rc2`
**Schema:** `1.4.0`
**Feature branch:** pushed to `origin/feature/phase3-router-cash-vessel`; cutover-safety code commit `2c82936`
**Production deployment:** EXECUTED 2026-11-06 18:14 UTC — Phase 3 live on `alrifai_v2_phase3`; old Phase 2 stack and DB preserved

## Image

| Field | Value |
|---|---|
| Tag | `al-rifai-platform:phase3-rc-final5` |
| Manifest digest | `sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae` |
| Build source | cutover-safety commit on `feature/phase3-router-cash-vessel` |
| Runtime | Node 22, Next.js 16.4.1, non-root `10001:10001` |

The image was built locally only. It was not pushed, tagged as production, or
deployed.

## Verification results

| Check | Command | Result |
|---|---|---|
| Typecheck | `pnpm typecheck` | 0 errors |
| Lint | `pnpm lint` | 0 errors, 6 pre-existing warnings |
| Unit tests | `pnpm test:unit` | 69/69 pass |
| Integration tests | `pnpm test:standalone` | 95/95 pass |
| Next.js build | `pnpm build` | pass |
| Docker build | `docker build -t al-rifai-platform:phase3-rc-final3 .` | pass |
| Dependency audit | `pnpm audit --prod` | no known vulnerabilities |
| Test DB migration | `scripts/standalone/migrate.mjs` | `1.3.3` → `1.4.0`, 35 tables, 7 ledger rows; repeat no-op |
| Fresh disposable DB | installer + migrate + `--force` | install 34 tables/1.4.0; migrate 35 tables; `--force` pass |
| Runtime smoke | release image `phase3-rc-final5` + authenticated HTTP | health 200/schema 1.4.0; dashboard/cash/review/vessel/settings 200; `/cash/[id]` 200 with audit |
| Production-copy migration rehearsal | restored real `alrifai_v2` dump into `alrifai_v2_phase3_rehearsal` | 1.2.0 → 1.4.0; 34,420 messages / 2,010 chats / 2,597 aliases / 261 media / 3 users preserved |
| Automatic WhatsApp pipeline | image `phase3-rc-final5` + rehearsal DB | post-cutover synthetic message → REVIEW instruction without manual route; history remained PENDING |
| Vessel activation gate | same image, flag 0 then 1 | deferred message stayed PENDING with flag 0; created DRAFT program after flag 1 |
| HTTP lifecycle on production copy | image `phase3-rc-final5` | create → assign account → approve → post → reverse → reconcile; ledger DEBIT+CREDIT; audit complete |

## Integration suite breakdown

| Suite | Tests |
|---|---|
| `domain.test.ts` | 10 |
| `whatsapp.test.ts` | 1 |
| `message-router.test.mjs` | 50 |
| `router-cutover.test.mjs` | 18 |
| `review-api.test.mjs` | 7 |
| `cash-lifecycle.test.mjs` | 7 |
| `users.test.mjs` | 2 |
| **Total** | **95** |

## Production-copy migration rehearsal (2026-11-06)

A real `pg_dump -Fc` of production `alrifai_v2` was restored into the isolated
database `alrifai_v2_phase3_rehearsal`. Production was read-only for this step.

- Dump: 7.6 MB, 227 TOC entries, SHA-256
  `a96f20f36eaaba778c751ad8038850600e99a136f5a4c2ba3f3cf03a67499e90`.
- Pre-migration: schema `1.2.0`, 30 tables, 34,420 messages, 2,010 chats,
  2,597 identity aliases, 261 media rows, 3 users, 0 programs/instructions.
- Post-migration: schema `1.4.0`, 35 tables, 7 migration-ledger rows, all raw
  data preserved, 34,420 unique message keys, 0 missing `source_rowid`.
- Historical rows remained `PENDING` (34,420) and unchanged; the router did not
  rewrite history.
- Runtime grants exist on `cash_reversals`, `cash_reconciliations` and the
  extended `cash_submissions`; the ledger source check includes
  `REVERSAL`/`RECONCILIATION`; the immutable reversal trigger is present.
- A synthetic post-cutover WA-01 Cash message was routed automatically by the
  actual release image: `CASH:REVIEW_CREATED`, one `REVIEW` instruction with
  `created_by=system:whatsapp-router`, zero postings. Exact replay produced no
  duplicate.
- The router-created instruction was assigned an account, approved, posted and
  reversed over authenticated HTTP; the ledger shows the original `DEBIT` and
  the contra `CREDIT`, and the audit trail contains all five actions.
- A synthetic Vessel message remained `PENDING` while
  `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`; after restarting with `=1`, the same
  message created a DRAFT program. This proves the deployment gate does not lose
  deferred orders.

## Cutover-safety correction (2026-11-06)

The first cutover review found a real ingestion defect: the sync worker imported
bridge chats only during the historical bootstrap. Production had two orphan
chat JIDs (six messages) because later chats were never written to
`whatsapp_chats`. The worker now imports chats on pending/recent/identity rounds.

Final-sync rehearsal on an isolated clone of `alrifai_v2_phase3`:

- checkpoints advanced from `wa-01 19629` / `wa-02 15179` to
  `wa-01 19634` / `wa-02 15181`, matching production;
- message hash matched production exactly;
- media hash matched production exactly (188 stored / 76 failed);
- orphan chats: **0**;
- WA-01 chats: 759 (production had 756; the three missing bridge chats are now
  imported);
- one alias was intentionally normalized (`8801958122300` evidence source and
  canonical person key); all other alias identity fields matched;
- operational `whatsapp_import_runs` history can be backfilled idempotently;
  3,987 production rows were exported and 76 missing rows inserted on the clone.

The live delta at audit time was 7 messages, 2 WA-02 media rows and 5 WA-01
aliases. The final cutover runbook requires re-measuring this delta immediately
before switching.

New release artifact: `compose.phase3.yaml` (separate `al-rifai-phase3` Compose
project, `PGDATABASE=alrifai_v2_phase3`, both flags `0`). The old `al-rifai-v2`
containers remain stopped and preserved for rollback.

## Cutover execution (2026-11-06 18:14 UTC)

- Live stack: `alrifai-phase3-app-1` and `alrifai-phase3-sync-1`, image
  `local/al-rifai-platform:phase3-rc-final5`
  (`sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae`).
- Live DB: `alrifai_v2_phase3`, schema `1.4.0`, 34,437 messages, 264 media rows,
  2,602 aliases, 2,013 chats, 0 postings.
- Old stack `alrifai-v2-app-1` / `alrifai-v2-sync-1` stopped and preserved;
  old DB `alrifai_v2` remains schema `1.2.0`, 0 postings.
- Pre-cutover backup: `/var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_20261106_191328.dump`
  SHA-256 `82ffdd400c33734e8780b53c20fc956a9588185b9c0612f5b9295454139df6ec`.
- Env rollback copy: `/opt/vps/al-rifai-standalone/apps/al-rifai/.env.pre-phase3`.
- Measured downtime: ~16 seconds. First compose attempt failed because the image
  was only tagged without the `local/` namespace; the same digest was tagged as
  `local/al-rifai-platform:phase3-rc-final5` and the stack started.
- Health 200 / schema 1.4.0; login 200; authenticated dashboard/cash/review/
  vessel/settings all 200; unauthenticated dashboard 401, cash 307.
- Both feature flags remain `0`; `app_settings.phase3_*` is empty; postings 0.
- Sync checkpoints 19,634 / 15,181 with no error.
- Full timeline: `docs/PHASE3_DEPLOYMENT_LOG.md`.

## Safety confirmation

- Production `alrifai_v2` remains at schema `1.2.0`.
- Production application containers were not restarted or recreated.
- WhatsApp bridge stores were not modified.
- No live financial posting, reversal or reconciliation was executed.
- No `.env`, password, media key or private evidence is committed.
- The test DB `alrifai_v2_test` was the only database migrated to `1.4.0`.
- The disposable `alrifai_v2_ci_test` database was created solely for migration
  verification.

## Remaining release gates

1. Owner approval of commit `4e9ae01` and the Cash capability matrix.
2. Fresh verified production backup stored outside `/tmp`.
3. Production migration window and rollback image retention.
4. Owner-supplied business chats, group participants and WA-01 Admin JIDs.
5. Acceptance of local CI evidence while GitHub Actions remains billing-locked.

---

## 2026-11-07 — Isolated integration + Admin Business Paid API/UI

**Branch:** `feature/phase3-integration` (from `a4aabb6`, merged router `4e2e3f4`).
**Status:** isolated source implementation only; no production migration,
deployment, flag activation, ledger posting or WhatsApp permission change.

| Check | Result |
|---|---|
| Typecheck / lint | 0 errors |
| Unit | 147/147 |
| Integration | 163/163 |
| Next.js build | pass, `/cash/paid` and `/cash/paid/[id]` emitted |
| Fresh install | schema `1.6.0`, 49 tables, 10 migration-ledger rows |
| Incremental 1.5.0 → 1.6.0 | migrations 010 then 011; repeat no-op |
| Runtime grants | vessel READ_WRITE; Paid events/postings append-only |
| Production | unchanged |

Added API/UI: Business Paid list/detail, WhatsApp/Office evidence, financial
posting status, correction/reversal actions, and explicit Business Paid vs
Financial POSTED reporting basis.

---

## 2026-11-08 — Production release preparation audit (read-only)

Candidate: `feature/phase3-integration` @ `0b691a223949e9a413589db9e5f3dcd3366448e3`.

| Check | Result |
|---|---|
| Production image | `phase3-ai-rc-7da17f1`, `sha256:5f3de875…01fa`, healthy |
| Production schema | `1.5.0`, 46 tables, migrations 002–009 |
| Restored backup | `phase3-predeploy-7da17f1-20261107T124612Z.dump`, 8.5 MB, SHA-256 `61c73a1a…48aa`, 333 TOC |
| Production-copy migration | 010+011 applied; schema `1.6.0`, 49 tables, 10 migrations; row counts preserved |
| Repeat migration | no-op |
| Failure probe | rollback clean; no probe table/ledger row |
| Runtime grants | 010 vessel READ_WRITE; 011 events/postings APPEND_ONLY |
| App startup on restored copy | `/api/health` 200, `1.6.0` |
| Auth/RBAC | unauth redirect/401; admin routes 200; staff mutation 403; no-CSRF 403; admin correction/reversal 200 with zero posting/ledger rows |
| UI markers | `/cash/paid`, detail, `/cash/transactions` POSTED basis, Vessel routes 200 |
| Production changes | **none** |

Critical release dependency: apply 010/011 before starting the new image because
`/cash/paid` queries the 011 table even when `PHASE3_PAID_EVENTS_ENABLED=0`.
A fresh backup and Owner approval are still required.

Technical references:
`docs/MIGRATION_010_VESSEL_DRAFT_DELIVERY.md`,
`docs/MIGRATION_011_CASH_PAYMENT_EVENTS.md`,
`docs/PHASE3_GIT_COMPLETENESS_AUDIT.md`.

---

## 2026-11-08 staged production migration (010 then 011)

| Gate | Result |
|---|---|
| Fresh production backup | `phase3-release-010011-20261108T084939Z.dump`, 8.6 MB, SHA-256 `d88b0f0f173732a1ca3cfcb812ed9489aa9d443f4bfc5ed3d3ace0be4c22ae77`, 344 TOC lines |
| Production-copy rehearsal | 1.5.0/46 → 010-only 1.5.0/47 → 011 1.6.0/49; counts preserved |
| Migration 010 production | applied, 47 tables, schema 1.5.0; verified before 011 |
| Migration 011 production | applied, 49 tables, schema 1.6.0; verified |
| Ledger checksums | 010 `fa299768…17e7c7`; 011 `4203fdbe…4165` |
| Runtime grants | 010 SELECT/INSERT/UPDATE; 011 SELECT/INSERT |
| Data counts | unchanged (employees 218, programs 102, attendance 439, instructions 3,840, postings 1,586, ledger 1,586, submissions 117, review 20, messages 34,743) |
| Paid Events | 0 events, 0 posting links, flag OFF |
| Outbound | gate/worker OFF; no message sent; delivery mode MANUAL_COPY_ONLY |

---

## 2026-11-08 production deployment and final verification

| Field | Value |
|---|---|
| Release source commit | `8a6c2c6ae8d082fc15235bd37e126117ad06f8c7` |
| Image tag | `local/al-rifai-platform:phase3-ai-rc-8a6c2c6` |
| Image ID / digest | `sha256:8b7ab534838f670c9b6486015650711e266dea4d3f8b2ac4df287d5be1c3e510` |
| Containers | `al-rifai-phase3-app-1`, `al-rifai-phase3-sync-1` recreated |
| Health | `/api/health` 200, DB ok, schema `1.6.0`; app healthy |
| Flags after deploy | Router worker `1`; Vessel processing `1`; Paid absent/OFF; Vessel draft worker/outbound absent/OFF |
| Migrations | 010 + 011 applied and verified; 49 tables |
| Data | 1,586 postings/ledger entries unchanged; 0 Paid Events; 0 posting links; delivery queue 0 |
| Router | worker started; 147 messages processed, 41 Cash REVIEW, 4 Vessel DRAFT, 0 postings/events/sends |
| Outbound | no sender JID/recipient/socket/token; no `messages.send`; no message sent |
| Authenticated production UI | **BLOCKED / NOT VERIFIED** — no authorized plaintext test credential or session was available; isolated HTTP/RBAC evidence remains the verification source |
