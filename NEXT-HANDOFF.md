# NEXT-HANDOFF

**Session ended:** 2026-11-07 (third session — config alignment, auth diagnosis,
durable Vessel Draft delivery)
**Read first:** `docs/PRODUCTION_ENV_TAG_ALIGNMENT_20261107.md`,
`docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`,
`docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`,
`docs/VESSEL_DRAFT_DELIVERY_DESIGN.md`, `docs/PROJECT_KNOWLEDGE.md`,
`docs/BUSINESS_WORKFLOW_BACKLOG.md`, `docs/PHASE3_GO_NO_GO_7da17f1.md`.

**Report language:** English only. Always state whether a finding is
**implemented**, **clone-tested**, **production-deployed** or **live-verified**.

---

## Current versions

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
2. **Task 2 — authentication root cause (NO defect).** Traced the full pipeline.
   The earlier `400 CREDENTIALS_REQUIRED` came from requests with an **empty
   password**: `lib/unified-auth.ts:118` fires before user lookup/verification.
   The 0-byte bootstrap files are read **only** by provisioning CLIs, never by
   login. All three accounts are active with valid PBKDF2 hashes (118 chars,
   correct format), unchanged roles/capabilities (ADMIN 30, USER 10/10), and
   **6 historical successful `LOGIN` events + 2 live production sessions** prove
   end-to-end auth works. Both hosts accept the origin allowlist, enforce
   `ORIGIN_DENIED`, and return `401` for `/api/auth/session` without a cookie;
   reverse proxy forwards headers; cookie is `__Host-alrifai_cash`
   `HttpOnly; Secure; SameSite=Strict`. All 14 saved cookie jars are clone-only
   (zero match production). **No credential was reset, rehashed, recreated or
   re-permissioned.** Docs: `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md`.
3. **Task 3 — authenticated UI still NOT TESTED.** The Owner selected a
   root-only VPS credentials file
   (`/etc/vps/apps/al-rifai/verification-credentials.json`, `root:root`, `400`)
   as the secure method, but **the file does not exist yet**. A full
   VERIFIED/PARTIAL/FAILED/NOT TESTED matrix with 41 read-only route checks on
   both hosts is in `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md`. No 500s; all
   protected routes 401/307. Do not paste passwords in chat/Git/docs.
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

## Test evidence

- Unit **133/133**, integration **133/133**, focused store integration **8/8**.
- `tsc --noEmit` clean; lint 0 errors (3 pre-existing warnings).
- Migration 010 applied/rolled back/re-appliable on a disposable production-schema clone.
- No production image was built or deployed this session (Owner did not
  approve a new release); UI verified with a local `next dev` against the clone.

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

1. Owner writes the root-only credentials file → complete authenticated UI matrix.
2. Owner approves the 8 outbound activation items in
   `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §7 (including migration 010, exact
   sender/recipient/scope/template/trigger/retry/live+rollback plan).
3. Decide whether to build/deploy a candidate containing `675a3ef` + Task 4 code
   (fresh backup required; rollback `7da17f1`).
4. Manual review of the 7 historical `RELEASE_UNSTRUCTURED` items.
5. Vessel release ↔ attendance linkage; program pay / payroll unresolved cases.
6. Legacy Cashbook/archive, reconciliation and site settlements mapping.
7. Cloudflare 1014 (Owner DNS decision).
8. Merge feature branch into `main`.
9. Low-priority legacy UI parity (typeahead, charts).

## Database migration ledger

- Production `schema_meta` `1.5.0`, `schema_migrations` max version `009`.
- **NO MIGRATION APPLIED** this session.
- Pending `010_vessel_draft_delivery.sql` (additive, clone-tested, rollback
  simulated, needs 8 Owner approvals before application).

## Git / push status

- `main` `0861e05` clean, not merged.
- `feature/phase3-router-cash-vessel` pushed and clean; see `git log` for this
  session's commits. No force-push. No production image built this session.

## Exact next task and starting files

1. Owner creates `/etc/vps/apps/al-rifai/verification-credentials.json` via a
   non-echoing method (format in `docs/PRODUCTION_AUTH_DIAGNOSIS_20261107.md` §6).
   Agent then re-runs `docs/PRODUCTION_UI_VERIFICATION_MATRIX.md` with
   authenticated read-only requests and deletes the file.
2. Owner reviews `docs/VESSEL_DRAFT_DELIVERY_DESIGN.md` §5 (exact draft example),
   §6 (single-message verification procedure) and §7 (8 approvals).
3. If a further release is approved: fresh backup, build/deploy the current
   branch content, rollback `7da17f1`.
4. Starting files for delivery work: `lib/standalone/vessel-draft-delivery-store.ts`,
   `db/standalone/010_vessel_draft_delivery.sql`,
   `app/(workspace)/vessel/drafts/page.tsx`, `lib/vessel-draft-delivery.ts`.
5. Historical items: `docs/HISTORICAL_RELEASE_REVIEW_20261107.md`, `/review`.
6. Backlog: `docs/BUSINESS_WORKFLOW_BACKLOG.md`.
