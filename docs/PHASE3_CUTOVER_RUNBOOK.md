# Phase 3 Production Cutover Runbook

**Status:** EXECUTED 2026-11-06 18:14 UTC — see `docs/PHASE3_DEPLOYMENT_LOG.md`
**Release image:** `al-rifai-platform:phase3-rc-final5`
**Image digest:** `sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae`
**New database:** `alrifai_v2_phase3` (schema `1.4.0`)
**Old database:** `alrifai_v2` (schema `1.2.0`, frozen at cutover for rollback)
**Feature flags:** `PHASE3_ROUTER_WORKER_ENABLED=0`, `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`

> Do not execute this runbook without explicit Owner approval. It stops the
> production app and switches the public HTTPS endpoint to a new stack.

---

## 1. Verified architecture

| Component | Current production | Phase 3 target |
|---|---|---|
| Compose project | `al-rifai-v2` | `al-rifai-phase3` (separate project) |
| App container | `alrifai-v2-app-1` | `alrifai-phase3-app-1` |
| Sync container | `alrifai-v2-sync-1` | `alrifai-phase3-sync-1` |
| Image | `local/al-rifai-platform:20261105-phase2` | `local/al-rifai-platform:phase3-rc-final5` |
| Database | `alrifai_v2` (1.2.0) | `alrifai_v2_phase3` (1.4.0) |
| Compose files | `/opt/al-rifai-platform/compose.yaml` | same + `compose.phase3.yaml` |
| Env file | `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` | same + compose override |
| Public TLS | `0.0.0.0:443 -> 3443` | same ports after old app stops |
| Private app port | `127.0.0.1:3001 -> 3000` | same port after old app stops |
| Media | `/var/lib/vps/al-rifai/media` | same shared, content-addressed |
| WhatsApp stores | `/var/lib/vps/whatsapp/wa-0{1,2}/store` | same read-only mounts |

The sync worker writes raw messages, media rows, chats and identity aliases. It
does **not** create Cash instructions or Vessel programs. The router worker is
off, so cutover itself performs no business processing.

The old and new stacks must not run at the same time because both bind 443 and
127.0.0.1:3001. They are separate Compose projects so the old containers can
remain stopped and intact.

---

## 2. Delta audit (as measured 2026-11-06)

The staging database was restored from a production snapshot taken at
`2026-11-06 18:28` local time (17:28 UTC). Production continued ingesting.

| Item | Delta after snapshot |
|---|---:|
| WA-01 messages | 5 (`source_rowid` 19630–19634) |
| WA-02 messages | 2 (`source_rowid` 15180–15181) |
| WA-02 media rows | 2 |
| WA-01 identity aliases | 5 |
| New chat JIDs | 2 LID chats |
| Business records | 0 programs / 0 instructions / 0 postings |

Production had **6 messages without a `whatsapp_chats` row** across two LID
chats. The original sync worker imported chats only during bootstrap. Release
image `final5` fixes this by importing chats on pending/recent/identity rounds.

The final-sync procedure was rehearsed on an isolated clone:

- checkpoints advanced to production `wa-01=19634`, `wa-02=15181`
- message hash and media hash matched production exactly
- orphan chats: **0**
- one identity alias was intentionally normalized
  (`8801958122300`: `bridge:messages.group_participant_jid` →
  `bridge:native_stream`, canonical person key)

**The delta must be re-measured immediately before cutover; these numbers are
evidence, not a fixed assumption.**

---

## 3. Preconditions — stop if any fail

1. Owner has approved cutover with the exact image digest and cutover window.
2. The image is tagged in the Compose namespace:
   `docker tag alrifai-platform:phase3-rc-final5 local/al-rifai-platform:phase3-rc-final5`.
2. `docker image inspect al-rifai-platform:phase3-rc-final5` succeeds.
3. `alrifai_v2` health is 200; schema 1.2.0; postings 0.
4. `alrifai_v2_phase3` is schema 1.4.0.
5. Staging-only users `staging-admin`/`staging-verify` are absent; sessions and
   audit rows for them are absent.
6. `app_settings` contains no enabled `phase3_router_enabled` row.
7. Staging container is stopped.
8. At least 10 GB free disk.
9. Fresh verified backup of `alrifai_v2` exists outside `/tmp`.
10. No unexpected production error in the last 15 minutes.

### Checks

```bash
cd /opt/al-rifai-platform
docker image inspect al-rifai-platform:phase3-rc-final5 >/dev/null
curl -fsS https://app.al-rifai.iamazim.com/api/health
df -h /
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'

docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2 \
  -c "select value from schema_meta where key='schema_version';" \
  -c "select count(*) as postings from cash_postings;"

docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 \
  -c "select value from schema_meta where key='schema_version';" \
  -c "select username from cash_portal_users where username like 'staging-%';" \
  -c "select key,value from app_settings where key like 'phase3_%';"
```

Stop conditions: any failed check, any staging user, any enabled Phase 3 setting,
postings > 0, disk < 10 GB, or unhealthy production.

---

## 4. Final backup and delta synchronization

### 4.1 Stop only the old sync worker

```bash
docker stop alrifai-v2-sync-1
```

The old app continues serving reads throughout this step.

### 4.2 Take the final production backup

```bash
STAMP=$(date +%Y%m%d_%H%M%S)
docker exec vps-infra-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -d alrifai_v2 -Fc' \
  > /var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_${STAMP}.dump
sha256sum /var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_${STAMP}.dump
docker exec -i vps-infra-postgres-1 pg_restore -l \
  < /var/lib/vps/al-rifai/backups/alrifai_v2_FINAL_pre_cutover_${STAMP}.dump \
  > /dev/null
```

Stop if the dump, checksum or `pg_restore -l` fails.

### 4.3 Run the bounded final catch-up against `alrifai_v2_phase3`

```bash
docker rm -f alrifai-phase3-final-sync >/dev/null 2>&1 || true

docker run -d --name alrifai-phase3-final-sync \
  --network vps-backend \
  --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
  -e PGDATABASE=alrifai_v2_phase3 \
  -e PGHOST=vps-infra-postgres-1 \
  -e WA01_DB=/wa/wa-01/messages.db \
  -e WA02_DB=/wa/wa-02/messages.db \
  -e ALRIFAI_MEDIA_DIR=/media \
  -e SYNC_INTERVAL_MS=1000 \
  -e SYNC_RECENT_EVERY=1 \
  -e ALRIFAI_VESSEL_PROCESSING_ENABLED=0 \
  -e PHASE3_ROUTER_WORKER_ENABLED=0 \
  --user 0:0 \
  --volume /var/lib/vps/whatsapp/wa-01/store:/wa/wa-01:ro \
  --volume /var/lib/vps/whatsapp/wa-02/store:/wa/wa-02:ro \
  --volume /var/lib/vps/al-rifai/media:/media:rw \
  --entrypoint node \
  al-rifai-platform:phase3-rc-final5 \
  scripts/sync-worker.mjs --mode=tail
```

Poll until both accounts are caught up and `last_error` is null:

```bash
docker logs alrifai-phase3-final-sync 2>&1 | tail -20
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 \
  -c "select account_id,last_rowid,last_error from whatsapp_sync_state order by account_id;"
```

Compare with the bridge stores' maximum `rowid` (read-only):

```bash
docker exec alrifai-phase3-final-sync node - <<'NODE'
const {DatabaseSync} = require('node:sqlite');
for (const [id, p] of [['wa-01','/wa/wa-01/messages.db'],['wa-02','/wa/wa-02/messages.db']]) {
  const db = new DatabaseSync(p, {readOnly: true});
  console.log(id, db.prepare('select coalesce(max(rowid),0) m from messages').get().m);
  db.close();
}
NODE
```

When both sync checkpoints equal the bridge maxima and the next log round
shows `pending:false`, stop the catch-up container:

```bash
docker stop alrifai-phase3-final-sync
docker rm alrifai-phase3-final-sync
```

### 4.4 Backfill operational import-run metadata

Import runs are operational audit rows, not business records. The sync worker
creates new runs but does not copy historical run rows. Preserve the production
history with an idempotent merge:

```bash
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2 \
  -c "\copy (select id,account_id,source_path,source_sha256,snapshot_at,started_at,finished_at,rows_seen,rows_inserted,rows_skipped,status,error from whatsapp_import_runs) to stdout with (format csv)" \
  > /tmp/import_runs.csv
docker cp /tmp/import_runs.csv vps-infra-postgres-1:/tmp/import_runs.csv

docker exec -i vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 <<'SQL'
CREATE TEMP TABLE tmp_import_runs (LIKE whatsapp_import_runs INCLUDING DEFAULTS);
\copy tmp_import_runs FROM '/tmp/import_runs.csv' WITH (FORMAT csv)
INSERT INTO whatsapp_import_runs SELECT * FROM tmp_import_runs ON CONFLICT (id) DO NOTHING;
SELECT count(*) AS total_runs FROM whatsapp_import_runs;
SQL

docker exec vps-infra-postgres-1 rm -f /tmp/import_runs.csv
rm -f /tmp/import_runs.csv
```

Verified on the rehearsal clone: 3,987 production rows exported; 76 missing rows
inserted; conflict rows were skipped by primary key.

### 4.5 Validate the delta

```bash
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 \
  -c "select account_id,count(*) from whatsapp_messages group by account_id order by account_id;" \
  -c "select count(*) as media from whatsapp_media;" \
  -c "select count(*) as orphan_chats from whatsapp_messages m
        left join whatsapp_chats c
          on c.account_id = m.account_id and c.chat_jid = m.chat_jid
       where c.chat_jid is null;" \
  -c "select count(*) as programs from programs; select count(*) as instructions from cash_instructions;
      select count(*) as postings from cash_postings;" \
  -c "select key,value from app_settings where key like 'phase3_%';"
```

Stop conditions:

- missing messages/media vs the bridge maximum
- `orphan_chats` > 0
- any program/instruction/posting created by the sync step
- any enabled Phase 3 setting
- any `last_error`

---

## 5. Switch to the Phase 3 stack

### 5.1 Point CLI defaults at the new database (preserve the old env)

Container environment is immutable once created, but CLI tools (`pnpm db:migrate`,
`pnpm db:verify`, `admin:reset`) read the deployment `.env`. Preserve the old file
and update only `PGDATABASE` so those tools cannot default to the cold backup:

```bash
ENV_FILE=/opt/vps/al-rifai-standalone/apps/al-rifai/.env
cp -p "$ENV_FILE" "${ENV_FILE}.pre-phase3"
chmod 600 "${ENV_FILE}.pre-phase3"
grep -n '^PGDATABASE=' "$ENV_FILE"
sed -i 's/^PGDATABASE=alrifai_v2$/PGDATABASE=alrifai_v2_phase3/' "$ENV_FILE"
grep -n '^PGDATABASE=' "$ENV_FILE"
```

Expected: `PGDATABASE=alrifai_v2_phase3`. Do not change any other key. The Compose
override repeats this value for the new containers.

### 5.2 Stop the old app and start the new project

Stop the old app; its container remains preserved (restart policy
`unless-stopped` does not restart a manually stopped container):

```bash
docker stop alrifai-v2-app-1
```

Start the Phase 3 stack as a **separate Compose project** so Compose cannot
recreate or remove the old containers:

```bash
cd /opt/al-rifai-platform
ALRIFAI_TAG=phase3-rc-final5 \
  docker compose -p al-rifai-phase3 \
  -f compose.yaml -f compose.phase3.yaml up -d
```

This uses the same 443 and 127.0.0.1:3001 bindings, now free. It does not modify
the old containers or the old database.

### Immediate verification

```bash
docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
curl -fsS https://app.al-rifai.iamazim.com/api/health
curl -fsS -o /dev/null -w '%{http_code}\n' https://app.al-rifai.iamazim.com/login

docker logs alrifai-phase3-app-1 --tail 100
docker logs alrifai-phase3-sync-1 --tail 100

docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 \
  -c "select value from schema_meta where key='schema_version';" \
  -c "select key,value from app_settings where key like 'phase3_%';" \
  -c "select count(*) as postings from cash_postings;"
```

Required result:

- health 200 with `schemaVersion: 1.4.0`
- login page 200
- app and sync healthy
- `PHASE3_ROUTER_WORKER_ENABLED=0`, `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`
- no `phase3_router_enabled` row
- `cash_postings` unchanged (0 at rehearsal)
- sync checkpoint advances for new bridge rows, with no duplicate-key errors
- no error/exception lines in the last 100 log lines

---

## 6. Rollback with divergence

The old database is frozen at cutover. The old sync worker checkpoint is behind
the bridge stores, so on rollback it catches up raw messages automatically.

```bash
# Stop and remove only the Phase 3 project containers
docker compose -p al-rifai-phase3 \
  -f compose.yaml -f compose.phase3.yaml down

# Restore the pre-cutover deployment env for CLI tools
cp -p /opt/vps/al-rifai-standalone/apps/al-rifai/.env.pre-phase3 \
      /opt/vps/al-rifai-standalone/apps/al-rifai/.env

# Restore the preserved Phase 2 containers
docker start alrifai-v2-app-1 alrifai-v2-sync-1

sleep 20
curl -fsS https://app.al-rifai.iamazim.com/api/health
```

Rollback does **not** restore or delete `alrifai_v2_phase3`. It remains intact
for forensics and for any business records created during Phase 3. Raw messages
and media written after cutover are recovered by the old sync worker from the
append-only bridge stores and the shared content-addressed media directory.

**Divergence:** Cash/Vessel/Review business records created while Phase 3 was
live exist only in `alrifai_v2_phase3`; Phase 2 cannot display them. They must
not be deleted. An Owner decision is required on how to reconcile them if the
system remains on Phase 2.

Do not restore `alrifai_v2` over `alrifai_v2_phase3`; that destroys Phase 3 data.
Do not truncate or drop either database.

---

## 7. Feature-flag activation (separate approval)

`compose.phase3.yaml` keeps both flags at `0`. After cutover:

1. Owner supplies Cash/Orders chat JIDs, group participants, WA-01 Admin JIDs,
   exact cutover watermark and the Cash capability/approval matrix.
2. Write `app_settings.phase3_router_enabled=true`, the per-account watermarks and
   the explicit business-chat allowlists.
3. Recreate only the app container with `PHASE3_ROUTER_WORKER_ENABLED=1`.
4. Observe for 24 hours with `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`.
5. Only then request separate approval to enable Vessel processing.

No automatic posting is enabled by either flag.

---

## 8. Evidence from the rehearsal

- Final-sync clone advanced `wa-01 19629→19634`, `wa-02 15179→15181`.
- Message hash and media hash matched production exactly.
- Orphan chats dropped to `0`; WA-01 chats became 759 (production was 756).
- One alias normalization was observed, as documented above.
- No programs, instructions or postings were created by the sync step.
- `alrifai_v2` remained untouched at schema 1.2.0 with 0 postings.
