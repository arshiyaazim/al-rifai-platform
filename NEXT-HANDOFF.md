# NEXT-HANDOFF

**Session ended:** 2026-11-08
**ACTIVE GOAL (unchanged): Authenticated Production UI Verification — status
BLOCKED, not complete.** A README or source change does not complete it.
**Read first:** `AGENTS.md`, `docs/PROJECT_KNOWLEDGE.md`,
`docs/VESSEL_ORDER_DRAFT.md`, `docs/LEGACY_PHASE3_COMPARISON.md`,
`docs/PRODUCTION_URLS.md`, `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`,
`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`, `docs/MAIN_RECONCILIATION_PLAN.md`,
`docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`,
`docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`, `docs/BUSINESS_WORKFLOW_BACKLOG.md`,
`docs/PHASE3_GO_NO_GO_7da17f1.md`, `docs/WHATSAPP_MESSAGE_MIRROR.md`, `docs/WHATSAPP_MESSAGE_INTELLIGENCE.md`, `docs/ESCORT_ORDER_RELEASE_WORKFLOW.md`.

**Report language:** English only. Always state whether a finding is
**implemented**, **clone-tested**, **production-deployed**, **live-verified**,
**OWNER-CONFIRMED** or **BLOCKED**.

---

## 2026-11-08 — Escort order → confirmation → register → release workflow

**Branch:** `feature/phase3-010-011-activation`
**Status:** implemented, clone-tested and runtime-verified on a disposable
database; **production migration 013 and deployment pending Owner approval.**

- Added explicit conversation source roles (`whatsapp_chats.source_role`):
  direct verified Escort Client chats are `ORDER_INTAKE`; the Accountant chat is
  `CASH_ONLY`; the approved Support group is `SUPPORT_ONLY`; the Release
  Information group is `RELEASE_ONLY`; the remaining approved vessel group is
  `OTHER_APPROVED`; unclassified groups are `REVIEW_REQUIRED`.
- Order Drafts now require WA-01 + DIRECT + ORDER_INTAKE + INCOMING + an EXACT
  canonical PN identity match. Groups never create Drafts; Cash/WA-02 never
  enter the vessel workflow.
- Admin confirmation is restricted to a verified Admin OUTGOING reply in the same
  original client chat, matched through `lib/vessel-match.ts`, and persists
  confirmation message/chat/sender/account/timestamp.
- Release is restricted to the approved Release Information group; it updates
  the exact existing program with `end_date`, `end_shift` and release
  provenance, preserves start date/shift, and is idempotent.
- Migration `013_escort_workflow_authorization.sql` (additive, schema 1.8.0).
- Tests: `pnpm test:standalone` **231/231** (40 new workflow tests), unit
  **149/149**, typecheck clean, lint 0 errors. Fresh install and 1.7.0 → 1.8.0
  upgrade verified on the disposable database.
- Runtime: order → DRAFT, Admin reply → CONFIRMED, Release group → RELEASED with
  End Date/Release Shift while Start Date/Shift were preserved; `/vessel`,
  `/vessel/{id}`, `/messages` and `/api/programs` returned HTTP 200.
- No production migration, deployment, restart, WhatsApp send or Cash/Ledger
  write. No Git push.

---

## 2026-11-08 — WhatsApp Message Intelligence (unified table) implemented

**Branch:** `feature/phase3-010-011-activation`
**Status:** implemented and runtime-verified on an isolated dev server against
`alrifai_v2_test`; **production migration/deployment pending Owner approval.**

### What was added

- Migration `012_whatsapp_message_intelligence.sql` (additive, schema `1.7.0`,
  51 tables): `whatsapp_messages.mirrored_at`, `whatsapp_calls`,
  `whatsapp_message_intelligence`, read-only
  `whatsapp_message_intelligence_view`, indexes and grants.
- Sync worker: `mirrored_at`, bridge `calls` mirror, `whatsapp.db` contact
  evidence (saved name / Owner contact name / push name / lid↔pn), full reconcile
  and explicit media status.
- Existing `/messages` repository/API/table extended: all mandatory columns,
  search/filter/sort/pagination, column visibility/pinning, row detail,
  identity/domain review (`POST /api/messages`, `whatsapp.manage`, audited).
- Calls panel shows actual `whatsapp_calls` events; per-message call columns are
  `NOT_AVAILABLE` because calls have no message_id.
- `docs/WHATSAPP_MESSAGE_INTELLIGENCE.md` records the data contract, sources,
  timestamp rules, media/call semantics and rollback.

### Verification

- `pnpm typecheck` clean; `pnpm lint` 0 errors.
- `pnpm test:unit` 149/149.
- `pnpm test:standalone` **190/190**.
- Isolated dev server against `alrifai_v2_test`:
  - `/messages` HTTP **200** with the Message Intelligence table and all required
    column labels.
  - `/api/messages?limit=2` returned event/ingestion/mirror times, names, mobile,
    identity, role, domain, media and call fields.
  - `POST /api/messages` classification **200**; role filter returned exactly the
    reviewed row; audit row present.
- No production migration, build deploy, container restart or data write.

### Remaining approvals

1. Apply migration 012 to production (49 → 51 tables, schema 1.7.0).
2. Deploy the app and updated sync worker; verify `/messages`, API, call panel
   and role/domain review.
3. Run the previously approved mirror reconcile/media-status steps after backup.
4. Bridge 2 → Bridge 1 draft delivery remains the separate blocked business
   workflow.

---

## 2026-11-08 — WhatsApp MCP → Main Database mirror audit and fix

**Read-only audit + code fix; production repair/redeploy pending approval.**
Bridge stores: `/var/lib/vps/whatsapp/wa-01/store/messages.db`,
`/var/lib/vps/whatsapp/wa-02/store/messages.db`.
Main DB: `alrifai_v2_phase3`, `whatsapp_messages` / `whatsapp_media`.

### Current production evidence (17:01Z)

| Metric | WA-01 | WA-02 |
|---|---:|---:|
| Source messages | 19,490 | 15,333 |
| Main messages | 19,490 | 15,333 |
| Missing / extra / duplicate | 0 / 0 / 0 | 0 / 0 / 0 |
| Field mismatches | 3 timestamps (late edits) | 0 |
| Checkpoint lag | 0 | 0 |
| Source media messages | 3,414 | 2,351 |
| `whatsapp_media` rows | 133 (STORED 133) | 227 (STORED 121, FAILED 106) |
| Missing media rows | 3,281 | 2,124 |
| Source media with URL/key | 3,256 / 3,256 | 2,016 / 1,893 |

- The **message mirror is complete at record level** for both bridges; continuous
  tail sync is working (checkpoint caught up; new rows written).
- The three WA-01 timestamp mismatches are **late source edits** (content and all
  other fields match); the old worker never re-read old rows. New
  `--mode=reconcile` fixes this.
- The **media mirror is partial**: the main DB has metadata (type/filename/SHA/
  length) for every source media message, but 5,405 source media messages have no
  `whatsapp_media` row and only 254 files are stored. Historical import skipped
  media by design. Most missing rows still have a source URL/key; a controlled
  media backfill can copy many, subject to CDN expiry.

### Code changes (branch `feature/phase3-010-011-activation`)

- `scripts/sync-worker.mjs`
  - full `--mode=reconcile` (startup + every `SYNC_RECONCILE_EVERY` rounds; default 60);
  - update predicate now compares all mirrored fields, so late edits/revocations
    are applied;
  - `raw_payload.content_base64` preserves exact bytes when PostgreSQL cannot
    store NUL/lone surrogates;
  - `--mode=media-status --confirm` creates explicit `STORED`/`FAILED`/`SKIPPED`
    rows for every capturable source media message, with
    `SYNC_MEDIA_BACKFILL_LIMIT` (default 200) and permanent-skip handling;
  - checkpoint still advances only after the committed insert/update; failed
    batches do not advance and retry.
- `scripts/verify-message-mirror.mjs` — read-only source↔main field comparison,
  media coverage and checkpoint report; `--strict` / `--strict-media`.
- `tests/standalone/message-mirror.test.mjs` — disposable SQLite + test DB:
  historical import, late-edit reconcile, idempotency, media `SKIPPED`, verifier.

Tested in the disposable DB: import 3/3 per bridge; late edit updated; second
reconcile `written=0`; media status `SKIPPED MEDIA_SOURCE_METADATA_ABSENT`;
verifier `COMPLETE`; failed 70k-text batch did not advance checkpoint and
recovered after correction.

### Remaining approvals / work

1. Rebuild/recreate the **sync** service with the updated worker (production
   image/container change; requires approval).
2. Run `--mode=reconcile` once on production (3 late-edit updates; requires
   approval).
3. Run `--mode=media-status --confirm` in bounded batches (creates 5,405 status
   rows; attempts up to 5,272 files with URL/key; requires approval and storage/
   expiry monitoring).
4. Bridge 2 → Bridge 1 Escort Draft delivery remains a separate blocked
   business/authorization change (WA-02 `admin_jids=[]`, identity-only policy;
   WA-01 draft worker disabled).

---

## 2026-11-08 — Vessel Draft activation deployed; first send awaiting exact approval

**Branch:** `feature/phase3-010-011-activation`
**Source commit:** `b379dd2`
**Image:** `local/al-rifai-platform:phase3-ai-rc-vd-b379dd2`
**Image ID / digest:** `sha256:aec08d34f7f04b1a49495f74ec33ff29f21c7268e6e58e7948c83459ffa5602a`
**Rollback image:** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`
**Backup:** `/var/backups/al-rifai/vessel-activation-20261108T110032Z.dump`
(SHA-256 `c093ec2d…aaee8`, 8.7 MB, 382 TOC entries)
**App:** recreated only; healthy. Sync remains on `phase3-ai-rc-8a6c2c6`.
**Schema:** unchanged `1.6.0`, 49 tables, migrations 002–011.

### Recipient correction

The previous Admin-participant fallback was removed. Delivery now targets the
**same original authorised order-giving conversation**:

- direct Escort Client chat → that exact direct JID/LID;
- approved ORDERS group → that exact group JID;
- source message must be unique; program source chat must match it exactly;
- chat must be in `app_settings.phase3_business_chats:wa-01` and authorised
  `ORDERS`/`BOTH`;
- group sender must be an active approved participant; direct sender must match
  the chat identity;
- missing/ambiguous/mismatched evidence blocks and audits.

The worker re-runs this resolution before every send.

### WA-01 transport

One new WA-01 consumer was added to the existing Bridge policy:

| Item | Value |
|---|---|
| Consumer | `alrifai-wa-01-send` |
| Capabilities | `messages.send`, `native.identity.read` |
| Token | `/etc/vps/apps/al-rifai/auth/wa-01-send.token` (0400, uid 10001) |
| Policy | `/etc/vps/services/whatsapp/wa-01-consumer-policy.json` (0600, uid 10002) |
| Native profile | identity-only entry `epoch:1, chats:[]` |
| App mount | `/var/lib/vps/whatsapp/wa-01/control` → `/wa-01-control` (ro), token → `/etc/alrifai/wa-01-send.token` (ro) |
| App group | supplementary GID 10002 |
| Verified | identity `8801880446111:27@s.whatsapp.net`; `send_message` capability probe returned “Recipient must be provided” without sending |

The secured MCP broker requires the standard lifecycle (`initialize`, then
`notifications/initialized`, then `tools/call`); `lib/standalone/whatsapp.ts` now
does this.

### Live gate and queue

- `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1`
- `app_settings.vessel_draft_outbound_enabled=true`
- `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0` (intentionally disabled until the
  first approved send is verified)
- 9 Owner-approved business conversations; 8 unqueued DRAFTs; 0 delivery rows.
- Host preflight: `mode=OUTBOUND_APPROVED`, no gate reasons, sender verified.

### Duplicate disposition

The five programs from the multi-lighter direct order are five distinct
lighters, not duplicates. `prog_b349…` and `prog_df6a…` are the only duplicate
conflict (same mother/lighter/date/mobile, different shift/source); both were
left out of the queue. Recommended unique candidate:
`prog_412b6c5476ee4992e0db1c6e` (Beltokyo / Nil-Doria, 2026-11-07 D) to the
original ORDERS group `120363426895117693@g.us`.

No message has been sent. The exact candidate and message text are in
`docs/VESSEL_DRAFT_ACTIVATION_APPROVAL_PACKAGE.md`; the first send requires the
Owner's explicit approval of that exact delivery.

---

## 2026-11-08 — Vessel Draft activation wiring + Cash eight-card verification

**Branch:** `feature/phase3-010-011-activation` (new isolated worktree
`/opt/al-rifai-phase3-activation`, from deployed release `03df822`).
**Production:** unchanged — image `phase3-ai-rc-8a6c2c6`, schema `1.6.0`,
migrations 002–011, 49 tables, 0 delivery rows, 0 Paid Events, 0 posting links.
**Status:** implemented, typechecked, linted, built and tested; **not deployed**
and **no message sent**.

Added:

- `lib/standalone/vessel-draft-recipient.ts` — resolves the recipient as the
  **same original authorised order-giving conversation**. It requires the
  source message to be unique, `programs.source_chat_jid` to match it exactly,
  the chat to be in the Owner-approved business allowlist and authorised for
  ORDERS/BOTH, an INCOMING message, and an approved group participant or a
  matching direct-chat sender. Admin JIDs are never a fallback; missing,
  ambiguous or mismatched evidence is audited and never queued.
- `lib/vessel-draft-delivery.ts` — the gate accepts only the Owner-approved
  business conversation list (and an optional exact pin);
  `isApprovedDraftRecipient()` is the single recipient rule.
- `lib/vessel-draft-transport.ts` — `verifyVesselDraftSender()` calls
  `get_native_account_identity` and compares it with the approved sender.
- `lib/vessel-draft-delivery-worker.ts` — re-resolves the source
  conversation and verifies the bridge identity before every `send_message`; a
  mismatch is a bounded `FAILED` with no transport call.
- `lib/standalone/vessel-draft-delivery-store.ts` + `programs.ts` — enqueue
  resolves the recipient instead of requiring a hardcoded JID; runtime config
  loads the WA-01 business conversation allowlist.
- `scripts/standalone/vessel-draft-activation.mjs` — read-only preflight by
  default, optional `--verify-sender`, controlled `--enqueue` / `--tick` behind
  confirmation flags; identities masked.

Verification (disposable `alrifai_v2_test`, schema 1.6.0):

| Check | Result |
|---|---|
| `pnpm typecheck` | clean |
| `pnpm lint` | 0 errors, 2 pre-existing warnings |
| `pnpm test:unit` | 149/149 |
| `pnpm test:standalone` | 180/180 |
| `pnpm test:paid-events` | 23/23 |
| `pnpm build` | pass |

Image built locally (not deployed):
`local/al-rifai-platform:phase3-ai-rc-activation-03b1526`, digest
`sha256:d7ae28d210f97edda9d8f05e0ea79e0f2dce82b64f1377d12ef97e222342386f`.
Rollback/production image remains `phase3-ai-rc-8a6c2c6`
(`sha256:8b7ab534…e510`). The exact approval package is
`docs/VESSEL_DRAFT_ACTIVATION_APPROVAL_PACKAGE.md`.

Cash: no code change. Flag OFF keeps POSTED-only totals; flag ON uses verified
Paid Events plus legacy POSTED with no double count. All eight card values come
from the same summary and their links route to `/cash/paid` with server-side
filters; WhatsApp + Office equals the total card. `PHASE3_PAID_EVENTS_ENABLED`
remains OFF.

**Still blocked (Owner approval, not code):**

1. WA-01 consumer policy has no `messages.send`; the app container mounts no
   WA-01 socket/token. A narrow send token, mount and exact sender/recipient are
   required before any real draft can leave.
2. Production deployment of this branch.
3. `PHASE3_PAID_EVENTS_ENABLED=1`.
4. One controlled real send (`--tick --limit=1 --confirm-send`) with the exact
   sender/recipient/message reported first.

---

## 2026-11-08 — Migration 010/011 execution (staged, authorized)

**Branch:** `feature/phase3-010-011-release` (from integration `0b309b2`).
**Final release commit:** `8a6c2c6ae8d082fc15235bd37e126117ad06f8c7`.
**Production migrations:** 010 applied first (47 tables, schema 1.5.0), verified;
then 011 applied (49 tables, schema 1.6.0), verified. Both checksums match.
**Production image:** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`, image ID /
digest `sha256:8b7ab534838f670c9b6486015650711e266dea4d3f8b2ac4df287d5be1c3e510`.
App/sync recreated from that image; app healthy.
**Paid Events:** `PHASE3_PAID_EVENTS_ENABLED` remains OFF/absent; 0 Business
Paid Events, 0 posting links.
**Backup:** fresh `pg_dump -Fc` created and verified before migration
(`phase3-release-010011-20261108T084939Z.dump`, 8.6 MB, SHA-256
`d88b0f0f173732a1ca3cfcb812ed9489aa9d443f4bfc5ed3d3ace0be4c22ae77`, 344 TOC).
**Data:** critical row counts unchanged through migration (employees 218,
programs 102, attendance 439, instructions 3,840, postings 1,586, ledger 1,586,
submissions 117, review 20, messages 34,743 at migration gate).
**Migration 010 implementation:** durable queue + producer hook + default-
disabled worker + narrow WA-01 `send_message` adapter + retry/terminal states +
Admin status. Outbound gate remains OFF; no message sent.
**Router post-deploy:** worker started after verification; 147 messages
processed, 41 Cash REVIEW created, 4 Vessel DRAFT created, 0 Paid Events,
0 postings, 0 outbound sends.

---

## 2026-11-08 — Git completeness audit and migration technical documentation

**Branch:** `feature/phase3-docs-audit` (from integration `0b309b2`).
**Mode:** documentation-only; no source/SQL/runtime change.

Verified:

- Integration contains every router and cash feature commit; no commits are
  missing. All feature tips and integration are pushed and clean.
- Canonical `main` dirty files are preserved but superseded/duplicate/obsolete:
  the old `finance.ts` insert, old invalid 011, duplicate 010, earlier reports
  and a pre-sidebar layout backup contain no unique required work.
- New migration references:
  `docs/MIGRATION_010_VESSEL_DRAFT_DELIVERY.md`,
  `docs/MIGRATION_011_CASH_PAYMENT_EVENTS.md`.
- New Git audit: `docs/PHASE3_GIT_COMPLETENESS_AUDIT.md`.
- Current WA-02 scope (identity-only) is documented separately from the
  unverified Owner-intended Bridge-2 → Bridge-1 order-draft workflow. No
  permission or field rule was invented.
- 010 is a durable queue only; automatic WhatsApp delivery is **NOT IMPLEMENTED**
  (no worker caller, no `send_message` path). Current delivery is
  `MANUAL_COPY_ONLY`.
- 011 adds Business Paid storage; production remains schema `1.5.0`, with no
  Business Paid Events and no activation.

No production migration/deployment/restart/flag change or historical backfill
was performed.

---

## 2026-11-08 — Production release preparation audit (read-only)

**Candidate:** `feature/phase3-integration` @
`0b691a223949e9a413589db9e5f3dcd3366448e3`.
**Status:** production readiness evidence and runbook prepared; **no production
migration, deployment, restart or flag activation was performed.**

Key findings:

- Production still runs image `phase3-ai-rc-7da17f1`
  (`sha256:5f3de875…01fa`), schema `1.5.0`, 46 tables, 8 migrations.
- Production router gate is ON (WA-01 watermark 19634, 9 business chats; WA-02
  zero business chats). Router worker and Vessel processing are ON. Paid Events
  is absent/OFF.
- A verified 8.5 MB pre-deploy backup was restored into an isolated PostgreSQL
  16 copy. Migration 010+011 produced schema `1.6.0`, 49 tables, 10 migrations,
  preserved all restored row counts, repeat migration was a no-op, grants and
  immutable triggers are present, app health returned 200/`1.6.0`, and a
  temporary failing migration rolled back cleanly.
- Isolated HTTP checks: unauthenticated `/cash` redirects to login; Business
  Paid API returns 401 unauthenticated; admin routes 200; staff correction is
  403 `CAPABILITY_REQUIRED`; admin correction without CSRF is 403
  `CSRF_DENIED`; admin correction/reversal succeeds and leaves zero posting/
  ledger rows.
- Historical aggregates: 3,836 cash instructions, zero Business Paid Events,
  2,339 payment-format messages, 1 potential multi-block message, 117 pending
  submissions (72 missing core fields), 39 unregistered employee mobiles and
  1,401 unregistered payouts.
- **Critical deployment order:** apply 010/011 **before** starting the new
  image because `/cash/paid` queries the 011 table even with Paid Events OFF.
- Fresh backup, production migration window, image build/tag approval, router
  pause and Owner sign-off remain outstanding.

Full evidence/runbook:
`docs/PHASE3_PRODUCTION_RELEASE_AUDIT_20261108.md`.

---

## 2026-11-07 — Phase 3 integration + Admin Business Paid API/UI (isolated)

**Branch:** `feature/phase3-integration`
**Base:** `a4aabb6` (cash Paid) + merged router `4e2e3f4`.
**Status:** isolated integration implementation; **not merged to main, not
deployed, not migrated in production.** `PHASE3_PAID_EVENTS_ENABLED` remains OFF.

Delivered:

- Merged router/vessel/release work with cash/Paid work; preserved cutover
  watermark, business-chat allowlists, WA-01/WA-02 restrictions, Vessel draft
  and release evidence.
- Resolved the six known conflict files. `app/(workspace)/cash/page.tsx` keeps
  the cash dashboard/CashPaymentForm and the router `canSubmit`, `canPost`,
  `canLedger`, `canDecide` gates.
- Fresh install and migration chain include 010 + 011; schema `1.6.0`, 49 tables.
- `GET /api/finance?resource=business-paid` list with date/employee/source/search
  filters and pagination.
- `GET /api/finance?resource=business-paid-event&id=...` detail with root
  PAYMENT chain, employee, WhatsApp/Office evidence, instruction/posting link,
  correction/reversal history and audit.
- `/cash/paid` list and `/cash/paid/[id]` detail, plus nav link.
- `business-paid.correct` / `business-paid.reverse` API actions reusing existing
  ADMIN + `cash.review` server functions, CSRF path and append-only design.
- Dashboard summary and Business Paid views use the business basis when the flag
  is on; `/cash/transactions` is explicitly labelled Financial POSTED and links
  to the Business Paid view.
- Fixed `event_id` propagation in the business paid list so detail links work.

Evidence (isolated PostgreSQL 16 only):

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors |
| Unit | 147/147 |
| Integration | 163/163 |
| Build | pass; `/cash/paid` and `/cash/paid/[id]` emitted |
| Fresh install | schema 1.6.0, 49 tables, 10 ledger rows |
| Incremental 1.5.0 → 1.6.0 | 010 then 011; repeat no-op |
| Runtime grants | vessel READ_WRITE; Paid tables append-only |
| Production | unchanged |

Known limitations: no automatic retroactive Business Paid backfill, no historical
multi-block recovery for messages already linked, and old pending Office
candidates may need correction before strict approval.

---

## 2026-11-07 — Phase 3 Cash Business Paid implementation (isolated)

**Branch:** `feature/phase3-cash-paid-events` (worktree
`/opt/al-rifai-phase3-cash`), based on `13d660c`.
**Status:** implementation, tests, migrations and documentation complete in
isolation. **Not merged, not deployed, not applied to production.** Feature flag
`PHASE3_PAID_EVENTS_ENABLED` is OFF by default.

Delivered:

- WhatsApp automatic Business Paid without Office approval, at the verified
  Admin→Accountant routing point; no automatic `postInstruction()`, no
  `cash_postings`, no `ledger_entries`.
- Final single-mobile rule: one number is both `employee_mobile` and
  `payout_mobile`; two numbers keep ID + payout; 3+ are ambiguous.
- All clean payment blocks in one message are processed, not only the first.
- Parser regression coverage for hyphenated numbers, `(C)/(R)/BANK`, `Tk:`,
  next-line amounts, `{B)`, `---`, `500-` and missing methods. A method is never
  fabricated as `cash`.
- Office approval creates exactly one `OFFICE` event when the flag is on;
  pending/rejected submissions create none.
- Migration 011 repaired to valid PostgreSQL; append-only PAYMENT / CORRECTION /
  REVERSAL design; separate posting-link table; `1.6.0`.
- Migration 010 recovered byte-for-byte from `3e0dd01` and added to the fresh
  installer/grants. It remains inert; no sender or worker was activated.

Evidence (isolated PostgreSQL 16 container; production untouched):

| Check | Result |
|---|---|
| Typecheck | 0 errors |
| Lint | 0 errors, 2 pre-existing warnings |
| Unit | 117/117 |
| Integration | 144/144 |
| Build | pass |
| Fresh install | schema 1.6.0, 49 tables, 10 ledger rows |
| Incremental 1.5.0 → 1.6.0 | 010 then 011; repeat no-op |
| Failed migration probe | exit 1; probe table and ledger row rolled back |
| 010 SHA-256 | `fa299768…17e7c7` |
| 011 SHA-256 | `4203fdbe…964165` |

Canonical `/opt/al-rifai-platform` remains on `main` with its pre-existing dirty
files preserved, including
`app/(workspace)/layout.tsx.backup-20261107-192036`.

Next authorized steps (require separate approval): review/merge the branch,
back up production, rehearse 010/011 on a production copy, apply migrations,
deploy with the flag OFF, verify parity, then enable the flag. Rollback is
setting the flag to `0`.

---

## Earlier session state (2026-11-07)

| Item | Value |
|---|---|
| **Production runtime (DEPLOYED)** | `local/al-rifai-platform:phase3-ai-rc-7da17f1`, digest `sha256:5f3de875…01fa` |
| Rollback image (available) | `local/al-rifai-platform:phase3-ai-rc-86d659a`, digest `sha256:932ef856…a5` |
| Superseded candidate | `phase3-ai-rc-9e85e49`, digest `sha256:cb8de252…` |
| Verification image (built, **NOT deployed**) | `phase3-ai-rc-675a3ef` — post-deployment workflow fixes |
| `.env` `ALRIFAI_TAG` | **aligned to `phase3-ai-rc-7da17f1`** with Owner approval; backup `/var/lib/vps/al-rifai/backups/al-rifai.env.pre-tag-align-20261107T144038Z` preserves previous `86d659a` |
| Git `main` | `0861e05` (clean; does **not** contain the code fixes) |
| Working tree / branch | `/opt/al-rifai-phase3-test`, `feature/phase3-router-cash-vessel`, pushed, clean |
| Database schema | `1.5.0`; **NO MIGRATION APPLIED to production**; additive `010_vessel_draft_delivery.sql` written, clone-tested, **pending Owner approval** |
| Compose project | `al-rifai-phase3`; a bare `docker compose up -d` now keeps `7da17f1` |
| Clone | `alrifai-ui-check` on `127.0.0.1:3007`, DB `alrifai_v2_import_test` |

## What changed this session

1. **Task 1 — `.env` tag alignment (Owner-approved).** Read-only verification
   confirmed running containers on `7da17f1` while `.env` recorded `86d659a`,
   and that a bare Compose command would have reverted to the rollback image.
   After explicit approval, **only line 61** was changed to
   `ALRIFAI_TAG=phase3-ai-rc-7da17f1`. Backup created; `root:root 600` and file
   size preserved; raw `diff` shows exactly one line; `docker compose config`
   now resolves both services to `7da17f1`; running container IDs/uptime
   unchanged (no restart/recreate); health still OK.
   Docs: `docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`, commit `00e25a7`.
2. **Task 2 — authentication root cause (NO defect) + OWNER CONFIRMATION.**
   Traced the full pipeline. The earlier `400 CREDENTIALS_REQUIRED` came from
   requests with an **empty password**: `lib/unified-auth.ts:118` fires before
   user lookup/verification. The 0-byte bootstrap files are read **only** by
   provisioning CLIs, never by login. All three accounts have valid PBKDF2
   hashes (118 chars, correct format), unchanged roles/capabilities (ADMIN 30,
   USER 10/10), **8 successful `LOGIN` events + 4 live sessions**.
   **The Owner explicitly confirms `Admin`, `officeassistant` and
   `officeazzistant2` all log in with their current passwords — authentication
   is operational, no reset/replacement/provisioning/hash/role change needed.**
   Status distinction: **OWNER-CONFIRMED login** vs **AGENT-VERIFIED
   authenticated UI (pending)**. 15 saved cookie jars remain clone-only (zero
   production match). **No credential was changed.**
   Docs: `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`.
3. **Task 1 — authenticated UI still NOT TESTED (Agent).** The Owner selected
   the **root-only session cookie jar** as the minimum secure access
   (`/etc/vps/apps/al-rifai/verification-session.cookies`, `root:root`, `400`);
   **it does not exist yet**, so no automated verification is claimed. Added
   `scripts/owner-assisted-ui-verify.sh` — a read-only, `bash -n`-clean,
   no-secret-output Owner-assisted procedure (27 routes × 2 hosts, nested URLs,
   7 CSV exports, search/filters/pagination, role control counts). A full
   VERIFIED/PARTIAL/FAILED/NOT TESTED matrix with 41 read-only route checks on
   both hosts is in `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`. No 500s; all
   protected routes 401/307. Never ask for passwords in chat/Git/docs.
4. **Task 4 — durable Vessel Draft delivery infrastructure (implemented, NOT
   deployed, NOT enabled).**
   - Migration `db/standalone/010_vessel_draft_delivery.sql`: one new table
     `vessel_draft_deliveries` + 4 indexes, `CHECK account_id='wa-01'`,
     UNIQUE `(program_id, content_hash, recipient_jid)`. **Not applied to
     production.**
   - `lib/standalone/vessel-draft-delivery-store.ts`: Postgres store,
     `FOR UPDATE SKIP LOCKED` claiming, bounded retry with backoff,
     terminal `SENT`/`DELIVERY_UNKNOWN`/`DEAD`, worker-restart lease recovery,
     audit trail via existing `audit_events`, Admin status projection,
     five-block `runtimeDeliveryGate()`, prepared-but-never-executed request.
   - `/vessel/drafts` shows delivery mode, gate reasons, records and
     `CONFIRMATION_RULE`; degrades gracefully when the table is absent.
   - Migration tested on a disposable clone restored from the pre-deploy backup
     (46→47 tables, schema stays `1.5.0`, ledger `010`, all columns/indexes,
     legacy counts unchanged), rollback simulated (47→46), re-appliable.
   - Tooling: `install.mjs`, `grants.mjs`, CI table count 46→47, three test
     reset helpers updated to truncate the new table.
   - Integration tests: 8 store tests; Admin UI verified on a local dev server
     against the clone both with the table absent and with a synthetic QUEUED
     record; clone fixtures removed and the table dropped again.
   - **No `messages.send` capability, no outbound message, no `AI_*` change.**
     `MANUAL_COPY_ONLY` retained. `applyConfirmation()` untouched.
5. Docs, Git commits and pushes after each logically complete change.

## README / Git reconciliation (this session, docs only)

- **Verified facts:** running image `phase3-ai-rc-7da17f1` (digest
  `sha256:5f3de875…`), DB `alrifai_v2_phase3`, schema `1.5.0`,
  `schema_migrations` **002–009** applied (no `010`), 46 tables, router flags
  `PHASE3_ROUTER_WORKER_ENABLED=1` / `ALRIFAI_VESSEL_PROCESSING_ENABLED=1` /
  `ALRIFAI_LIVE_CASH_SYNC=0`, all `AI_*` flags `0`, `.env` tag aligned.
- **Found** both `main` and feature READMEs still opened with a
  `v1.4.0-phase3-rc2` / schema 1.4.0 / `phase3-rc-final5` "Current Release"
  block, plus stale schema/routing/AI/installer/test-count/deployment claims.
  `main` additionally claimed runtime image `86d659a` and pending `9e85e49`.
- **Corrected feature-branch README**: added a `Release status` table with the
  four required categories (Current Production / Historical Release / Built but
  Not Deployed / Pending Migration & Activation); preserved all historical tags,
  rollback instructions and cutover history in a clearly-labelled
  "Historical Release" section; corrected schema 1.4.0→1.5.0, migrations
  002–008→002–009, feature-flags-OFF→production overrides, "AI not
  deployed"→migration 009 applied with AI flags off, installer counts, test
  counts (83/112→133/133), stale cutover-era validation claims, and the
  auth/provisioning paragraph. Marked the active goal **BLOCKED** with the
  specific Owner action.
- **Git divergence (read-only):** `main` `0861e05`, merge base `76d5d00`;
  feature head advances with documentation commits (see `git log`). **22
  main-only** commits and a feature-only count that grows with each docs commit
  (re-run `git rev-list --left-right --count main...HEAD` for the current value).
  Criss-cross docs merges. **No force-push, reset, rebase or auto-merge
  performed.**
- **Merge plan:** `docs/MAIN_RECONCILIATION_PLAN.md` — GitHub PR (recommended)
  or a `--no-ff` local merge after Owner approval, taking feature-branch
  versions for documentation conflicts while keeping all 22 main-only commits.
  `main` README remains stale until that approved merge.
- **No production deployment, migration, credential, WhatsApp or DNS change.**

## Test evidence

- Unit **133/133**, integration **133/133**, focused store integration **8/8**,
  focused Task-3 re-run **31/31**, `tsc --noEmit` clean, lint 0 errors.
- Migration 010 checksum `fa299768329105611153b977a6f6c1400372d5651d77f7125bc1c5c69817e7c7`;
  applied/rolled back/re-appliable on a disposable production-schema clone.
- **Compatibility verified:** current branch code runs unmodified against the
  deployed 46-table schema — `deliveryTableAvailable()=false`, gate fully
  disabled (`MANUAL_COPY_ONLY`, 5 reasons), `deliveryStatusForPrograms()` returns
  0 rows. `7da17f1` does not contain the delivery module (added later).
- No production image was built or deployed this session.

## Production safety evidence

- Production containers unchanged: `db7e0d888f28` / `e5fe4214d625`, image `7da17f1`.
- `/api/health` on both hosts → `ok` / DB `ok` / schema `1.5.0`.
- Business counts unchanged (218 / 102 / 439 / 3,817 / 1,586 / 13 review items);
  0 outbound AI rows; 0 non-legacy postings.
- Bridge containers, sessions, checkpoints, cutover watermarks, allowlists,
  processing state and DNS untouched. `al-rifai.iamazim.com` still 1014.
- No credential reset, no hash/role/capability change, no secret printed or
  committed, no production migration, no WhatsApp message sent.

## Issue priority order

1. **ACTIVE GOAL — Authenticated Production UI Verification: BLOCKED.**
   Login is OWNER-CONFIRMED for all 3 accounts, but AGENT-VERIFIED UI is NOT
   TESTED. **Specific Owner action:** write one valid `__Host-alrifai_cash`
   cookie into root-only `/etc/vps/apps/al-rifai/verification-session.cookies`
   (`root:root`, `400`), or run `scripts/owner-assisted-ui-verify.sh` and share
   only its non-secret output. Then complete
   `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` with GET-only checks.
   **Do not mark COMPLETE on a README correction or a merge.**
2. Owner approves the 8 outbound activation items in
   `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §7 (including migration 010, exact
   sender/recipient/scope/template/trigger/retry/live+rollback plan).
3. Decide whether to build/deploy a candidate containing the feature-branch
   code (fresh backup required; rollback `7da17f1`; compatible with 46-table
   schema).
4. Owner approves the `main` reconciliation in
   `docs/MAIN_RECONCILIATION_PLAN.md` (PR or `--no-ff` merge); `main` README is
   still stale until then. Do not auto-merge / force-push / reset.
5. Manual review of the 7 historical `RELEASE_UNSTRUCTURED` items.
6. Vessel release ↔ attendance linkage; program pay / payroll unresolved cases.
7. Legacy Cashbook/archive, reconciliation and site settlements mapping.
8. Cloudflare 1014 (Owner DNS decision).
9. Low-priority legacy UI parity (typeahead, charts).

## Database migration ledger

- Production `schema_meta` `1.5.0`, `schema_migrations` max version `009`.
- **NO MIGRATION APPLIED** this session.
- Pending `010_vessel_draft_delivery.sql` (additive, clone-tested, rollback
  simulated, needs 8 Owner approvals before application).

## Git / push status

- `main` `0861e05` clean, not merged; README **still stale** until the approved
  reconciliation in `docs/MAIN_RECONCILIATION_PLAN.md`.
- `feature/phase3-router-cash-vessel` pushed and clean; README corrected this
  session. Merge base `76d5d00`; 22 main-only commits and a feature-only
  count that advances with documentation commits (see `git rev-list
  --left-right --count main...HEAD`).
- No force-push, no reset, no rebase, no auto-merge, no production image built.

## Exact next task and starting files

1. **ACTIVE GOAL (BLOCKED) — Authenticated Production UI Verification.** Owner
   writes the root-only session cookie jar
   `/etc/vps/apps/al-rifai/verification-session.cookies` (`root:root`, `400`)
   with one valid production session, or runs
   `scripts/owner-assisted-ui-verify.sh` themselves and shares only its
   non-secret output. Agent then re-runs
   `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` with authenticated GET-only
   requests and deletes the artifacts. Login is OWNER-CONFIRMED; never reset.
   **This goal is not COMPLETE; do not close it on a README fix or a merge.**
2. Owner reviews `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §5 (exact draft example),
   §6 (single-message verification procedure) and §7 (8 approvals).
3. If a further release is approved: fresh backup, build/deploy the current
   branch content, rollback `7da17f1`.
4. Starting files for delivery work: `lib/standalone/vessel-draft-delivery-store.ts`,
   `db/standalone/010_vessel_draft_delivery.sql`,
   `app/(workspace)/vessel/drafts/page.tsx`, `lib/vessel-draft-delivery.ts`.
5. Historical items: `docs/HISTORICAL_RELEASE_REVIEW_20261107.md`, `/review`.
6. Backlog: `docs/BUSINESS_WORKFLOW_BACKLOG.md`.
