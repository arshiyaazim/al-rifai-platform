# PLATFORM-GUIDE — AL-RIFA'I

> Single source of truth for the running platform. Updated **2026-11-20** from
> the live server (docker ps/inspect, psql, filesystem, systemd). No secrets are
> included. Update this file at the end of every deploy batch.

## 1. Overview

- **Project:** AL-RIFA'I Integrated Services — business platform for employees, vessel programmes, cash, attendance, payroll, reports and an in-app AI assistant.
- **Primary URL:** `https://app.alrifai.iamazim.com` (TLS certificate CN is `app.al-rifai.iamazim.com`; `alrifai.iamazim.com` also resolves to this host).
- **Server:** `5.189.131.48` (IPv6 `2a02:c207:2311:7764::1`), Ubuntu 22.04.5 LTS, kernel `5.15.0-202-generic`, 8 vCPU, 23 GiB RAM (18 GiB available), 194 GB disk (60 GB used, 135 GB free, 31%).
- **Current release:** `v3.3.19-next16.4.6` (app + sync, same tag; deployed 2026-11-20).

## 2. Repository Map

| Repo | Path | Branch | Remote | Purpose |
|---|---|---|---|---|
| al-rifai-platform | `/opt/al-rifai-platform` | `main` | `git@github.com:arshiyaazim/al-rifai-platform.git` | Next.js platform + sync worker + migrations |
| al-rifai-recruitment-ai | `/opt/al-rifai-recruitment-ai` | `master` | `git@github.com:arshiyaazim/al-rifai-recruitment-ai.git` | Separate WA-02 recruitment bot (own container/SQLite) |
| vps | `/opt/vps` | `target01-vessel-fragment-merge` | `git@github.com:arshiyaazim/opt_vps.git` | Host infra: Postgres, WhatsApp bridges, compose fragments |

## 3. Docker Stack (8 containers)

| Container | Image | Ports | Network | Key volumes | Purpose |
|---|---|---|---|---|---|
| al-rifai-phase3-app-1 | `local/al-rifai-platform:v3.3.19-next16.4.6` | `0.0.0.0:443→3443` (TLS entry) | vps-backend | `/var/lib/vps/al-rifai/media`, `/opt/al-rifai-platform/uploads/employees`, WA-01 control token, TLS cert/key (ro) | Next.js app |
| al-rifai-phase3-sync-1 | same | none | vps-backend | media + WA-01/WA-02 bridge stores | WhatsApp mirror worker (`--mode=tail`) |
| vps-infra-postgres-1 | `postgres:16-alpine` | none published (5432 internal) | vps-backend | `/var/lib/vps/postgres`, admin password secret | Main database |
| ollama | `ollama/ollama` | `127.0.0.1:11434→11434` | bridge + vps-backend | `ollama_data` volume | Local LLM/vision |
| open-webui | `ghcr.io/open-webui/open-webui:main` | `127.0.0.1:3000→8080` | vps-backend | `open_webui_data` volume | Chat UI for Ollama |
| al-rifai-recruitment-ai | `local/al-rifai-recruitment-ai:0.1.12-flow` | none | vps-backend | WA-02 control/store/media, local `data/`, sender token | Recruitment bot |
| vps-whatsapp-wa-01-cap4-20261011 | `28a646d2bdad` | none | vps-whatsapp_whatsapp-private | WA-01 control/outbox/store | WhatsApp bridge 1 (Cash/Vessel source) |
| vps-whatsapp-wa-02-cap4-20261011 | `local/vps-whatsapp:20261020-ingestion` | none | vps-whatsapp_whatsapp-private | WA-02 control/outbox/store | WhatsApp bridge 2 (identity/recruitment) |

- **Restart policy:** `unless-stopped` on all 8. **Health checks:** app, postgres, open-webui (`healthy`); sync, ollama, recruitment, both bridges have none.
- **Compose ownership:** app+sync = `/opt/al-rifai-platform/compose.yaml` + `compose.phase3.yaml`; postgres = `/opt/vps/infra/compose.yaml`; bridges = `/opt/vps/services/whatsapp/compose.yaml`. ollama, open-webui and recruitment-ai are plain `docker run` containers (no compose project label).

## 4. Database

- **Container:** `vps-infra-postgres-1`; **DB:** `alrifai_v2_phase3`; **no host port** (reachable only on `vps-backend`).
- **Roles:** admin `vps_pg_admin`; app runtime `alrifai_v2_runtime`; owner `alrifai_app`; mirror workers `alrifai_mirror_worker`, `alrifai_mirror_evidence_writer`.
- **Schema version:** `1.13.8`; **tables:** 67; **migrations:** 29 files (002–029; 28 ledger rows, baseline in `schema.sql`; latest `029_employee_search_trgm.sql`).
- **Runner:** `scripts/standalone/migrate.mjs` (checksum-locked ledger `schema_migrations`); fresh install `scripts/standalone/install.mjs`.

| Table | Rows (2026-11-16) |
|---|---|
| employees | 222 |
| cash_instructions | 2,523 |
| api_keys | 10 |
| programs (vessel programmes; no `vessel_programs`) | 214 |
| attendance_records | 408 |
| attendance (legacy) | 439 |
| app_settings | 8 |
| cash_portal_sessions (sessions; no `auth_sessions`) | 70 |
| audit_events | 4,483 |
| employee_documents | 0 |

## 5. Web Pages & URLs

All routes below `app/(workspace)/`; unauthenticated page loads redirect to `/login`.

| Page | URL Path | Key Features | Search Params |
|---|---|---|---|
| Home | `/home` | 5×4 metric cards, domain tables, quick actions | `domain, period, page` |
| Legacy dashboard | `/dashboard` | 307 redirect → `/home` | — |
| Insights | `/insights` | Operational insights | — |
| Assistant | `/assistant` | Admin AI console (ADMIN only) | — |
| Employees | `/employees` | Search, detail card/sidebar, add form, sub-tables | — (client-side) |
| Employee profile | `/employees/[mobile]` | Full profile, cash history, attendance | — |
| Legacy employees | `/employee` | Alias employee list | `q, state` |
| Legacy profile | `/employee/[phone]` | Alias profile | — |
| Vessel register | `/vessel` | Program list, filters, pagination, new program | `q, state, page, mother, escort_mobile` |
| Vessel detail | `/vessel/[id]` | Program detail/lifecycle | — |
| Vessel drafts | `/vessel/drafts` | Order draft deliveries | — |
| Legacy vessel aliases | `/vessel-register`, `/vessel/register`, `/vessel/vessel-register` | Same register view | `q, state` |
| Register | `/register` | Vessel order/register workspace | `q, state` |
| Release | `/release` | Escort release review + OCR upload | — |
| Attendance | `/attendance` | Daily attendance, dual lookup, review panel | — (client-side) |
| Cash | `/cash` | Dashboard cards, quick payment form, recent transactions | `q, state, search, employee_mobile, employeeName, employeeMobile, payoutMobile, openPayment` |
| Cash transactions | `/cash/transactions` | Financial POSTED ledger, paginated | `q, date, from, to, employee, employeeMobile, employee_mobile, source, page` |
| Cash archive | `/cash/archive` | Ledger archive view | `q, page, ledgerPage, from, to` |
| Cash instruction | `/cash/[id]` | Single instruction detail | — |
| Cash by employee | `/cash/employee/[employeeId]` | Employee cash history | — |
| Business Paid | `/cash/paid` | Business paid events list | `q, date, from, to, employee, employeeMobile, source, page` |
| Business Paid detail | `/cash/paid/[id]` | Event chain/evidence | — |
| Cash submissions | `/cash/submissions` | AI cash submissions | — |
| Income & expenditure | `/income-expenditure` | Ledger summary | `from, to` |
| Payroll | `/payroll` | Monthly payroll + rates | `month` |
| Review queue | `/review` | Domain review tables | `state, category` |
| Review item | `/review/[id]` | Review detail/actions | — |
| Submissions | `/submissions` | Submission inbox | — |
| Sources review | `/sources-review` | Message source triage | `state, domain, category, q, mine` |
| Messages | `/messages` | WhatsApp message intelligence | `account, chat, direction, kind, q, role, domain` |
| Message mirror | `/message-mirror` | Mirror listing | `account, direction, q` |
| Conversations | `/conversations` | Chat list | `account, kind` |
| Transactions | `/transactions` | Legacy cash ledger | `q, state, page, from, to` |
| Transactions by employee | `/transactions/employee/[phone]` | Employee ledger | — |
| Reports | `/reports` | Reports & archive | — |
| Archive | `/archive` | Archived items | — |
| Audit | `/audit` | Audit trail | — |
| Settings | `/settings` | Integrations, users, assistant toggle | — |
| API keys | `/settings/api-keys` | Key management + model test | — |
| Recruitment | `/settings/recruitment` | Recruitment AI settings | — |

## 6. API Endpoints

All under `/api/*`; unauthenticated calls return JSON `401`. "Auth" shows the capability asserted in code.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET/POST | `/api/auth/[...path]` | session | Login/logout/session/CSRF |
| GET | `/api/health` | public-ish (session middleware) | Health + schema version |
| GET | `/api/events` | session | SSE/event feed |
| GET/POST/PATCH | `/api/employees` | employee.read / employee.submit | List/create/update |
| GET | `/api/employees/lookup` | employee.read | Name/mobile typeahead |
| GET | `/api/employees/search` | employee.read | Fuzzy (pg_trgm) ranked search |
| GET | `/api/employees/summary` | employee.read | Summary table totals |
| GET | `/api/employees/file` | employee.read | Serve photo/document file |
| POST | `/api/employees/upload` | employee.manage | Upload profile file |
| DELETE | `/api/employees/documents/[id]` | employee.manage | Delete document |
| GET/POST/DELETE | `/api/attendance` | attendance.read / submit / manage | Records (+ optional limit/offset) |
| GET | `/api/attendance/unified` | attendance.read | Unified vessel+security view |
| GET/PATCH/DELETE | `/api/attendance/[id]` | attendance.read / manage | Single record |
| GET | `/api/cash/transactions` | cash.read | Paginated transactions (`{transactions,total,…}`) |
| GET/PATCH | `/api/cash/transactions/[id]` | cash.read / cash.review | Detail/update |
| POST | `/api/cash/transactions/[id]/correct` | cash.review | Correction |
| POST | `/api/cash/transactions/[id]/reverse` | cash.reverse | Reversal |
| GET | `/api/cash/payments` | cash.read | Payment list |
| GET | `/api/cash/employees/[employeeId]/transactions` | cash.read | Employee history |
| GET | `/api/cash/export` | cash.read | CSV export |
| POST | `/api/cash/import` | cash.submit | CSV import |
| GET/POST | `/api/finance` | cash.read | Ledger + business-paid resources |
| GET | `/api/programs` | vessel.read (writes: submit/command/release) | Vessel programs |
| GET | `/api/programs/[id]` | vessel.read | Program detail |
| GET/POST | `/api/vessel` | vessel.read / vessel.submit | Register list/create |
| GET/PATCH/DELETE | `/api/vessel/[id]` | vessel.read/command/release/submit | Program lifecycle |
| GET | `/api/vessel/export` | vessel.read | CSV export |
| POST | `/api/vessel/import` | vessel.command | CSV import |
| POST | `/api/release/ocr` | vessel.release | Vision OCR for release slips |
| POST | `/api/release` | session | Release actions |
| POST | `/api/whatsapp/import` | vessel.command | Import WA vessel orders |
| GET/POST | `/api/whatsapp` | whatsapp.read | Bridge/account status |
| GET | `/api/messages` | whatsapp.read | Message list |
| POST | `/api/messages` | whatsapp.manage | Message actions |
| GET | `/api/media` | whatsapp.read | Media file |
| GET | `/api/audit` | audit.read | Audit log |
| GET | `/api/reports` | audit/cash/payroll/vessel/employee/attendance read | Report data |
| GET/POST | `/api/payroll` | payroll.read / payroll.manage | Payroll |
| GET/POST | `/api/review` | review.decide | Review queue/decisions |
| POST | `/api/review/bulk-reject` | review.decide | Bulk decline |
| GET/POST | `/api/settings/api-keys` | settings.manage | Key CRUD |
| POST | `/api/settings/api-keys/test` | settings.manage | Test key |
| POST | `/api/settings/api-keys/test-draft` | settings.manage | Test draft/Ollama |
| POST | `/api/settings/api-keys/models` | settings.manage | List provider models |
| GET/POST | `/api/settings/assistant` | settings.manage | Assistant kill-switch |
| GET/POST | `/api/settings/recruitment` | settings.manage | Recruitment config |
| GET/POST | `/api/users` | user.manage | User admin |
| POST | `/api/assistant/chat` | session + assistant gate | Floating assistant (read-only planner) |
| GET/POST | `/api/assistant` | ai.read/ai.use/ai.send/ai.admin | Outbound AI drafts/send |

## 7. AI Configuration

**Ollama** (local, `http://ollama:11434/v1`, 120 s timeout, 700 max tokens; vision 120 s):
- `qwen3-vl:2b` (1.9 GB, vision/OCR)
- `richardyoung/deepseek-r1-0528-qwen3-8b-heretic:Q4_K_M` (5.0 GB, draft model)

**Cloud LLM:** `AI_LLM_ENABLED=1`, 12 s timeout, 500 max tokens; keys are DB-driven (`api_keys`, 10 rows: platform-llm 4, platform-assistant 1, recruitment 5). Selection: operator `priority`, then free-first, then latency (gemini→groq→openai→anthropic→mistral→openrouter→ollama); automatic failover with cooldown and per-key daily limits. Keys are encrypted `enc:v1:` (AES-GCM with `AI_KEY_ENCRYPTION_KEY`) — except `recruitment`, stored plaintext by design.

**Assistant files (real paths):** `components/standalone/floating-assistant.tsx`, `lib/standalone/ai-assistant-{functions,prompt,templates,dates,queries,summaries,walkthrough}.ts`, `lib/standalone/url-registry.ts`, `app/api/assistant/chat/route.ts`.

**Capabilities:** fuzzy employee search (name/mobile/alias), navigation with real page filters (single হ্যাঁ/না confirmation rendered by the client), cash/attendance/vessel summaries, step-by-step guides, opening the Add-Employee form. Blocked before any model call: how-it-was-built, server IP, port, password, credential, API key, database infrastructure, source code, deployment, tech stack. Function schemas: `searchEmployee`, `navigateToPage`, `fetchCashSummary`, `fetchAttendanceSummary`, `fetchVesselSummary`, `openSidebar`, `isBlockedQuestion`. Rate limit: 20 questions/hour per user (in-process, `takeSlot`); kill-switch in Settings. Reads only via authenticated, capability-checked endpoints.

**Templates, dates & walkthroughs (E2.5 — deployed as v3.3.15-smart-assistant):** exactly **7 flat English templates** — `Search an employee..`, `Add New Employee..`, `Add Hotel Bill..`, `Add lighter program..`, `Add Attendance..`, `Add Release Info..`, `Today's cash..` — matched deterministically before any model call. Date phrases (`আজ/গতকাল/গত N দিন/গত সপ্তাহ/গত মাস/গত মাসে/এই মাস/N তারিখ থেকে M তারিখ/ISO range`, Bengali digits included) run a **read-only** query layer (`lib/standalone/ai-assistant-{dates,queries,summaries}.ts`): POSTED-only cash totals with method breakdown, separate REVIEW count, attendance and vessel summaries; no INSERT/UPDATE/DELETE. A six-flow walkthrough KB (`ai-assistant-walkthrough.ts`) answers mid-flow questions via a context token; users cannot delete saved cash entries — a wrong entry stays REVIEW until an admin declines it from `/review?category=CASH`. Panel auto-minimizes after every navigation on desktop and mobile; the 💡 hint appears once per session. Earlier note: hotel bills go in **Purpose**; release info is Vessel row **View → Edit → End date/shift → Save** (needs `vessel.release`), with Release-page OCR → Approve as the image alternative. The launcher is an orange `Ask` pill; title bar shows only “Help: Al-Rifa'I” with `— □ ✕`; the rate-limit footer is hidden while `takeSlot` stays in the backend.

**Resilient names (E2.6 — deployed as v3.3.17-final):** employee search expands every plausible spelling variant (Bengali + Latin; j↔z, e↔i, u↔oo, a↔o, silent h) via `ai-assistant-names.ts` and `/api/employees/search?expand=1`, then unions and dedupes by mobile. Name answers are never silent: no match lists the tried variants and offers spelling/mobile/manual search; one match asks হ্যাঁ/না; several matches show a ranked list. "হিসাব/লেনদেন/পেইড" + a name resolves the person first, then runs the POSTED-only cash summary (current month by default). Context tokens (`ai-assistant-context.ts`, 10-minute TTL) remember the last domain/range/employee so "নেয়াজের?" after "গতকালের ক্যাশ" works; the generic fallback is localized Bengali/English instead of the old English dashboard line.

**Universal search / NL2SQL (E2.7 — deployed as v3.3.17-final):** unanticipated data questions (`ai-sql-engine.ts`) are mapped to a typed plan and one parameterised SELECT — e.g. "গতকালের মোট খরচ কত?", "কোন এমপ্লোয়ি সবচেয়ে বেশি টাকা পেয়েছে এই মাসে?", "বেলটোকিও মাদারের সব এসকর্ট". Safety: SELECT/WITH only; keywords (INSERT/UPDATE/DELETE/DROP/ALTER/TRUNCATE/GRANT/CREATE/CALL/COPY/SET…) and system catalogs are rejected, comments and multi-statement SQL refused, LIMIT 50 enforced, and execution runs inside a READ ONLY transaction with a 5-second statement timeout on the read-only pool. Results are summarised in Bengali (৳, 0/1/many rows) and never expose SQL, table or column names. Edit/delete requests never reach SQL; they explain the UI path (cash entries stay REVIEW until an admin declines them). Fast paths (templates → date summaries → person/name flows → navigation) still run first, so the LLM/SQL path only handles genuinely new questions.

**OCR:** on demand for `/release` slips — Ollama `qwen3-vl:2b` first, then DB keys with purpose `ocr`, then vision-capable platform keys (e.g. Gemini). Strict JSON extraction, max 12 MB image, no guessing of digits.

## 8. Security

- **SSH:** port 22, key-only (`PasswordAuthentication no`), `PermitRootLogin prohibit-password`.
- **Firewall (ufw active):** allow 22/tcp + 443/tcp; explicit REJECT for `23.132.164.185`; default deny inbound.
- **fail2ban:** jails `sshd` and `recidive` (1 currently banned each at audit time).
- **TLS:** certificate `CN=app.al-rifai.iamazim.com`, expires **2027-01-14**; served by the app's `deploy/tls-entry.mjs` behind `443→3443`.
- **Auth:** signed `__Host-` session cookie backed by `cash_portal_sessions`; roles `ADMIN` + `USER`; capability checks in every API route and page. No explicit idle-timeout constant found in code (sessions persist until logout or user disable).
- **Encryption:** platform LLM/assistant keys `enc:v1:`; recruitment keys plaintext; `.env` secrets live only on the host with `0600`.

## 9. Backup & Recovery

- **Rollback images (`local/al-rifai-platform`):** `v3.3.19-next16.4.6` (live), `v3.3.18-ui` (rollback), `v3.3.16-smart-sql`, `v3.3.15-pre-nl2sql`, `v3.3.15-smart-assistant`, `v3.3.14-pre-smart`, `v3.3.14-assistant-ux`, `v3.3.13-pre-assistant-ux`, `v3.3.12-pre-assistant`, `v3.3.12-hotfix`, `v3.3.11-employees`, `v3.3.11-pre-hotfix`, `v3.3.10-ui-cleanup`, `v3.3.10-pre-employees`, `v3.3.9-fixes`, `v3.3.9-pre-ui`, `v3.3.8-ai-full`, `v3.3.8-pre-fixes`, `v3.3.7-ai-routing`, `v3.3.7-pre-full`, `v3.3.6`, `v3.3.6-preai`.
- **Recruitment images:** `0.1.15-lid-filter` (live), `0.1.14-kb-overhaul`, `0.1.13-kb-voice`, `0.1.12-flow`, `0.1.11-final`, `0.1.10-hardened`, `0.1.9-hardened`.
- **`.env` backups:** 15 files `/opt/al-rifai-platform/.env.bak.*` (latest `1795178732`, 2026-11-20, pre-tag-change).
- **Nightly recovery:** `alrifai-recovery.timer` → `scripts/operations/recovery.py --rehearse` at 03:15. Last run 2026-11-16: **PASS**, 66 tables verified, GPG-encrypted archive in `/var/backups/vps/al-rifai/`, `offHost: NOT_CONFIGURED`.
- **Offsite:** not configured. Manual dumps exist in `/var/backups/al-rifai/` (2026-11-08 vessel activation).
- **Recovery:** set `ALRIFAI_TAG=<rollback tag>` in `.env`, then `docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app sync`; DB restore only into a `alrifai_restore_validation_*` database.

## 10. Current Feature Status

| Feature | Status | Version Added | Notes |
|---|---|---|---|
| Employee workspace (detail card, sidebar, sub-tables) | Live | v3.3.11 | E1; 500 hotfix v3.3.12 |
| Employee file upload/documents | Live | v3.3.11 | grants fixed v3.3.12 |
| Fuzzy employee search (pg_trgm, badges) | Live | v3.3.13 | migration 029 registered |
| Bengali→Latin transliteration | Live | v3.3.13 | character map, names + vessel/cash |
| AI assistant intelligence (search/navigate/summarize/guide/sidebar) | Live | v3.3.13 | deterministic planner + read-only APIs |
| Assistant blocked topics | Live | v3.3.13 | enforced before LLM |
| Chat window controls (min/max/close) | Live | v3.3.13 | E2.3 |
| Mobile chat (375 px, safe-area) | Live | v3.3.13 | CSS-level; browser QA pending |
| URL registry | Live | v3.3.13 | real params; `/cash` has no date filters |
| API key management + model test | Live | v3.3.7–3.3.8 | encrypted except recruitment |
| Recruitment AI (separate app) | Live | 0.1.15-lid-filter | separate deploy |
| Release OCR | Live | v3.3.x | Ollama vision + fallback |
| Home dashboard (5×4 cards) | Live | v3.3.6 | mobile two-per-row from v3.3.18-ui |
| Next.js 16.4.6 security patch | Live | v3.3.19-next16.4.6 | OSV 0; React 19.2.6 unchanged |
| Home employee search (name / alias / mobile) | Live | v3.3.18-ui | two-column suggestion with posted Cash total |
| Cash partial mobile/ID lookup | Live | v3.3.18-ui | last-11-digit substring match (list + count) |
| Cash Import/Export/Print icon group | Live | v3.3.18-ui | shared export controls; profile has Export + Print only |
| Employee cash statement Total Amount / Payout Mobile | Live | v3.3.18-ui | POSTED running balance; State/Source hidden from table |
| Draggable floating assistant | Live | v3.3.18-ui | pointer drag, viewport clamp, localStorage position |
| Review queue (domain tables) | Live | v3.3.5+ | |
| Cash paid-events API/UI | Live (feature-flagged) | Phase 3 | `PHASE3_PAID_EVENTS_ENABLED` default 0 |
| Vessel draft delivery worker | Disabled by default | Phase 3 | 3 gates required |

## 11. Known Limitations & Future Work

- Explicit date-range parsing (e.g. "15 August – 23 September") is not implemented; the assistant refuses rather than showing an all-time total.
- LLM transport has no tool-calling channel; functions are declared schemas run by a deterministic planner + browser executor.
- Bengali transliteration is a character map, not phonetic; inherent vowels are not inserted (`রহিম → rhim`).
- No browser/UI test library on the host; browser E2E runs only in the isolated staging stack (Dockerized Playwright). Browser QA for v3.3.18-ui is **OWNER-CONFIRMED**; Production authenticated regression is **NOT VERIFIED**.
- Home search totals use `/api/employees/summary` (POSTED postings); the employee-profile `Total Paid` header is instruction-based, so the two can differ where REVIEW rows exist.
- v3.3.18-ui kept the 1000 px profile breakpoint by Owner decision (1024 px stays side-by-side); Employee Profile has no CSV import by Owner decision. `/release` remains out of scope.
- **Next.js 16.4.6 is deployed (2026-11-20).** The November 2026 advisories affecting 16.4.1 were fixed in 16.4.5; OSV reports 0 for 16.4.6 / React 19.2.6. React stays 19.2.6. The agent-shell build nudge no longer triggers; Docker builds exit 0. Future advisories must be re-checked before the next upgrade.
- Offsite backup not configured (`offHost: NOT_CONFIGURED`); TLS renewal has no automated timer.
- No monitoring/alerting stack (no Prometheus, uptime agent or log aggregation).
- `README.md` is stale (v3.3.6 / 1.13.7 / 25 migrations) — this guide supersedes it for current state.
- Legacy duplicate routes exist (`/employee`, `/transactions`, `/vessel-register`); `/employees` and `/attendance` filters are client-side only.
- Attendance API without `limit` returns 200 rows (default); assistant requests 10000 and fails closed if truncated.
- `attendance` (legacy) and `attendance_records` coexist; security attendance is deduplicated in code.

### Staging verification (2026-11-20)

- Isolated Compose project `al-rifai-staging` (separate network, Postgres
  container and volume); app at `https://127.0.0.1:8443` with a self-signed
  certificate. No production volumes, tokens, DB or `.env` values are used.
- Synthetic data: 3 employees, 4 cash instructions (3 POSTED, 1 REVIEW); the
  staging schema was upgraded 1.12.0 → 1.13.8 with migrations 018–029.
- Dockerized Playwright v1.65: **8/8 PASS** — login, home/search, employee
  profile, cash, CSV/PDF export, SSE `/api/events`, assistant (read-only) and a
  browser console-error sweep.
- Evidence retained in `/opt/al-rifai-staging/artifacts` (screenshots incl.
  Home at 320/375/768/1024/1366, traces, HTML report, CSV/PDF). App and DB
  containers are stopped; the volume and config are retained for future reuse.
- This is **staging evidence only**, not Production verification. Staging uses
  synthetic data and `AI_LLM_ENABLED=0`; mobile Profile/Cash screenshots were not
  taken.

## 12. Development Commands

All commands run on the host as root; Node 22 is required (`/opt/node22/bin/node`).

```bash
# Build (current tag)
cd /opt/al-rifai-platform
docker build -t local/al-rifai-platform:v3.3.19-next16.4.6 .

# Deploy (only ALRIFAI_TAG may change in .env)
sed -i 's/^ALRIFAI_TAG=.*/ALRIFAI_TAG=v3.3.19-next16.4.6/' .env
docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml config >/dev/null
docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app sync

# Migration (checksum-tracked; preflight first)
docker run --rm --network vps-backend -v /opt/al-rifai-platform:/repo -w /repo \
  --env-file /opt/al-rifai-platform/.env node:22-bookworm-slim \
  node --experimental-strip-types scripts/standalone/migrate.mjs --preflight
# same command without --preflight to apply

# Typecheck + tests
cd /opt/al-rifai-platform
/opt/node22/bin/node ./node_modules/typescript/bin/tsc --noEmit
/opt/node22/bin/node --test tests/standalone/ai-provider.test.mjs tests/standalone/ai-llm.test.mjs \
  tests/standalone/ai-policy.test.mjs tests/standalone/ai-worker.test.mjs

# Rollback (image tag only)
sed -i 's/^ALRIFAI_TAG=.*/ALRIFAI_TAG=v3.3.18-ui/' .env
docker compose -p al-rifai-phase3 -f compose.yaml -f compose.phase3.yaml up -d --no-deps app sync

# Post-reboot / health check
bash /root/post-reboot-check.sh
```
