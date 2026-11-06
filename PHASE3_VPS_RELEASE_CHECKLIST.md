# Phase 3 VPS Release Checklist

**Release candidate:** `feature/phase3-router-cash-vessel`
**Target schema:** `1.4.0` (migrations 002–008)
**Status:** CODE/TEST COMPLETE — production execution requires explicit Owner approval.

> Do NOT migrate, rebuild, restart or deploy production from this checklist until
> the Owner has approved the exact commit SHA, migration window and backup.

## 1. Pre-deployment evidence

- [ ] Owner approval recorded with the exact commit SHA and change list.
- [ ] CI/test evidence attached: typecheck, lint, 67/67 unit, 91/91 integration,
      Next.js build, Docker build, `pnpm audit --prod` clean.
- [ ] Migration `008_phase3_cash_lifecycle.sql` verified on a disposable copy of
      production data, not just the empty test DB.
- [ ] Fresh verified backup of `alrifai_v2`:
      `pg_dump -Fc`, SHA-256, `pg_restore -l` check, stored outside `/tmp`.
- [ ] Previous image digest and tag retained for rollback.
- [ ] Production business data preserved: 34k+ raw messages, chats, aliases,
      media, sync checkpoints, import runs.
- [ ] Owner-approved Phase 3 business chats, group participants and WA-01 Admin
      JIDs are recorded (not guessed).
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
- [ ] Sync checkpoints advance; `last_error` null for both accounts.
- [ ] WhatsApp bridge session stores untouched.
- [ ] No `phase3_%` settings are enabled until the Owner supplies the allowlist.
- [ ] Cash postings count is unchanged unless the Owner separately authorizes a
      real posting.

## 5. Post-deployment

- [ ] Owner confirms live verification.
- [ ] Record image digest, Git SHA, schema version, timestamp, RAM/disk.
- [ ] Preserve the pre-deployment dump and rollback image.
- [ ] Update `DEVELOPER_START_HERE.md` with the deployed state.
- [ ] Do not backfill historical WhatsApp messages automatically.
