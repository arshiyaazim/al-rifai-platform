# Phase 3 VPS Release Checklist

**For owner approval and deployment AFTER PR review.**  
Do NOT execute before owner approval. No automatic deployment.

## Pre-deployment

- [ ] Owner approval obtained for PR on `feature/phase3-router-cash-vessel`
- [ ] CI passes on feature branch (all jobs: lint, typecheck, unit tests, domain integration tests, router tests, migration validation, Next.js build, Docker validation)
- [ ] Migration `004_phase3_router_state.sql` verified on disposable PostgreSQL → schema version 1.3.0
- [ ] Verified commit SHA from `feature/phase3-router-cash-vessel`
- [ ] Verified backup exists (`pg_dump` of production `alrifai_v2`)
- [ ] Previous Docker image preserved (tagged for rollback)

## Deployment Steps (run on VPS)

1. **Verify current state**
   ```bash
   cd /opt/al-rifai-platform
   git status --short
   git log --oneline -3
   ```

2. **Pull the approved commit**
   ```bash
   git fetch origin
   git checkout <approved-commit-sha>
   # or: git merge --ff-only origin/feature/phase3-router-cash-vessel
   ```

3. **Preserve deployment-critical files** (never overwrite)
   - `.env` — stays in `/opt/vps/al-rifai-standalone/apps/al-rifai/.env`
   - `/var/lib/vps/al-rifai/media` — media directory
   - WhatsApp session stores — bridge-owned storage

4. **Verify backup**
   ```bash
   ls -la /var/lib/vps/al-rifai/backups/
   # Confirm latest pg_dump exists and is readable
   ```

5. **Build new Docker image** (only when runtime code changed)
   ```bash
   docker build -t al-rifai-platform:<commit-sha> .
   docker tag al-rifai-platform:<commit-sha> al-rifai-platform:previous
   ```

6. **Apply migrations** (disposable PostgreSQL validation already done in CI)
   ```bash
   # Migration 004 is additive and idempotent — safe to apply
   pnpm db:migrate
   ```

7. **Deploy** (restart services using compose.yaml)
   ```bash
   docker compose up -d --build
   ```

8. **Verify deployment**
   - [ ] `/api/health` returns 200
   - [ ] Database/schema match (version 1.3.0)
   - [ ] HTTPS login works and intended pages render
   - [ ] WhatsApp worker checkpoints continue advancing when source rows arrive
   - [ ] `sync-worker --mode=status` shows `last_error: null`
   - [ ] No automatic financial posting (cash instructions remain in REVIEW)

9. **Preserve previous image** for rollback
   - Do NOT remove `al-rifai-platform:previous`

## Post-deployment

- [ ] Owner confirms live verification
- [ ] Mark `DEVELOPER_START_HERE.md` states updated if needed
- [ ] No automatic backfill of historical messages
