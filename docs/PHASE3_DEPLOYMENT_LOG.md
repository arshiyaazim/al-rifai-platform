# Phase 3 Production Deployment Log

**Cutover date:** 2026-11-06
**Release tag:** `v1.4.0-phase3-rc2`
**Image:** `local/al-rifai-platform:phase3-rc-final5`
**Image digest:** `sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae`
**Target database:** `alrifai_v2_phase3` (schema `1.4.0`)
**Old database:** `alrifai_v2` (schema `1.2.0`, preserved cold backup)
**Final result:** COMPLETE; feature flags remain OFF; no financial posting

---

## 1. Approval and release state

Owner approved the controlled cutover using tag `v1.4.0-phase3-rc2`, image
`al-rifai-platform:phase3-rc-final5`, target `alrifai_v2_phase3` and the verified
`docs/PHASE3_CUTOVER_RUNBOOK.md`.

Release state at start:

| Item | Value |
|---|---|
| `main` | `ebd6ccb` |
| Feature branch | `ebd6ccb` |
| Tag | `v1.4.0-phase3-rc2` |
| Image | `phase3-rc-final5` |
| Production before | `local/al-rifai-platform:20261105-phase2`, schema 1.2.0 |

---

## 2. Phase 1 test suite (before cutover)

| Check | Result |
|---|---|
| `pnpm typecheck` | 0 errors |
| `pnpm lint` | 0 errors, 3 warnings |
| `pnpm test:unit` | 69/69 |
| `pnpm test:integration` | 95/95 |
| `pnpm test:domain` | 10/10 |
| `pnpm audit --prod` | no known vulnerabilities |

---

## 3. Before/after counts

| Record | Production before | Phase 3 snapshot | After final sync/cutover |
|---|---:|---:|---:|
| WA-01 messages | 19,256 | 19,251 | 19,256 |
| WA-02 messages | 15,181 | 15,179 | 15,181 |
| Total messages | 34,437 | 34,430 | **34,437** |
| WA-01 checkpoint | 19,634 | 19,629 | **19,634** |
| WA-02 checkpoint | 15,181 | 15,179 | **15,181** |
| Media rows | 264 | 262 | **264** |
| Identity aliases | 2,602 | 2,597 | **2,602** |
| Chats | 2,010 | 2,010 | **2,013** |
| Import runs | 4,001 | 3,911 | **4,013** |
| Programs / instructions / postings | 0 / 0 / 0 | 0 / 0 / 0 | **0 / 0 / 0** |

The seven new messages, two media rows and five aliases were the live delta since
the staging snapshot. The three additional chat rows correct two orphan LID chat
JIDs (six messages had no `whatsapp_chats` row before the `final5` fix).

---

## 4. Pre-cutover safety checks

- Exact image digest verified.
- Compose override validated: project `al-rifai-phase3`, image
  `local/al-rifai-platform:phase3-rc-final5`, `PGDATABASE=alrifai_v2_phase3`,
  both feature flags `0`, ports 443 and 127.0.0.1:3001.
- Staging-only users/sessions/audit removed; three production users only.
- `app_settings.phase3_*` rows: 0.
- `cash_postings`: 0.
- Old containers `alrifai-v2-app-1` and `alrifai-v2-sync-1` preserved.
- Old database `alrifai_v2` intact at schema 1.2.0.
- 128 GB free disk.

### Fresh backup

```text
/var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_20261106_191328.dump
sha256 82ffdd400c33734e8780b53c20fc956a9588185b9c0612f5b9295454139df6ec
pg_restore -l: OK
```

### Final synchronization

The old sync worker was stopped first. The `final5` bounded catch-up ran against
`alrifai_v2_phase3` with the real bridge stores:

- WA-01 `19629 → 19634`
- WA-02 `15179 → 15181`
- message hash: exact match with production
- media hash: exact match with production
- orphan chats: **0**
- one identity alias intentionally normalized
  (`8801958122300`, `bridge:native_stream`, canonical person key)
- import-run metadata: 4,001 rows exported; 90 missing rows inserted
- no programs, instructions, postings or reviews created

---

## 5. Cutover timeline (UTC)

| Time | Event |
|---|---|
| 18:14:32 | Old app `alrifai-v2-app-1` stopped; old sync already stopped |
| 18:14:32 | First `docker compose up` attempt failed because the image existed as `al-rifai-platform:phase3-rc-final5` but Compose requires `local/al-rifai-platform:phase3-rc-final5` |
| 18:14:48 | Correct namespace tagged at the same digest; new `al-rifai-phase3-app-1` and `al-rifai-phase3-sync-1` started |
| 18:14:48 | New app health becomes available |
| 18:15:51 | Sync confirms both accounts caught up, no errors |

**Measured production downtime:** approximately 16 seconds.
No data was lost; the bridge stores are append-only and the final sync caught up
before the switch.

---

## 6. Post-cutover verification

| Check | Result |
|---|---|
| `https://app.al-rifai.iamazim.com/api/health` | 200, database ok, `schemaVersion: 1.4.0` |
| `/login` | 200 |
| Authenticated `/dashboard`, `/cash`, `/review`, `/vessel`, `/settings` | all 200 |
| Unauthenticated `/dashboard` / `/cash` | 401 / 307 |
| New app container | healthy, `unless-stopped` |
| New sync container | running, `unless-stopped` |
| Sync checkpoints | 19,634 / 15,181; no error |
| App logs | no error/exception lines |
| Sync logs | no error/fatal lines |
| `audit_events` | 0 |
| `cash_portal_audit` | 1 (pre-existing production login) |
| `cash_postings` | 0 |
| Programs / instructions / reviews | 0 |
| Staging-only users | 0 |
| `app_settings.phase3_*` | 0 |
| `PHASE3_ROUTER_WORKER_ENABLED` | `0` |
| `ALRIFAI_VESSEL_PROCESSING_ENABLED` | `0` |

A temporary session row was created for the existing Admin account to verify
authenticated pages and was deleted immediately. No user or audit row was
created; `cash_portal_sessions` is back to its original single row.

---

## 7. Preserved rollback artifacts

| Artifact | State |
|---|---|
| Old app container `alrifai-v2-app-1` | stopped, preserved — ID `dc23577f61b1…` |
| Old sync container `alrifai-v2-sync-1` | stopped, preserved — ID `066f74023dba…` |
| Old image `local/al-rifai-platform:20261105-phase2` | preserved |
| Old DB `alrifai_v2` | intact, schema 1.2.0, 0 postings |
| Pre-cutover dump | `/var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_20261106_191328.dump` |
| Env backup | `/opt/vps/al-rifai-standalone/apps/al-rifai/.env.pre-phase3` |
| Rollback IDs | `/var/lib/vps/al-rifai/backups/phase3-rollback-ids.txt` |
| New DB `alrifai_v2_phase3` | live, retained for rollback/forensics |
| Media directory | shared content-addressed store retained |
| WhatsApp bridge stores | untouched |

Rollback path: stop/remove the `al-rifai-phase3` project, restore `.env.pre-phase3`,
start the old containers. The old sync resumes from its 19,634 / 15,181 checkpoint
and catches up raw messages/media from the bridge stores. Phase 3 business records
remain in `alrifai_v2_phase3`; they are not deleted.

Rollback was not executed because no critical validation failed.

---

## 8. Open follow-ups

1. Add the `local/` image namespace to the cutover precondition:
   `docker tag al-rifai-platform:phase3-rc-final5 local/al-rifai-platform:phase3-rc-final5`.
2. Keep both feature flags `0` until the Owner supplies the business chats,
   group participants, WA-01 Admin JIDs, exact cutover watermark and Cash
   capability matrix.
3. Enable the router worker and Vessel processing separately, with observation.
4. GitHub Actions remains billing-locked; CI evidence is local.

**No business routing, allowlist change, credential change or financial posting
was performed during this cutover.**
