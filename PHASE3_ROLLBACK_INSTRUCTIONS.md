# Phase 3 Rollback Instructions

**Trigger:** failure after Phase 3 deployment (migration error, health failure,
unexpected behaviour or data-integrity concern).

## Principles

1. Disable the new feature before changing data.
2. Restore the previous application image; the 004–008 schema is additive and
   the Phase 2 application does not read the new tables/columns.
3. Preserve every Phase 3 record. Never delete raw messages, programs, cash
   instructions, postings, reversals, reconciliations, review items or audit
   history.
4. Never mutate `ledger_entries`, `cash_postings`, `cash_reversals` or
   `audit_events`; corrections are additive.
5. No `git reset --hard`, force-push or automatic history rewrite.
6. No automatic historical WhatsApp backfill.

## Steps

1. **Disable routing**
   Set `PHASE3_ROUTER_WORKER_ENABLED=0` and restart the app, then disable the
   database gate:
   ```sql
   UPDATE app_settings SET value='false'::jsonb WHERE key='phase3_router_enabled';
   ```
   The Live Router and the optional worker fail closed; pending messages remain
   stored. If Vessel was enabled, set `ALRIFAI_VESSEL_PROCESSING_ENABLED=0` as
   well; new Vessel messages are deferred, not consumed.

2. **Stop only the application services**
   ```bash
   docker compose stop app sync
   ```

3. **Restore the previous image**
   ```bash
   docker tag al-rifai-platform:<broken> al-rifai-platform:phase3-broken-<date>
   # pin the previous verified digest in compose, then:
   docker compose up -d app sync
   ```

4. **Verify rollback**
   - `/api/health` = 200.
   - Login and workspace pages render.
   - SQL check: schema remains `1.4.0`; Phase 2 app ignores the additive objects.
   - Sync checkpoints continue to advance.
   - No new error signature in logs.

5. **Preserve data**
   - Do not drop `cash_reversals` or `cash_reconciliations`.
   - Do not remove `cash_submissions.instruction_id`.
   - Do not delete rows created during the failed release.
   - Do not restore the whole database unless corruption is proven; a restore
     discards legitimate post-deployment records.

6. **Correct and re-release**
   - Fix on the feature branch, add a regression test, rebuild the image, and
     follow the release checklist again.
   - If a real financial posting was made incorrectly after an authorized
     deployment, use the reversal workflow (contra ledger entry + immutable
     reversal row); never edit the original posting.

## What rollback does NOT do

- Does not drop additive schema.
- Does not delete Phase 3 business/audit records.
- Does not force-push `main`.
- Does not automatically backfill WhatsApp history.
- Does not authorize live financial activity.
