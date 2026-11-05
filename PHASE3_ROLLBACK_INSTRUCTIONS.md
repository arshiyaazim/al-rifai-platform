# Phase 3 Rollback Instructions

**Trigger:** Any failure after Phase 3 deployment (CI failure in production,
migration error, unexpected behavior, data integrity issue).

## Rollback Principles (mandatory)

1. **Disable new feature first** — stop affected services
2. **Restore previous Docker image** — do NOT do full DB restore
3. **Preserve new records** — do NOT delete data created by Phase 3
4. **No destructive git reset / force-push on main** — preserve history
5. **No automatic backfill** — do not reprocess historical messages

## Rollback Steps

### 1. Disable the new feature

Stop the WhatsApp router processing (prevents new messages from being routed
through Phase 3 code):

```bash
# Scale down the app or stop the worker
docker compose stop app
# or: docker compose stop worker
```

### 2. Restore previous Docker image

```bash
# Tag current (broken) image for reference
docker tag al-rifai-platform:current al-rifai-platform:broken-<date>

# Restore previous image
docker tag al-rifai-platform:previous al-rifai-platform:current
docker compose up -d
```

### 3. Verify rollback

- [ ] `/api/health` returns 200
- [ ] Previous functionality works (cash instructions, vessel programs, review queue)
- [ ] WhatsApp worker continues syncing (checkpoints advance)
- [ ] No errors in service logs

### 4. Preserve Phase 3 records

Do NOT:
- Delete `cash_instructions` created by Phase 3
- Delete `programs` created by Phase 3
- Delete `review_items` created by Phase 3
- Delete `cash_submissions` created by Phase 3
- Drop `processing_status` / `retry_count` / `last_error` / `last_processed_at` columns
- Run `git reset --hard` on `main`
- Force-push to `main`

### 5. Investigate and re-deploy

After root cause analysis:
- Fix the issue on `feature/phase3-router-cash-vessel`
- Create a new PR for review
- Follow the normal release gate (CI passes, migration verified, owner approval)

### 6. What rollback does NOT do

- ❌ Does not restore the entire database
- ❌ Does not delete Phase 3 data
- ❌ Does not force-push to `main`
- ❌ Does not run automatic backfill of historical messages
- ❌ Does not remove schema changes (additive migration remains)
