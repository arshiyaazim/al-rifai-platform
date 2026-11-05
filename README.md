# AL-RIFA'I Platform

A single Next.js application for a small shipping/agency business: employees and
escorts, vessel programs, attendance, cash and accounts, payroll, review and
approval, reports, a unified WhatsApp inbox — plus a lightweight worker that
continuously imports the WhatsApp bridges' own message stores.

One application, one PostgreSQL database, one `public` schema. No legacy
migration chain, no microservices, no additional infrastructure.

| | |
|---|---|
| Runtime | Node.js ≥ 22.13 (tested 22.23.x) |
| Package manager | pnpm 11.25.0 (pinned in `packageManager`) |
| Database | PostgreSQL 16 (`postgres:16-alpine` tested) |
| Framework | Next.js 16.3.8 |

## Layout

```
app/                     routes (workspace pages, API handlers)
components/              shared UI
lib/                     domain logic, auth, SQL access
   standalone/           domain services used by the pages and APIs
db/standalone/           fresh-install schema (001) + raw-import layer (002)
scripts/standalone/      installer (schema + roles + first administrator)
scripts/sync-worker.mjs  WhatsApp store importer / continuous tailer
deploy/tls-entry.mjs     HTTPS entry point (Terminates TLS, proxies to Next)
Dockerfile               one image, two commands (app / sync)
compose.yaml             app + sync services
```

## Database bootstrap

```bash
# 1. create the database and the owner role (once, by a superuser)
createdb -O alrifai_app alrifai_v2

# 2. install the schema
psql -U alrifai_app -d alrifai_v2 -v ON_ERROR_STOP=1 -f db/standalone/schema.sql
psql -U alrifai_app -d alrifai_v2 -v ON_ERROR_STOP=1 -f db/standalone/002_raw_import.sql

# 3. create the least-privilege runtime role
psql -U alrifai_app -d alrifai_v2 -v ON_ERROR_STOP=1 <<'SQL'
GRANT USAGE ON SCHEMA public TO alrifai_v2_runtime;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO alrifai_v2_runtime;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO alrifai_v2_runtime;
GRANT DELETE ON cash_portal_sessions, login_throttle_state TO alrifai_v2_runtime;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO alrifai_v2_runtime;
SQL
```

`scripts/standalone/install.mjs` performs the same steps and additionally
creates the first administrator from a password supplied on stdin. It requires
the `pg` package, so run it inside an installed tree (`node_modules` present).

Both SQL files are idempotent: re-running them adds nothing and destroys
nothing.

## Configuration

Copy `.env.example` to `.env` (mode 600) or supply the same keys as container
environment. Secrets are always *file* references (`*_PASSWORD_FILE`) — no
password is ever placed in configuration or in Git.

Required for the application:

| Key | Meaning |
|---|---|
| `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSCHEMA` | database location |
| `PGUSER`, `PGPASSWORD_FILE` | owner role (schema owner) |
| `ALRIFAI_REVIEW_DB_USER`, `ALRIFAI_REVIEW_PASSWORD_FILE` | least-privilege runtime role |
| `ALRIFAI_UNIFIED_AUTH_MODE` | `on` for session authentication |
| `ALRIFAI_UNIFIED_ORIGINS` | comma-separated allowed browser origins |
| `ALRIFAI_CASH_ORIGIN` | origin of the cash portal |

Required for the sync worker:

| Key | Meaning |
|---|---|
| `WA01_DB`, `WA02_DB` | absolute paths to the bridges' `messages.db` |
| `WA01_ID`, `WA02_ID` | account ids stored in PostgreSQL (default `wa-01`, `wa-02`) |
| `SYNC_INTERVAL_MS`, `SYNC_BATCH` | poll interval and batch size |

## WhatsApp ingestion

Ingestion reads each bridge's **persisted message store**
(`<wa-0X>/store/messages.db`) directly. That is a supported, credential-free
read path: it needs no MCP tool grant, no per-chat profile entry and no
session material. The pairing store (`whatsapp.db`) is never opened.

```bash
pnpm sync:import     # one-shot historical catch-up (consistent snapshot per store)
pnpm sync          # continuous tail; the container command
pnpm sync:status   # checkpoints, counts, last error
```

Guarantees:

- **Restartable** — the checkpoint is the highest committed SQLite `rowid`.
- **Idempotent** — rows are keyed by `(account_id, chat_jid, message_id)`. The
  composite key is required: the bridge can hold one message id under two chats.
- **No silent loss** — a value PostgreSQL cannot store (BLOB, NUL, lone
  surrogate) is normalised, never dropped; a failed batch leaves the checkpoint
  untouched and records the error in `whatsapp_sync_state.last_error`.
- **No invented identity** — alias rows come only from columns the bridge itself
  resolved. Missing fields stay `NULL`.

## Development

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm build
pnpm test          # unit + domain tests (domain tests need a disposable database)
```

## Deployment

```bash
docker build -t local/al-rifai-platform:<tag> .
ALRIFAI_TAG=<tag> docker compose up -d
```

`compose.yaml` runs one image as two services:

- `app` — `node deploy/tls-entry.mjs`: TLS on 3443 in front of Next on loopback.
  The certificate and key are mounted read-only from the host; nothing is
  generated inside the image.
- `sync` — `node scripts/sync-worker.mjs --mode=tail`, reading the two bridge
  store directories read-only and writing only to PostgreSQL.

Both services have explicit memory limits, a read-only root filesystem, a
`tmpfs` for `/tmp` and no added capabilities. The `sync` service runs as root
only because the bridge store directories are `0700` and owned by the bridge
users; permissions on those directories are deliberately not weakened.

## Security notes

- Session cookie: `__Host-` prefix, `HttpOnly`, `Secure`, `SameSite=Strict`.
- Every write route resolves the caller from that cookie — never from the
  request body — and validates the `Origin` header.
- Passwords are stored as `pbkdf2-sha256` with 600 000 iterations.
- The runtime role is not a superuser and does not own the schema.
