# Pre-deployment production backup — 2026-11-07 (candidate `7da17f1`)

**Purpose:** fresh, consistent, verified PostgreSQL backup of the live production
database `alrifai_v2_phase3` taken immediately before any deployment of
`phase3-ai-rc-7da17f1`.
**Migration status:** **NO MIGRATION** — schema `1.5.0` unchanged.
**Previous backups:** preserved; no file was overwritten.

---

## 1. Backup identity

| Field | Value |
|---|---|
| File | `/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-20261107T124612Z.dump` |
| Checksum sidecar | `/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-20261107T124612Z.dump.sha256` |
| Size | 8,864,137 bytes (8.5 MiB) |
| SHA-256 | `61c73a1a29e0f96b30dc62a0f45d778a19471a87f6d185984b3c4ca68ebb48aa` |
| Format | `pg_dump -Fc` (custom, gzip compressed), dump version 1.15-0 |
| Timestamp (UTC) | 2026-11-07T12:46:12Z (archive created 12:46:13Z) |
| Source DB | `alrifai_v2_phase3` (73 MB) on `vps-infra-postgres-1` |
| Permissions | dump `600 root:root`, checksum `644 root:root` |

Command used (established procedure from `docs/PHASE3_CUTOVER_RUNBOOK.md` §4.2):

```bash
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DUMP=/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-${STAMP}.dump
docker exec vps-infra-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d alrifai_v2_phase3 -Fc' > "$DUMP"
sha256sum "$DUMP" > "${DUMP}.sha256"
```

`pg_dump` runs in a single consistent snapshot; the live router worker and sync
tailer continued writing during the dump without being stopped.

## 2. Integrity verification (performed, all passed)

1. `sha256sum -c` → `OK`.
2. `pg_restore -l` → valid archive, 333 TOC entries, 344 listing lines,
   `dbname: alrifai_v2_phase3`, compression gzip.
3. **Full restore test** into a fresh disposable database
   `alrifai_predeploy_restorecheck_124612`:
   ```bash
   docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d postgres \
     -c "CREATE DATABASE alrifai_predeploy_restorecheck_124612"
   docker exec -i vps-infra-postgres-1 pg_restore -U vps_pg_admin \
     -d alrifai_predeploy_restorecheck_124612 --no-owner --no-privileges < "$DUMP"
   ```
   `pg_restore` produced **zero warnings/errors**. The restored database
   reported `schema_version = 1.5.0` and exactly matched production:
   218 employees, 102 programs, 439 attendance, 3,817 cash instructions,
   1,586 cash postings, 13 review items, 34,595 WhatsApp messages, and sync
   checkpoints `wa-01=19730`, `wa-02=15243`.
4. The disposable database was dropped afterwards. Production was re-checked
   unchanged (102 programs).

## 3. Business-data baseline recorded before deployment

| Table | Count |
|---|---|
| `employees` | 218 |
| `programs` | 102 (94 imported + 8 live WA-01 `DRAFT`) |
| `attendance` | 439 |
| `cash_instructions` | 3,817 (`REVIEW` 2,231) |
| `cash_postings` | 1,586 (all legacy; zero non-legacy) |
| `review_items` | 13 (all `PENDING`) |
| `whatsapp_messages` | 34,595 (`PROCESSING` 0, `FAILED` 0) |
| `whatsapp_sync_state` | `wa-01=19730`, `wa-02=15243` |
| `schema_meta.schema_version` | `1.5.0` |

## 4. Restoration procedure (only for a genuine data-loss event)

Application-code rollback must **not** restore this dump: use
`ALRIFAI_TAG=phase3-ai-rc-86d659a` instead. Restore only if the database itself
must be recovered:

```bash
# 1. Stop writers to avoid restoring underneath a live router
docker stop al-rifai-phase3-app-1 al-rifai-phase3-sync-1

# 2. Restore into a NEW database, then verify before switching names
DUMP=/var/lib/vps/al-rifai/backups/phase3-predeploy-7da17f1-20261107T124612Z.dump
sha256sum -c "${DUMP}.sha256"
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d postgres \
  -c "CREATE DATABASE alrifai_v2_phase3_restore_20261107"
docker exec -i vps-infra-postgres-1 pg_restore -U vps_pg_admin \
  -d alrifai_v2_phase3_restore_20261107 --no-owner --no-privileges < "$DUMP"
docker exec vps-infra-postgres-1 psql -U vps_pg_admin \
  -d alrifai_v2_phase3_restore_20261107 \
  -c "select * from schema_meta" -c "select count(*) from programs"

# 3. Only after verification, with Owner approval, rename/switch the database
#    and update PGDATABASE; then restart app and sync.
```

Never restore over the live database in place, and never delete the original
backup or the earlier `phase3-pre-import-20261106T224024Z.dump`
(SHA-256 `83dfe6d0284a1f16d1109aee0cb0b29273bbc3a739955194bada2fd8c8daaad9`).

## 5. Safety note

This backup is independent of the image rollback path. No credentials, schema,
DNS, bridge sessions, checkpoints, allowlists or production business records
were changed while creating it.
