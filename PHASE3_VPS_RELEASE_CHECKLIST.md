# Phase 3 VPS Release Checklist

> **Superseded status (2026-11-08):** this file records the executed 2026-11-06
> release (`1.4.0`). The current release candidate is
> `feature/phase3-010-011-release` @ `8a6c2c6ae8d082fc15235bd37e126117ad06f8c7`,
> target schema **`1.6.0`** (migrations **010 + 011**). Use
> `docs/PHASE3_PRODUCTION_RELEASE_AUDIT_20261108.md` as the current runbook.
> Production migrations 010 and 011 were applied in stages on 2026-11-08 and
> verified (`1.6.0`, 49 tables). Application image deployment/final verification
> is recorded in the handoff; Paid Events remains OFF.
>
> Current release gates: fresh verified backup; apply 010 then 011 **before**
> starting the new image; keep `PHASE3_PAID_EVENTS_ENABLED=0` at first deploy;
> pause the router worker during the deploy window; health/schema/grants/flag-off
> parity checks; Owner approval before any flag activation.
>
> **Do NOT migrate, rebuild, restart or deploy production from this checklist
> until the Owner has approved the exact commit SHA, migration window and backup.**

**Release candidate:** `feature/phase3-router-cash-vessel`
**Target schema:** `1.4.0` (migrations 002–008)
**Status:** EXECUTED 2026-11-06 18:14 UTC — see `docs/PHASE3_DEPLOYMENT_LOG.md`.

> Do NOT migrate, rebuild, restart or deploy production from this checklist until
> the Owner has approved the exact commit SHA, migration window and backup.

**Canonical execution runbook:** [`docs/PHASE3_CUTOVER_RUNBOOK.md`](./docs/PHASE3_CUTOVER_RUNBOOK.md)

## 1. Pre-deployment evidence

- [ ] Owner approval recorded with the exact commit SHA and change list.
- [ ] CI/test evidence attached: typecheck, lint, 69/69 unit, 95/95 integration,
      Next.js build, Docker build, `pnpm audit --prod` clean.
- [ ] Migration `008_phase3_cash_lifecycle.sql` verified on a restored copy of
      real production data (already rehearsed on `alrifai_v2_phase3_rehearsal`:
      34,420 messages preserved, 1.2.0 → 1.4.0).
- [ ] Fresh verified backup of `alrifai_v2`:
      `pg_dump -Fc`, SHA-256, `pg_restore -l` check, stored outside `/tmp`.
- [ ] Previous image digest and tag retained for rollback.
- [ ] Production business data preserved: 34k+ raw messages, chats, aliases,
      media, sync checkpoints, import runs.
- [ ] Owner-approved Phase 3 business chats, group participants and WA-01 Admin
      JIDs are recorded (not guessed).
- [ ] The exact cutover watermark per account is captured at the migration
      moment, not copied from an older audit.
- [ ] `PHASE3_ROUTER_WORKER_ENABLED` and `ALRIFAI_VESSEL_PROCESSING_ENABLED` are
      explicitly decided (both default `0`).
- [ ] Cash capability matrix approved: who may review, post, reverse and
      reconcile; whether approver and poster must differ.

## 2. Build and migration

1. Record current production state:
   ```bash
   curl -fsS https://app.al-rifai.iamazim.com/api/health
   docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'
   ```
2. Build the release image from the approved SHA (not a dirty checkout):
   ```bash
   docker build -t al-rifai-platform:<sha> .
   docker tag al-rifai-platform:<sha> al-rifai-platform:phase3-<sha>
   ```
3. Run migration preflight against a restored copy first, then production with
   the Owner-approved window:
   ```bash
   pnpm db:preflight    # current version, pending list, no change
   pnpm db:migrate      # additive, checksum-tracked, grants runtime role
   pnpm db:verify       # pending must be empty; version 1.4.0
   ```
4. Do not use `install --force` as the production migration path; use
   `db:migrate`. `--force` exists for additive repair, not as a version upgrade.

## 3. Deploy

- [ ] Preserve `.env`, media directory and WhatsApp bridge stores.
- [ ] Update the compose image pin to the approved digest.
- [ ] Restart only `app` and `sync`; do not touch bridges or PostgreSQL.
- [ ] Keep the previous image tagged and available.

## 4. Verify

- [ ] `/api/health` = 200, schema `1.4.0`, database ok.
- [ ] HTTPS login works; workspace pages render.
- [ ] Cash page loads; no automatic posting exists.
- [ ] A test instruction can be created in REVIEW and is visible in `/cash`.
- [ ] Review Queue loads; decisions are role-checked server-side.
- [ ] `/cash/[id]` shows instruction, ledger and audit history.
- [ ] A router-created Cash instruction can be assigned a paying account, then
      approved and posted by the authorized role.
- [ ] With Vessel disabled, a Vessel message stays `PENDING` (not COMPLETED).
- [ ] Sync checkpoints advance; `last_error` null for both accounts.
- [ ] WhatsApp bridge session stores untouched.
- [ ] No `phase3_%` settings are enabled until the Owner supplies the allowlist.
- [ ] `PHASE3_ROUTER_WORKER_ENABLED` remains `0` until the same approval; when
      enabled, the worker processes new rows automatically through the same router.
- [ ] Cash postings count is unchanged unless the Owner separately authorizes a
      real posting.

## 5. Post-deployment

- [ ] Owner confirms live verification.
- [ ] Record image digest, Git SHA, schema version, timestamp, RAM/disk.
- [ ] Preserve the pre-deployment dump and rollback image.
- [ ] Update `DEVELOPER_START_HERE.md` with the deployed state.
- [ ] Do not backfill historical WhatsApp messages automatically.
