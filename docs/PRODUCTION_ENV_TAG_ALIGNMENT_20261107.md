# Production `.env` ALRIFAI_TAG alignment — 2026-11-07

**Status:** COMPLETE with explicit Owner approval ("Approve .env change").
**Scope:** one line of one file. No restart, no container recreation, no other
environment variable, ownership, permission, DNS, credential or data change.
**Migration status:** NO MIGRATION.

---

## 1. Read-only verification (before the change)

| Check | Result |
|---|---|
| Running `al-rifai-phase3-app-1` | `local/al-rifai-platform:phase3-ai-rc-7da17f1`, image ID `sha256:5f3de875…01fa`, container `db7e0d888f28`, healthy |
| Running `al-rifai-phase3-sync-1` | same image/ID, container `e5fe4214d625` |
| `.env` path | `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` |
| Owner / mode / size | `root:root` / `600` / 4344 bytes |
| `ALRIFAI_TAG` (line 61) | `phase3-ai-rc-86d659a` — **mismatch** |
| Compose image expression | `local/al-rifai-platform:${ALRIFAI_TAG:-latest}` in `compose.yaml` for both `app` and `sync` |
| Variable precedence | shell environment overrides `--env-file`; no override → `86d659a`, `ALRIFAI_TAG=phase3-ai-rc-7da17f1` → `7da17f1` |
| `docker compose config` with no override | resolved **both** services to `local/al-rifai-platform:phase3-ai-rc-86d659a` |
| Effect of a bare `docker compose up -d` | would recreate both containers on the rollback image `86d659a` — an unintended rollback |
| Rollback image | `local/al-rifai-platform:phase3-ai-rc-86d659a`, digest `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5`, present |
| Rollback procedure | `docs/PHASE3_GO_NO_GO_7da17f1.md` §4 |

## 2. Change performed

- Backup of the original file (preserves the previous tag):
  `/var/lib/vps/al-rifai/backups/al-rifai.env.pre-tag-align-20261107T144038Z`
  (`root:root`, mode `600`, 4344 bytes, SHA-256
  `614f2d349fd3db1ec979515213ae2c5e18d5e40bae316b7fc3069198f04b3ee3`).
- Line 61 changed from `ALRIFAI_TAG=phase3-ai-rc-86d659a` to
  `ALRIFAI_TAG=phase3-ai-rc-7da17f1`.
- Raw `diff` shows exactly one changed line; a redacted-key diff shows no other
  difference. File size, ownership (`root:root`) and mode (`600`) unchanged.
- No secret value was printed, logged or committed.

## 3. Verification after the change

| Check | Result |
|---|---|
| `grep '^ALRIFAI_TAG='` | `phase3-ai-rc-7da17f1` |
| `stat` | `root:root 600 4344` (same as before) |
| `docker compose config` **without** override | both `app` and `sync` → `local/al-rifai-platform:phase3-ai-rc-7da17f1`; full config valid |
| Running containers | identical IDs `db7e0d888f28` / `e5fe4214d625`, identical image, identical uptime — **no restart, no recreation** |
| `/api/health` | `{"status":"ok","database":"ok","schemaVersion":"1.5.0"}` |

A future bare `docker compose up -d` now preserves the deployed image instead
of reverting to the rollback image.

## 4. Previous tag and rollback procedure

- **Previous tag:** `phase3-ai-rc-86d659a` (kept in the backup file).
- **Current tag:** `phase3-ai-rc-7da17f1`.
- **To roll back the application image** (only on an Owner-approved release
  failure, not to revert this config edit):
  ```bash
  cd /opt/al-rifai-platform
  ALRIFAI_TAG=phase3-ai-rc-86d659a docker compose \
    --env-file /opt/vps/al-rifai-standalone/apps/al-rifai/.env \
    -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d app sync
  ```
  No database restore is required for an image rollback.
- **To revert only this config edit:** restore the backup file over `.env`
  (Owner approval required), preserving `root:root` / `600`.
