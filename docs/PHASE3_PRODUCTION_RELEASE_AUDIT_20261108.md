# AL-RIFA'I — Phase 3 Production Release Readiness Audit
**Date:** 2026-11-08
**Candidate:** `feature/phase3-integration` @ `0b691a223949e9a413589db9e5f3dcd3366448e3`
**Mode:** READ-ONLY production audit + isolated rehearsal. No production write,
migration, deployment, restart or feature-flag change was performed.

---

## 1. Verified candidate

| Item | Value |
|---|---|
| Repository | `/opt/al-rifai-platform` |
| Integration worktree | `/opt/al-rifai-phase3-integration` |
| Branch | `feature/phase3-integration` |
| Local HEAD | `0b691a223949e9a413589db9e5f3dcd3366448e3` |
| Remote HEAD | `0b691a223949e9a413589db9e5f3dcd3366448e3` |
| Worktree | clean before documentation changes |
| Canonical `main` | `13d660cb0ecfcb9b87cf15f975f93e8aea8f6723`, pre-existing dirty files/backup preserved |

## 2. Production baseline (read-only)

| Item | Value |
|---|---|
| Running app container | `alrifai-phase3-app-1` |
| Running sync container | `alrifai-phase3-sync-1` |
| Image | `local/al-rifai-platform:phase3-ai-rc-7da17f1` |
| Image ID / local digest | `sha256:5f3de875870f013c741d545a7342bb1fc2625e723838401e5f27baebf61301fa` |
| Image created | 2026-11-07 11:52:43 +01:00 |
| App health | healthy |
| Compose project | `al-rifai-phase3` |
| Compose files | `/opt/al-rifai-platform/compose.yaml`, `compose.phase3.yaml` |
| PostgreSQL | PostgreSQL 16.15 (container `vps-infra-postgres-1`) |
| Production database | `alrifai_v2_phase3` |
| Schema version | **1.5.0** |
| Migration ledger | 8 rows (`002`–`009`) |
| Base tables | **46** |
| Disk | 194G total, 79G used, 115G available (41%) |
| Memory | 23Gi total, ~15Gi available |

### Migration ledger checksums

| Version | Checksum |
|---|---|
| 002 | `7aec0e4b…698264` |
| 003 | `5725ce4e…f584` |
| 004 | `bd832b75…c1c6c` |
| 005 | `a33c9352…abf1bb` |
| 006 | `66d5558e…a0ac` |
| 007 | `2f311ef5…d60c91` |
| 008 | `33d7344b…1efed` |
| 009 | `319ecb43…5321` |

### Production row counts (aggregate only)

| Entity | Count |
|---|---:|
| Employees | 218 |
| Programs | 102 |
| Attendance | 439 |
| Cash instructions | 3,836 (1,586 POSTED, 2,250 REVIEW) |
| Cash postings | 1,586 |
| Ledger entries | 1,586 |
| Cash submissions | 117 (all PENDING_REVIEW) |
| Review items | 13 (PROGRAM PENDING) |
| WhatsApp messages | 34,677 (WA-01 11,646 IN / 7,746 OUT; WA-02 9,981 IN / 5,304 OUT) |
| Audit events | 647 |

### Runtime roles and grants

| Role | Purpose |
|---|---|
| `alrifai_app` | owner/migration role |
| `alrifai_v2_runtime` | application runtime role (least privilege) |

Verified runtime privileges include INSERT/SELECT/UPDATE for Cash and employee
tables; immutable posting/ledger/reversal triggers are present:
`cash_postings_immutable`, `ledger_entries_immutable`,
`cash_reversals_immutable`, `audit_events_immutable`.

**Cash Freeze:** no separate freeze table/flag exists in the standalone schema.
Protection is capability-based (`cash.post`, `cash.reverse`) plus immutable
triggers and the absence of automatic posting.

### Production feature/scope state

| Control | Value |
|---|---|
| `phase3_router_enabled` | `true` |
| `phase3_cutover_rowid:wa-01` | `19634` |
| `phase3_cutover_rowid:wa-02` | `15184` |
| `phase3_business_chats:wa-01` | 9 chats |
| `phase3_business_chats:wa-02` | 0 chats (identity-only) |
| `PHASE3_ROUTER_WORKER_ENABLED` | `1` |
| `PHASE3_PAID_EVENTS_ENABLED` | absent / effectively `0` |
| `ALRIFAI_VESSEL_PROCESSING_ENABLED` | `1` |
| WA-01 account | enabled; 759 authorized chats; 2 CASH, 7 ORDERS |
| WA-02 account | enabled; 1,254 authorized chats; 0 CASH/ORDERS; 0 business chats |
| WA-01 sync max rowid | 19,770 |
| WA-02 sync max rowid | 15,285 |

No WhatsApp JID, session token, credential or private employee record is
reproduced in this document.

## 3. Backup readiness

Latest verified pre-deploy backup:

| Item | Value |
|---|---|
| File | `/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-20261107T124612Z.dump` |
| Size | 8.5 MB |
| Format | `pg_dump -Fc` (custom, gzip), dump version 1.15-0 |
| SHA-256 | `61c73a1a29e0f96b30dc62a0f45d778a19471a87f6d185984b3c4ca68ebb48aa` |
| Checksum sidecar | matches |
| TOC | 333 entries |
| Documented restore test | zero warnings/errors into a disposable database |

Backup inventory: 61 `.dump` files, 4.2 GB total; no automatic retention/cleanup
policy was found. Available disk: 115 GB. Backups are root-only with `.sha256`
sidecars.

This backup predates the latest production rows (it has 3,817 instructions,
115 submissions, 34,595 messages; current production has 3,836 / 117 / 34,677).
**A fresh backup is required immediately before release.**

Expected release backup command (NOT executed; requires Owner approval):

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=/var/lib/vps/al-rifai/backups/phase3-release-${STAMP}.dump
docker exec -i vps-infra-postgres-1 \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d alrifai_v2_phase3 -Fc' > "$DUMP"
sha256sum "$DUMP" | tee "${DUMP}.sha256"
docker exec -i vps-infra-postgres-1 pg_restore -l < "$DUMP" >/dev/null
```

Restore validation plan: restore into a fresh disposable database with
`pg_restore --no-owner --no-privileges`, verify schema `1.5.0`, 46 tables,
8 migration rows, and the pre-release row counts. Never restore over production.

## 4. Production-copy migration rehearsal

The existing verified backup above was restored into an isolated PostgreSQL 16
container (`alrifai-release-rehearsal-pg`, port 55434). Production was not
touched.

| Step | Result |
|---|---|
| Restore archive | EXIT 0, no warnings |
| Baseline schema | `1.5.0` |
| Baseline tables | 46 |
| Baseline migrations | `002`–`009` |
| Baseline rows | employees 218, programs 102, attendance 439, instructions 3,817, postings 1,586, ledger 1,586, submissions 115, review 13, WhatsApp 34,595 |
| 010 preflight | APPLY |
| 011 preflight | APPLY |
| Apply 1.5.0 → 1.6.0 | EXIT 0 |
| Result | schema `1.6.0`, 49 tables, 10 migrations |
| Repeat migration | `pending: []`, no-op, EXIT 0 |
| 010 checksum | `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7` |
| 011 checksum | `4203fdbeff6eede80cc44799b6cdad4112b37e621ef44cf09d22d0ac58964165` |
| Row counts after migration | identical to baseline (no data rewritten) |
| Objects | 010/011 tables, unique indexes, FKs, checks and immutable triggers present |
| Runtime grants | vessel: INSERT/SELECT/UPDATE; Paid events/postings: INSERT/SELECT |
| Application startup | `next start` against restored DB; `/api/health` 200, schema `1.6.0` |
| Failure probe | temporary failing migration exit 1; probe table absent; no `012` ledger row; schema stayed `1.6.0` |

**Production-copy rehearsal: PASS.** No synthetic database was substituted for
this result.

## 5. HTTP authentication and permission verification

Isolated app was started against the restored copy. Synthetic test users and one
synthetic Business Paid event were created only in the isolated database.

| Check | Result |
|---|---|
| Unauthenticated `/cash` | 307 redirect to `/login` |
| Unauthenticated Business Paid API | 401 AUTHENTICATION_REQUIRED |
| Admin `/cash`, `/cash/paid`, `/cash/paid/[id]`, `/cash/transactions`, `/vessel`, `/vessel/drafts` | 200 |
| Admin Business Paid list API | 200; count/total/pagination present |
| Admin Business Paid detail API | 200; root event, employee, evidence, audit present |
| Staff Business Paid list/detail | 200 (cash.read) |
| Staff correction action | 403 CAPABILITY_REQUIRED (`cash.review`) |
| Admin correction without CSRF | 403 CSRF_DENIED |
| Admin correction with CSRF | 200; CORRECTION appended |
| Admin reversal with CSRF | 200; REVERSAL appended |
| Synthetic event after actions | 3 events (PAYMENT + CORRECTION + REVERSAL) |
| Synthetic instruction financial rows | 0 `cash_postings`, 0 `ledger_entries` |
| Flag OFF page | “Paid Events flag is OFF” banner; no correction actions |
| Flag ON detail | correction/reversal timeline, evidence, posting status, audit present |

No correction/reversal was executed against production.

## 6. Browser and UI verification

No headless browser/screenshot tool was available. Verification used isolated
HTTP responses and rendered HTML markers:

| Route | Result |
|---|---|
| `/cash` | 200 |
| `/cash/paid` | 200; “Business Paid Events” marker |
| `/cash/paid/[id]` | 200; evidence, posting, timeline and audit markers |
| `/cash/transactions` | 200; “Basis: Financial POSTED” marker |
| `/vessel` | 200 |
| `/vessel/drafts` | 200 |
| Navigation | `Business Paid` link added |
| Admin vs User actions | Admin actions present; staff actions absent |
| Source evidence link | `/messages?q=…` link present |
| Missing routes | none observed in the tested set |

Responsive layout was not browser-verified; build and server-rendered HTML were
verified only.

## 7. Historical data impact (read-only aggregates)

| Item | Count |
|---|---:|
| Existing cash instructions | 3,836 |
| Business Paid Events in production | 0 (table not yet deployed) |
| Instructions with source message/block | 3,836 |
| Instructions without employee mobile | 0 |
| Instructions without payout mobile | 0 |
| WA-01 outgoing text in Accountant conversation | 2,429 |
| Payment-format messages (`ID:`) | 2,339 |
| Total `ID:` blocks | 2,339 |
| Messages with 2+ `ID:` markers | 1 |
| Messages with more than one instruction | 0 |
| Pending cash submissions | 117 |
| Pending candidates missing mobile/payout/name/method/amount | 72 |
| Pending categories | 45 duplicate candidate, 68 incomplete, 4 extraction failed |
| Instructions with unregistered employee mobile | 39 |
| Instructions with unregistered payout mobile | 1,401 |
| Same-day employee+amount potential repeat groups | 1,574 groups / 3,217 rows |

Interpretation:

- Enabling Paid Events will **not** retroactively create events for the 3,836
  existing instructions.
- One message has two `ID:` markers but production has no message with more than
  one instruction; this is the potential multi-block skip from the old backfill
  logic.
- The 1,574 same-day groups are not confirmed duplicates; historical imports may
  legitimately repeat employee/amount combinations. Review is required before
  any cleanup.

## 8. Feature flag and cutover plan

Independent controls verified:

- DB router gate: `phase3_router_enabled`, cutover watermarks, business chats.
- Worker: `PHASE3_ROUTER_WORKER_ENABLED`.
- Vessel: `ALRIFAI_VESSEL_PROCESSING_ENABLED`.
- Paid: `PHASE3_PAID_EVENTS_ENABLED` (absent/off).

Safe ordering:

1. Fresh backup + restore validation.
2. Stop router worker during the deployment window
   (`PHASE3_ROUTER_WORKER_ENABLED=0`) without changing DB watermarks/allowlists.
3. Apply migrations 010 then 011 with Paid flag off. This must happen **before**
   starting the new image because `/cash/paid` queries the 011 table even when
   the Paid flag is off.
4. Deploy new image with `PHASE3_PAID_EVENTS_ENABLED=0` and router worker still
   off.
5. Verify health, schema `1.6.0`, grants, flag-off totals, no new events/posts.
6. Re-enable `PHASE3_ROUTER_WORKER_ENABLED=1`; keep DB router gate, watermarks
   and 9 WA-01 business chats unchanged.
7. Observe routing and flag-off parity.
8. Only after Owner approval enable `PHASE3_PAID_EVENTS_ENABLED=1` and restart
   the app in a controlled window. Verify Business Paid list/detail and summary.
9. Keep `cash.post` separate; no automatic ledger posting.

Rollback: set `PHASE3_PAID_EVENTS_ENABLED=0` first; router/vessel flags remain
independent. Do not change WA-02 or outbound scope.

## 9. Deployment and rollback runbook

### A. Preflight

```bash
cd /opt/al-rifai-phase3-integration
# after merge approval, build/tag the image from the approved commit
pnpm typecheck && pnpm lint && pnpm test:unit && pnpm test:standalone && pnpm build
```

Production backup and migration preflight require separate Owner approval:

```bash
# fresh backup (not executed)
# migration preflight only:
PGHOST=... PGDATABASE=alrifai_v2_phase3 ... \
  node --experimental-strip-types scripts/standalone/migrate.mjs --preflight
```

Expected preflight: pending `010` and `011`, current `1.5.0`.

### B. Apply migrations

Run `migrate.mjs` with the production owner/runtime configuration after the
fresh backup. Expected: 010 then 011, schema `1.6.0`, 49 tables, 10 ledger rows.
Abort if any checksum differs from the values in §4.

### C. Deploy image

Use the existing Compose project and a separately approved image tag. Keep:

```text
PHASE3_PAID_EVENTS_ENABLED=0
PHASE3_ROUTER_WORKER_ENABLED=0   # during deployment window
ALRIFAI_VESSEL_PROCESSING_ENABLED=1
```

Do not change ports, volumes, TLS, networks, database name, WA-02 scope or
outbound sender configuration.

### D. Verify

- `/api/health` → `ok`, database `ok`, schema `1.6.0`.
- Table count 49; migration ledger 10 rows.
- Runtime grants on 010/011 objects.
- Flag-off summary equals the pre-deploy POSTED total (production baseline
  `85,225,900` minor at audit time).
- `cash_payment_events` and `vessel_draft_deliveries` remain empty unless a
  real event was created after activation.
- No unexpected `cash_postings` / `ledger_entries`.

### E. Controlled activation

Re-enable router worker, observe, then enable Paid Events only with Owner
approval. Verify a real Biz-1 upstream message becomes a REVIEW instruction and
one Business Paid Event, with zero automatic postings.

### F. Rollback

| Layer | Action |
|---|---|
| Application image | Redeploy previous image `phase3-ai-rc-7da17f1`. Old code ignores additive 010/011 tables. |
| Feature flag | Set `PHASE3_PAID_EVENTS_ENABLED=0`; no DB change needed. |
| Router | Set `PHASE3_ROUTER_WORKER_ENABLED=0` or leave DB gate unchanged; do not alter watermarks/allowlists. |
| Database | Prefer forward recovery. Do **not** assume an older image reverts migrated data. A full restore loses post-migration payments/events; only use for proven corruption with Owner approval. |

Expected downtime: migration is additive/fast; app restart is seconds. A 10–15
minute controlled window is recommended for verification.

Abort conditions: backup checksum failure; unexpected migration checksum;
preflight pending set differs; schema not `1.6.0`; table count not 49; missing
grants; health failure; flag-off totals differ; unexpected postings/events;
router error spike; WA-02 business chat count becomes non-zero.

## 10. Risks and blockers

1. **Fresh backup required.** The audit backup is from 2026-11-07 12:46 and
   predates 19 instructions, 2 submissions and 82 messages.
2. **Migrate before deploying the new image.** `/cash/paid` queries 011 even
   when Paid is off; starting the new image on schema 1.5.0 would break that
   route.
3. **No retroactive events.** 3,836 existing instructions have no Business Paid
   Event; enabling the flag does not backfill them.
4. **One potential multi-block message** was not expanded by the old backfill.
5. **72 pending candidates** lack core fields and will require correction under
   the stricter approval path.
6. **39 unregistered employee mobiles / 1,401 unregistered payouts** exist in
   historical instructions; new events will mark them `UNREGISTERED`, never
   reassign them.
7. **1,574 same-day employee+amount groups** need review before any duplicate
   cleanup; not confirmed duplicates.
8. **Router is already enabled** in production. Deploying the new parser changes
   future message handling; use a paused-worker window and observe.
9. **No browser screenshot/responsive test** was possible; HTTP/HTML only.
10. **No retention policy** was found for 61 backup dumps (4.2 GB) on a 115 GB
    free disk.
11. Production remains schema `1.5.0`; no migration/deploy/flag change occurred.

## 11. GO / NO-GO

**GO — controlled production release preparation:** the candidate passed
combined tests, build, production-copy migration rehearsal, grants, startup
health, auth/RBAC/CSRF checks and flag-off parity checks.

**NO-GO — immediate production deployment without further approval:** a fresh
backup, production migration window, image tag/build approval, router pause and
Owner sign-off are still required. Paid Events must remain OFF at first deploy.

**NO-GO — retroactive Business Paid backfill:** not authorized and not
implemented.
