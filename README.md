# AL-RIFA'I — Standalone Business Management Application

## 🚀 Current Release: v1.4.0-phase3-rc2

- **Schema version:** 1.4.0
- **Docker image:** `al-rifai-platform:phase3-rc-final5`
- **Image digest:** `sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae`
- **Release branch merged:** `feature/phase3-router-cash-vessel` → `main`
- **Merge commit:** `8cd9436` (cutover-safety fix)
- **Cutover executed:** 2026-11-06 18:14 UTC
- **Live database:** `alrifai_v2_phase3` (production schema 1.4.0)
- **AI development:** migration 009 / schema 1.5.0 — not deployed; see [`docs/PHASE3_AI_ASSISTANT.md`](./docs/PHASE3_AI_ASSISTANT.md)
- **Rollback database:** `alrifai_v2` (schema 1.2.0, preserved)
- **Release tag:** `v1.4.0-phase3-rc2` (the earlier `v1.4.0-phase3-rc` is retained)
- **Cutover runbook:** See [`docs/PHASE3_CUTOVER_RUNBOOK.md`](./docs/PHASE3_CUTOVER_RUNBOOK.md)
- **Deployment guide:** See [`DEVELOPER_START_HERE.md`](./DEVELOPER_START_HERE.md)
- **Rollback:** See [`PHASE3_ROLLBACK_INSTRUCTIONS.md`](./PHASE3_ROLLBACK_INSTRUCTIONS.md)

**Production status:** **LIVE on Phase 3** since 2026-11-06 18:14 UTC.
`alrifai_v2_phase3` is the live database at schema 1.4.0. The old Phase 2
containers and `alrifai_v2` are preserved as a cold rollback path. Feature flags
remain OFF; no business routing or financial posting is active.

---

A lean, self-contained business application for small shipping/agency operations:
employees and escorts, vessel programs and assignments, attendance, cash and
accounts, payroll, approvals, reports — plus an optional WhatsApp relay adapter.

It is **independent of the original AL-RIFA'I installation**: no organization
identifier, no fixed WhatsApp account, no built-in financial freeze, no
production domain, no historical migration chain. Every installation configures
its own administrator, accounts, rates, relay and authorized chats.

| | |
|---|---|
| Runtime | Node.js ≥ 22.13 (tested 22.23.4) |
| Package manager | pnpm 11.25.0 (or npm/npx) |
| Database | PostgreSQL 16 (≥ 13 supported by the SQL used) |
| Framework | Next.js 16.4.1 |
| Schema | fresh baseline, `db/standalone/schema.sql` + additive migrations 002–008 (version 1.4.0) |

---

## 1. What it does

| Module | Capabilities |
|---|---|
| Dashboard | KPIs, pending approvals, recent activity |
| Employees | Profiles, aliases, status, assignment history, attendance history |
| Vessel | Programs (one row per lighter), escort assignment/replacement, release, void, ±1-day duplicate warning; Order Drafts page renders the exact Owner draft for Admin copy |
| Attendance | Day/night records per employee, monthly summary |
| Cash & Accounts | Accounts, payment instructions (`REVIEW → APPROVED → POSTED / REJECTED / VOID`), postings, immutable ledger, reversal (contra entry), account reconciliation, income/expense, balances, staff submissions and audit history |
| Payroll | Configurable shift rates, derived program pay, monthly salary allocation by actual duty date |
| Review | Staff submissions, admin decisions, self-review prevention |
| Reports | CSV exports for every dataset + immutable audit trail |
| Settings | Accounts, rate configuration, WhatsApp relay, password |

Financial operations are normal, permission-controlled and audited. Nothing is
frozen by default; posting is an explicit, separate administrator action that
writes an immutable ledger entry.

---

## 2. Requirements

* Node.js 22.13+ (22.23.x recommended) and pnpm 11.25.0.
* PostgreSQL 13+ (16 recommended). No extensions are required.
* Two database logins:
  * **owner** — used by the installer, owns the schema;
  * **runtime** — least privilege, used by the application (no DDL, no DELETE on
    audit/ledger/posting tables).

---

## 3. Install

### 3.1 Copy the files

```bash
sudo mkdir -p /opt/alrifai
sudo cp -a apps/al-rifai /opt/alrifai/app
cd /opt/alrifai/app
```

### 3.2 Dependencies and build

```bash
npm install --global pnpm@11.25.0     # same as the project Dockerfile
pnpm install --frozen-lockfile
pnpm build                            # next build --webpack
```

### 3.3 Database

**Dedicated database (recommended)**

```sql
CREATE ROLE alrifai_app LOGIN PASSWORD '…owner-secret…' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE alrifai_runtime LOGIN PASSWORD '…runtime-secret…' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE DATABASE alrifai OWNER alrifai_app;
\c alrifai
GRANT CREATE, USAGE ON SCHEMA public TO alrifai_app;
GRANT USAGE ON SCHEMA public TO alrifai_runtime;
```

**Shared database, isolated schema** (other applications keep their own schemas)

```sql
CREATE SCHEMA alrifai AUTHORIZATION alrifai_app;
GRANT USAGE ON SCHEMA alrifai TO alrifai_runtime;
-- PGSCHEMA=alrifai below; nothing else is touched
```

The two passwords, the authentication settings, the first administrator and
the bridge store paths all live in **one** file — `.env` at the project root.
The runtime role name is whatever you choose; it is not hard-coded.

### 3.4 Configure — one file

`.env` is the single configuration source for the web application, the
installer, the importer and the WhatsApp sync worker. It holds the database
credentials inline, is git-ignored and must be `600`. It is never baked into
an image, never committed and never echoed.

```bash
cp .env.example .env
chmod 600 .env
$EDITOR .env
pnpm env:check        # reports which keys are present — never their values
```

The file is read through one loader (`lib/env.mjs`):

| Process | How it loads `.env` |
|---|---|
| web application | `instrumentation.ts` + `deploy/tls-entry.mjs` at boot |
| installer (`db:install`) | explicitly, before any connection |
| importer / sync worker | explicitly, before any connection |
| containers | compose `env_file` passes the same keys; the file is a fallback |

A value already present in the environment always wins over the file, so the
same file works for a local run and inside a container. Set at least:

```dotenv
PGHOST=127.0.0.1
PGPORT=5432
PGDATABASE=alrifai_v2
PGSCHEMA=public            # or your dedicated schema
PGUSER=alrifai_app
PGPASSWORD=…owner-secret…
ALRIFAI_REVIEW_DB_USER=alrifai_v2_runtime
ALRIFAI_REVIEW_PASSWORD=…runtime-secret…

ALRIFAI_UNIFIED_AUTH_MODE=on
ALRIFAI_UNIFIED_ORIGINS=https://alrifai.example.com
ALRIFAI_CASH_ORIGIN=https://alrifai.example.com
ALRIFAI_CASH_SUPER_ADMIN_IDS=<64-hex id printed by the installer>

WA01_DB=/var/lib/vps/whatsapp/wa-01/store/messages.db
WA02_DB=/var/lib/vps/whatsapp/wa-02/store/messages.db

ALRIFAI_MEDIA_ENABLED=1
ALRIFAI_MEDIA_DIR=/media
ALRIFAI_MEDIA_MAX_BYTES=26214400
ALRIFAI_MEDIA_UID=10001
ALRIFAI_MEDIA_GID=10001
```

A mounted secret file is accepted instead of an inline secret
(`PGPASSWORD_FILE`, `ALRIFAI_REVIEW_PASSWORD_FILE`); the loader tries the inline
value first. No credential is hard-coded in application code. WhatsApp pairing
and session databases stay in the bridge stores — no session credential is
copied into PostgreSQL.

### 3.5 Create the schema and the first administrator

On a fresh install the first ADMIN is seeded from the same `.env`:

```dotenv
ALRIFAI_BOOTSTRAP_ADMIN_USERNAME=owner
ALRIFAI_BOOTSTRAP_ADMIN_PASSWORD=…strong-password…
ALRIFAI_BOOTSTRAP_ADMIN_NAME=Owner
```

```bash
pnpm db:preflight     # connectivity, PostgreSQL version, existing install, runtime role
pnpm db:install       # reads the bootstrap keys above
# or, explicitly:
pnpm db:install --admin-user owner --admin-password '…' --admin-name 'Owner'
```

The password is hashed (PBKDF2-SHA256, 600 000 iterations) before it is stored;
only the hash is written. Remove the plaintext from `.env` afterwards. The
installer is transactional: it applies `db/standalone/schema.sql` plus the
additive layers `002`–`008`, grants the runtime role, seeds the administrator
and verifies 34 tables / 5 functions / 15 triggers at schema `1.4.0`. It prints
the administrator id — put it in `ALRIFAI_CASH_SUPER_ADMIN_IDS`.

Re-running against an installed schema stops unless `--force` is passed. `--force`
now means "apply the additive layers and grants again"; it never re-runs the
non-idempotent baseline. For a controlled upgrade use `pnpm db:migrate` instead.

### 3.5.1 Recovering an administrator password

No plaintext password is ever stored, so recovery is a reset:

```bash
pnpm admin:reset --username Admin        # prompts; input is hidden
# or, non-interactive (e.g. from inside the running container):
printf '%s\n' "$NEW_PASSWORD" | docker exec -i al-rifai-v2-app-1 \
  node --experimental-strip-types scripts/standalone/reset-password.mjs \
  --username Admin --stdin
```

The command refuses an unknown account (a typo cannot mint an administrator),
enforces the shared 8-character minimum, writes a `PASSWORD_RESET` audit row and
revokes every existing session of that account. The password itself is never
echoed, logged or stored; hash, revocation and audit are one transaction.

### 3.5.2 Incremental upgrades

Existing installations use the checksum-tracked migration runner:

```bash
pnpm db:preflight      # connectivity + current version, no change
pnpm db:migrate        # apply pending additive layers, then grant runtime access
pnpm db:verify         # re-run the preflight; pending must be empty
```

The ledger is `schema_migrations` inside the target schema. Re-running is a no-op;
editing an already-applied migration is refused unless
`--allow-checksum-change` is explicitly supplied. Production upgrades still
require a verified `pg_dump`, Owner approval and the release checklist.

### 3.5.3 User administration

The configured Super Admin can create users, change a role, deactivate an
account and reset a password from **Settings → User administration**. Passwords
are hashed before storage; a reset revokes every session of the target account.
The final active administrator cannot be deactivated or demoted. Ordinary
administrators cannot manage users.

### 3.6 Start

```bash
pnpm start          # next start --hostname 127.0.0.1 --port 3000
curl -fsS http://127.0.0.1:3000/api/health
```

Put it under systemd or your supervisor. Sign in at `https://<domain>/login`.

---

## 4. HTTPS / reverse proxy (required for browsers)

The session cookie is `__Host-…` with `Secure`, so **browsers only keep it over
HTTPS**. API clients work over plain HTTP, but the UI must be served behind TLS.

Terminate TLS at nginx/Caddy and proxy to `127.0.0.1:3000`. Cookies are
`__Host-` prefixed: HTTPS only, no path/domain override. `ALRIFAI_UNIFIED_ORIGINS`
must list the exact public origin.

```nginx
location / {
  proxy_pass http://127.0.0.1:3000;
  proxy_set_header Host $host;
  proxy_set_header X-Forwarded-Proto $scheme;
  proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
}
```

---

## 5. WhatsApp integration (optional)

The application **does not bundle** an MCP server, bridge, session store or
WhatsApp database. It connects to the relay your infrastructure already
provides:

* transport: unix domain socket
* authentication: the first line written after connect is the reader token, read
  from a file you configure
* protocol: newline-delimited JSON-RPC 2.0, `tools/call`
* tools used: `get_native_account_identity`, `list_native_messages`

Configure it in **Settings → WhatsApp relay**: account id, label, socket path,
token file, account JID, admin JIDs, authorized chat JID and purpose
(`ORDERS`, `CASH`, `BOTH`). Then:

1. **Test connection** — calls `get_native_account_identity`.
2. **Sync messages** — pages `list_native_messages` per authorized chat and stores
   messages in `whatsapp_messages` (idempotent; cursor in `whatsapp_cursors`).
3. **Process staged** — runs the **same domain services** as the web UI:
   * admin outgoing in a CASH chat → cash instructions in `REVIEW` (never posted);
   * client incoming in an ORDERS chat → vessel program drafts;
   * admin outgoing in an ORDERS chat that assigns an escort → confirmation of the
     matching draft (exactly one match, otherwise left unresolved).

**QR pairing, session health and bridge restarts remain the responsibility of
your WhatsApp infrastructure.** This application never pairs a device and never
touches a session. When the relay is down, every manual workflow keeps working
and Settings shows the connection error.

### Direct store sync (used by this installation)

The deployment in this repository reads each bridge's own SQLite message store
directly — no MCP grant, no per-chat profile entry, and no session material:

* **source** — the bridge's `messages.db`, opened read-only; `whatsapp.db` (the
  pairing/session store) is never opened;
* **worker** — `scripts/sync-worker.mjs` imports the historical rows once and then
  tails both accounts continuously; the checkpoint lives in `whatsapp_sync_state`
  and restarts never duplicate a row (`(account_id, chat_jid, message_id)`);
* **router** — an optional in-process worker (`lib/phase3-router-worker.ts`) routes new
  rows through the same shared router used by the manual API. It is
  default-disabled by `PHASE3_ROUTER_WORKER_ENABLED=0` **and** by the database
  gate (`phase3_router_enabled`, per-account watermark and business-chat
  allowlist). Vessel intake has its own gate,
  `ALRIFAI_VESSEL_PROCESSING_ENABLED`; while disabled, Vessel messages stay
  `PENDING` and are processed after activation, never silently consumed;
* **identity** — `identity_aliases` records the account, chat and participant
  JIDs plus the PN/LID links the bridge itself resolved. A name comes from the
  bridge's chat label; an unresolved LID stays explicitly unresolved and is never
  given an invented phone number;
* **media** — for new attachments the worker reads the persisted URL + media key,
  downloads and decrypts the bytes **in memory**, verifies the recorded SHA-256,
  and writes them to the persistent media directory. Media keys are never stored
  in PostgreSQL, the bytes never enter the image or the Git checkout, and
  historical attachments are not recovered. `--mode=import` deliberately skips
  media capture.

The Inbox page (`/messages`) selects WA-01 or WA-02, lists direct and group
conversations, shows resolved names (or the raw JID when unresolved), links each
captured attachment through the authenticated `/api/media` route, and displays
the checkpoint, media counts and last sync error.

---

## 6. Backup, restore, updates

```bash
pg_dump -Fc -d alrifai -f /var/backups/alrifai-$(date +%Y%m%d-%H%M).dump
sha256sum /var/backups/alrifai-*.dump > /var/backups/alrifai-$(date +%Y%m%d-%H%M).sha256
```

Restore into a new database first, then switch `PGDATABASE`. Updates: back up,
replace the source, `pnpm install --frozen-lockfile && pnpm build`, run
`pnpm db:migrate` (additive, checksum-tracked), restart, verify `/api/health`.
The current schema is `1.4.0` (migrations 002–008).

---

## 7. Tests

```bash
pnpm test:unit        # pure functions (83 assertions)
pnpm test:standalone  # all DB suites: domain, WhatsApp adapter, router,
                      # cutover, Review Queue, Cash lifecycle, users and AI
                      # (112 integration tests)
```

The integration tests are destructive to their schema: run them against a
disposable database (or a dedicated schema) prepared with `pnpm db:install`, and
always with `--test-concurrency=1`. They reset business tables between files;
never point them at production.

---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `DATABASE_CONFIG_MISSING:PGHOST` (or another variable) | missing configuration | set it in `.env`, then `pnpm env:check` |
| `DATABASE_CONFIG_INVALID:PGPORT` / `PGSCHEMA` | bad value | port 1–65535, identifier schema |
| `DATABASE_CONFIG_MISSING:PGPASSWORD` | no inline password and no file fallback | set `PGPASSWORD` or `PGPASSWORD_FILE` in `.env` |
| `DATABASE_CONFIG_UNREADABLE:PGPASSWORD_FILE` | password file missing/unreadable | create it, mode 600 |
| `BOOTSTRAP_PASSWORD_POLICY` | bootstrap admin password too short | at least 8 characters in `.env` |
| `USER_NOT_FOUND` (reset CLI) | account name typo | check `cash_portal_users`; the CLI never creates accounts |
| `ALREADY_INSTALLED` | schema already has `schema_meta` | use `--force` or a new schema |
| `RUNTIME_ROLE_MISSING` | runtime login not created | create it (see §3.3) |
| `permission denied for table …` | runtime grants missing | re-run `pnpm db:install` |
| Login page loops | `ALRIFAI_UNIFIED_AUTH_MODE` not `on`, or origin mismatch | set `on` and the exact origin |
| `WHATSAPP_DISABLED` / `NOT_CONFIGURED` | relay not configured | Settings → WhatsApp relay |
| `WHATSAPP_CONNECT_FAILED` | socket path/token wrong or bridge down | check the relay; manual workflows still work |
| `/api/health` 503 | database unreachable | check PostgreSQL and credentials |

---

## 9. Known limitations

* The deployed ingestion path is the **direct bridge SQLite store**, verified
  live on both accounts (historical import plus continuous tail). The optional
  MCP relay described in §5 is not used by this deployment and was validated only
  against a mock relay.
* New-media capture is live for images, audio and video received from the Phase 2
  release onward; a live document or sticker sample has not yet been observed.
  Media rows the bridge stored without a URL or key are recorded as
  `MEDIA_METADATA_INCOMPLETE` and are not backfilled.
* No graphical browser was available during validation: the end-to-end run used
  authenticated HTTP against the real server (sessions, CSRF, server-rendered
  pages) and asserted the database state directly.
* The session endpoint rotates the CSRF token on each read (the UI fetches it
  immediately before acting); third-party clients must do the same.
* The first administrator must change the password before any write is allowed
  (`PASSWORD_CHANGE_REQUIRED`), by design.
* Payroll covers duty-based program pay and monthly salary allocation. Monthly
  salary uses the stored `program_pay` calculation, so a later rate change does
  not rewrite released pay. Conveyance is reported per program and not allocated
  to a month (no verified travel date is captured), and advances/food-bill rules
  are not implemented — they need an owner decision, not an invention.
* Cash supports instruction, review, approval, posting, reversal and
  reconciliation. Router-created instructions may need an explicit paying
  account before approval; the audited `instruction.account` action records it.
  Reversal is a contra ledger entry; original postings and ledger rows are never
  edited. Reconciliation records variance but never posts an automatic
  adjustment.
* Single currency (BDT by default) and single organization per installation.
* English UI only.
* Legacy AL-RIFA'I modules are preserved for reference only and are not imported
  by the standalone startup path. The legacy Live Cash bootstrap is no longer
  called by `instrumentation.ts`; see `docs/STANDALONE-REMOVED.md`.
* Message edits/deletions are captured in the raw store but an already-processed
  message is not automatically reprocessed. This avoids duplicate financial or
  vessel writes; a future edit-reconciliation workflow is a separate design.
* Vessel order drafts are **copy-only** (`MANUAL_COPY_ONLY`). The platform
  renders the exact Owner layout on `/vessel/drafts`, program detail and review
  detail, but does not send it to WhatsApp: neither bridge has a `messages.send`
  capability and no outbound sender is enabled. Automatic delivery requires an
  explicit Owner decision. See `docs/VESSEL_ORDER_DRAFT.md`.
* Unstructured release/cancel/food-bill messages are not parsed. They remain in
  the Review Queue as `PROGRAM` / `EXTRACTION_FAILED` with
  `payload.releaseCategory = RELEASE_UNSTRUCTURED` until a parser extension is
  approved; no program is changed from them.

See `docs/STANDALONE-MAPPING.md` for the feature → code → database map and
`docs/STANDALONE-VERIFICATION.md` for the verification record.

---

## Production deployment — verified 2026-11-07

- **Application:** AL-RIFA'I Phase 3 (Next.js 16, PostgreSQL 16)
- **Source:** `/opt/al-rifai-platform`
- **Deployment env:** `/opt/vps/al-rifai-standalone/apps/al-rifai/.env` (mode 600)
- **Compose project:** `al-rifai-phase3`
- **Compose files:** `compose.yaml`, `compose.phase3.yaml`
- **Database:** `alrifai_v2_phase3` (schema 1.5.0)
- **Runtime image:** `local/al-rifai-platform:phase3-ai-rc-86d659a`
- **Digest:** `sha256:932ef85621a0f99c2b15b1eaa615bad6e2dc87320f149787092c7c0f5a4079a5`
- **GitHub:** `arshiyaazim/al-rifai-platform`, `main` includes docs merge `9fcc2e7`; runtime release `86d659a`
- **Candidate (built, tested, NOT deployed):** `phase3-ai-rc-9e85e49`, digest `sha256:cb8de252663fc04462eacf23a8eb1bbd39fe3af6a2a81230cdf3fa43a26075a0`

### Verified public URLs

| URL | Status |
|---|---|
| `https://app.al-rifai.iamazim.com` | **CANONICAL — VERIFIED** (307 → `/dashboard`, `/login` 200) |
| `https://alrifai.iamazim.com` | **LEGACY ALIAS — VERIFIED** |
| `https://al-rifai.iamazim.com` | **BROKEN — Cloudflare 1014** (cross-account CNAME) |

Login: `/login`. Health: `/api/health`. Admin Assistant: `/assistant`
(deployed on candidate `9e85e49`, deployment pending). Cash: `/cash`.
Vessel: `/vessel`. Vessel Order Drafts: `/vessel/drafts` (candidate only).
Employees: `/employees`. Attendance: `/attendance`. Reports: `/reports`.
Review: `/review`. Messages: `/messages`.

See `docs/PRODUCTION_URLS.md` for the full route and legacy compatibility
matrix, `docs/PROJECT_KNOWLEDGE.md` for the permanent project map,
`docs/VESSEL_ORDER_DRAFT.md` for the order-draft pipeline and transport
decision, `docs/LEGACY_PHASE3_COMPARISON.md` for the feature/database
comparison, and `docs/DNS_CLOUDFLARE_1014.md` for the DNS correction proposal.

### Authentication and user provisioning

Admin and two USER accounts are provisioned only through explicit CLIs; a
restart never resets a password. The production `.env` references root-only
password files that are intentionally empty until the Owner enters the intended
credentials interactively. See `docs/ADMIN_AUTH.md`.

### Configuration

`/opt/vps/al-rifai-standalone/apps/al-rifai/.env` is the central configuration
source. Keys are copied into app/sync containers via Compose `env_file`;
metadata keys (`ALRIFAI_APP_NAME`, `ALRIFAI_PUBLIC_BASE_URL`, etc.) are
informational and do not alter DNS or proxy routing. AI keys (`AI_LLM_*`) are
disabled/unconfigured; WA-02 outbound and automatic replies remain off.

### Backup and rollback

Pre-import backup:
`/var/lib/vps/al-rifai/backups/phase3-pre-import-20261106T224024Z.dump`
(SHA-256 verified). Rollback image `phase3-ai-rc-e3b56c4` and
`phase3-rc-final5` are present. Use the `--env-file` Compose command for the
`al-rifai-phase3` project; never create a parallel stack.
