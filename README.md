# AL-RIFA'I — Standalone Business Management Application

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
| Framework | Next.js 16.3.8 |
| Schema | fresh baseline, `db/standalone/schema.sql` (version 1.2.0) |

---

## 1. What it does

| Module | Capabilities |
|---|---|
| Dashboard | KPIs, pending approvals, recent activity |
| Employees | Profiles, aliases, status, assignment history, attendance history |
| Vessel | Programs (one row per lighter), escort assignment/replacement, release, void, ±1-day duplicate warning |
| Attendance | Day/night records per employee, monthly summary |
| Cash & Accounts | Accounts, payment instructions (`REVIEW → APPROVED → POSTED / REJECTED`), postings, ledger, income/expense, balances, staff submissions |
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
additive `002_raw_import.sql` layer, grants the runtime role, seeds the
administrator and verifies 30 tables / 5 functions / 14 triggers. It prints the
administrator id — put it in `ALRIFAI_CASH_SUPER_ADMIN_IDS`.

Re-running against an installed schema stops unless `--force` is passed.

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
replace the source, `pnpm install --frozen-lockfile && pnpm build`, apply any new
`schema_meta` version step (none yet beyond 1.2.0), restart, verify `/api/health`.

---

## 7. Tests

```bash
pnpm test:unit        # pure functions (35 assertions)
pnpm test:standalone  # domain + WhatsApp-adapter tests, needs the disposable DB
```

The integration tests are destructive to their schema: run them against a
disposable database (or a dedicated schema) prepared with `pnpm db:install`, and
always with `--test-concurrency=1`.

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
* Payroll covers duty-based program pay and monthly salary allocation. Conveyance
  is reported per program and not allocated to a month (no verified travel date
  is captured), and advances/food-bill rules are not implemented — they need an
  owner decision, not an invention.
* Single currency (BDT by default) and single organization per installation.
* English UI only.
* Legacy AL-RIFA'I modules are preserved under `legacy-runtime/` and are not part
  of the runtime; see `docs/STANDALONE-REMOVED.md`.

See `docs/STANDALONE-MAPPING.md` for the feature → code → database map and
`docs/STANDALONE-VERIFICATION.md` for the verification record.
