# Phase 2 Handoff — Vessel/Escort Pipeline Overhaul

## Session Date
2026-11-09 (UTC)

## Last Completed Step
**Steps 10–19 code + Stage 1 deploy (schema 1.13.1).**

### 2026-11-10 — Steps 10–19
- Migration 019 applied: `MV ` stripped from 210 program names; `vessel.auto_confirm.shadow=false`; schema **1.13.1**.
- Parser-backed ORDER_INTAKE gate, `orderIntakeShift()` (15:30 Dhaka), Phase 2 template renderer, duplicate/master-correction, escort-change, weighted confirmation scorer, draft-delivery/Office-forward helpers, extended `/review` vessel queue, vessel UI event-date/escort-mobile/typeahead.
- WA-02: config documentation only; **no send**, no policy/socket/token host change.
- `tsc --noEmit` PASS; `next build` PASS; unit tests **152/152 PASS**.
- Image: `local/al-rifai-platform:vessel-1.13.1` deployed.
- Git commits: `9bf0d8b`, `a0b5ee0`, `42689ce`, `3f4aa9a`, `5a1c3b6` (not pushed; tag held).
- Stage 1 active: `ALRIFAI_VESSEL_PROCESSING_ENABLED=1`; draft worker/outbound remain `0`.

## Current Freeze State
**ACTIVE.** Live vessel processing and draft delivery are disabled.

```text
ALRIFAI_VESSEL_PROCESSING_ENABLED=0
ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0
ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=0
```

Freeze flags are explicit in `/opt/al-rifai-platform/compose.phase3.yaml`
(app and sync). The pre-freeze copy is
`/opt/al-rifai-backups/phase2/compose.phase3.yaml.pre-freeze`.

## Production State

| Item | Value |
|---|---|
| Branch | `feat/15-task-roadmap` |
| Migration commit | `6f60a77` |
| Pre-work HEAD | `bd0519d53584a7e83a73190ef68b2ea6f834a7e9` |
| Image | `local/al-rifai-platform:cash-final-eb70d91` |
| Image ID | `sha256:ed624cea52febf25800b0e6158450efea023bf7cc916d9dd9f04dcc72a668a3e` |
| Schema | **1.13.0** |
| Base tables | **56** |
| Applied migrations | **17** (`002`–`018`) |
| Freeze started | **2026-11-09T21:45:43Z** |
| Freeze cutover rowid wa-01 | **20006** |
| Freeze cutover rowid wa-02 | **15407** |
| WA-01 messages at freeze | 19,628 |
| WA-02 messages at freeze | 15,407 |
| Health | `200 {"status":"ok","database":"ok","schemaVersion":"1.13.0"}` |

## Backup

| Item | Value |
|---|---|
| Backup file | `/opt/al-rifai-backups/alrifai_v2_phase3_20261109T213450Z.pre-vessel-overhaul.sql.gz` |
| SHA-256 | `2ae538ff08a02edd8937c770aa76add16f39f74961958857377d9844646523f9` |
| `gunzip -t` | OK |
| Restore test | MATCH (52/52 tables before migration, 0 mismatch) |
| Scratch DB | `alrifai_v2_phase3_restore_20261109t213503z` (now at 1.13.0 after forward/rollback/re-apply test) |

## Cash Baseline (Step 19 regression gate)

| Metric | Value |
|---|---:|
| POSTED instructions | **2,361** |
| Amount (minor) | **121,195,500** |
| Amount (BDT) | **৳12,11,955.00** |
| Employees (all ACTIVE) | **218** |

Owner approved this updated baseline; it supersedes the older
2,359 / 121,155,500 / 222 values.

## What's Done

- [x] Step 0a: Production snapshot (git, image, schema, all table counts, cutover rowids)
- [x] Step 0b: Freeze applied via compose + app recreate; verified inside container
- [x] Step 0c: Backup + `gunzip -t` + SHA-256 + scratch restore MATCH
- [x] Step 0d: Freeze rowids and timestamp recorded
- [x] Step 1: Migration 018 created, scratch-tested (forward → rollback → re-apply), applied to production via runner
- [x] Migration commit `6f60a77` pushed to `origin/feat/15-task-roadmap`
- [x] Docs update (this file + DEVELOPER_START_HERE.md)

## What's Next (Next Session)

- [ ] **Step 2:** Snapshot `program_pay`, `vessel_draft_deliveries`, identity map into `*_snapshot` tables
- [ ] **Step 3:** Mark 39 pending PROGRAM reviews `SUPERSEDED` after snapshot
- [ ] **Step 4–9:** One transaction — truncate vessel tables → backfill orders → confirmations → releases → reattach `program_pay` → reattach deliveries (`delivery_suppressed`)
  - [ ] 5a: Rezaul forwarded-message investigation (flag vs text header)
  - [ ] Order backfill (multi-lighter, 5-day dedup, master correction, escort change)
  - [ ] Confirmation backfill (90% weighted score)
  - [ ] Release backfill (food ÷150, ±2 days, typo tolerance)
  - [ ] `program_pay` reattach (expected 52 of 106; 54 accepted loss)
  - [ ] Draft delivery reattach (suppressed; zero sendable rows)
- [ ] **Step 10–15:** Code changes (parser-backed gate, `orderIntakeShift()`, template D2/D3, duplicate/correction/escort-change, confirmation scorer shadow mode, draft delivery flags, Office Group forward flag)
- [ ] **Step 16:** Review queue API + `/review` UI
- [ ] **Step 17:** WA-02 infra (admin_jids, `messages.send` policy, socket, token; no AI agent yet)
- [ ] **Step 18:** `/vessel` UI (Event Date first column, typeahead dropdowns, Escort Mobile)
- [ ] **Step 19:** Verify + deploy + unfreeze in stages; then tag `v1.13.0`

## Locked Decisions (D1–D14)

- **D1:** Event date = WhatsApp `source_timestamp` in Asia/Dhaka. Stated loading/booking dates never override it.
- **D2:** Render `MV ` (no dots) before both Mother and Lighter names.
- **D3:** Template: Mother once; per lighter Lighter/Master/Destination/Escort Name/Escort Mobile/`DD.MM.YYYY (D|N)`; footer `Al-Rifa'I Integrated Services`.
- **D4:** Parser-backed gate replaces `looksLikeVessel()`; ORDER_INTAKE direct incoming bypasses `classifyDomain()`. Forwarded messages count.
- **D5:** Same Mother+Lighter within 5 days = duplicate. Different Master Mobile inside the window = correction; later mobile wins; audit `VESSEL:MASTER_MOBILE_CORRECTED`.
- **D6:** Same order + different escort name and mobile = escort change; link via `escort_change_from_program_id`.
- **D7:** Admin OUTGOING to the same client chat with ≥90% weighted match = CONFIRMED. Score: Mother 25, Lighter 25, Master 20, Escort mobile 15, Escort name 10, Date/Shift 5. 75–89 review; <75 not confirmation.
- **D8:** Client re-sending an Admin-originated message is an ISSUE candidate, not confirmation/order. Client-supplied escort fields go to review.
- **D9:** Release sources: release group text, direct messages, later OCR. Match escort mobile + master/lighter mobile = 95%; or escort mobile + food_bill/150 ±2 days. Wrong mobile never accepted. Typo tolerance required.
- **D10:** Reattach 52 `program_pay`; accept loss of 54. Mark 39 pending PROGRAM reviews `SUPERSEDED` after snapshot.
- **D11:** Central `/review` page with sender identity, exact message, system reason, workflow selector, workflow fields, comment, Approve/Reject/Save draft/Send back.
- **D12:** WA-02 = `01958122300` → `8801958122300@s.whatsapp.net`; resolve PN/LID and Admin JIDs read-only, write `admin_jids`.
- **D13:** `system_feature_flags` hot toggles for thresholds and stage switches; env flags only for freeze/unfreeze.
- **D14:** Per-pipeline idempotency keys, `message_pipeline_state`, advisory locks, new shared helpers only.

## Owner Rules (10)

1. **Order qualification:** Mother + Lighter + Master Mobile; only the 4 direct ORDER_INTAKE contacts; receiver WA-01 `8801880446111`; duplicates within 5 days skipped.
2. **Detective vessel logic:** mobile attached = Lighter; no mobile = Mother; `AT-O/A` + foreign proper noun = Mother; MV prefix is not a signal.
3. **Date/shift:** event date from Dhaka timestamp; `<15:30` = D, `>=15:30` = N; explicit `(D)/(N)` wins.
4. **Draft template:** exact Rule 4 layout; Escort Name/Mobile blank; store draft text; deliver via the approved bridge path.
5. **Confirmation:** Admin OUTGOING to the same client chat with the assignment data = CONFIRMED; no review for a unique/latest match.
6. **Bridge-2 → Bridge-1 draft delivery:** queue drafts for Admin; backfill drafts are suppressed; no real send during backfill.
7. **Office Group:** may supply escort assignments, but only Admin-to-Client OUTGOING confirms; Office Group alone never confirms.
8. **Duplicate window:** 5 calendar days; audit `VESSEL:DUPLICATE_SKIPPED`; different Master inside window = correction.
9. **Legacy data:** delete/reparse is acceptable; preserve `program_pay` and delivery rows where possible; document loss.
10. **Release:** discover and preserve the text-based release workflow; OCR/image processing is deferred.

## Key Files

- Forward migration: `db/standalone/018_vessel_overhaul.sql`
- Rollback: `db/standalone/rollback/018_vessel_overhaul.rollback.sql`
- Runner: `scripts/standalone/migrate.mjs`
- Checkpoints: `/opt/al-rifai-backups/phase2/step-*.json`
- Backup: `/opt/al-rifai-backups/alrifai_v2_phase3_20261109T213450Z.pre-vessel-overhaul.sql.gz`
- Bridge DB: `/var/lib/vps/whatsapp/wa-01/store/messages.db`
- WA-01 outbound socket: `/wa-01-control/mcp.sock`
- WA-01 outbound token: `/etc/alrifai/wa-01-send.token`

## Rollback Convention

- Forward: `db/standalone/NNN_name.sql` (top level only).
- Rollback: `db/standalone/rollback/NNN_name.rollback.sql`.
- Never place `*.rollback.sql` at the top level: the runner would treat it as a
  forward migration.

## How to Resume

1. Read this file and `DEVELOPER_START_HERE.md`.
2. Check `/opt/al-rifai-backups/phase2/step-*.json` for the last completed step.
3. Verify freeze is still active:
   `docker compose -p al-rifai-phase3 exec app printenv | grep ALRIFAI_VESSEL`
4. Verify schema and Cash baseline:
   `schema_version=1.13.0`, Cash `2,361 / 121,195,500 / 218`.
5. Continue at **Step 2**. Do not unfreeze or send WhatsApp messages until
   Step 19 and explicit Owner approval.
