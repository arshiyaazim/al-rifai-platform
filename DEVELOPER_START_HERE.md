# DEVELOPER_START_HERE.md — AL-RIFA'I Platform

> **Canonical current-state developer map — not a changelog.** Read this first before modifying code, database, Docker, WhatsApp ingestion, or deployment.
>
> **Last reconciled:** 2026-11-05. **Source:** GitHub `main` at `dd5d61a9f88698398a163959863bcc65f1549573`, repository source files, and the owner's latest VPS agent deployment report. **Runtime facts below are agent-reported, not independently re-measured here.**
>
> **Priority:** **BUILD → RUN → LIVE → IMPROVE**. Do not block releases on unrelated legacy data migration, historical Git branches, exhaustive tests, or non-blocking cleanup. Never claim a workflow is live solely because code exists.

## 1. Identity and authoritative locations

| Item | Current value / source |
|---|---|
| Git repository | https://github.com/arshiyaazim/al-rifai-platform |
| Git branch | `main`; owner reports clean and tracking `origin/main` |
| Verified push baseline | `dd5d61a9f88698398a163959863bcc65f1549573` |
| Local Git checkout (VPS) | `/opt/al-rifai-platform` |
| Standalone app source / root `.env` (VPS) | `/opt/vps/al-rifai-standalone/apps/al-rifai` |
| Public application | https://app.al-rifai.iamazim.com |
| Login | https://app.al-rifai.iamazim.com/login |
| Public health | https://app.al-rifai.iamazim.com/api/health |
| New PostgreSQL DB | `alrifai_v2`, schema `public`, version `1.1.0` |
| Legacy PostgreSQL DB | `alrifai` — retained, **not** active application DB |
| WhatsApp source WA-01 | `/var/lib/vps/whatsapp/wa-01/store/messages.db` |
| WhatsApp source WA-02 | `/var/lib/vps/whatsapp/wa-02/store/messages.db` |
| WhatsApp pairing/session stores | Each bridge's `store/whatsapp.db`; not application DB |
| Deployment definitions | `compose.yaml`, `Dockerfile`, `deploy/tls-entry.mjs` |
| Configuration template | `.env.example`; actual root `.env` excluded from Git |
| Schema baseline | `db/standalone/schema.sql` |
| Raw ingestion extension | `db/standalone/002_raw_import.sql` |
| Message worker | `scripts/sync-worker.mjs` |
| Fresh installer | `scripts/standalone/install.mjs` |
| Admin reset | `scripts/standalone/reset-password.mjs` |
| Env check | `scripts/check-env.mjs` |

**Canonical source rule:** `/opt/al-rifai-platform` is the canonical Git source. Make every source-code and documentation change there first, commit it, and push `main`. The deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` is synchronized **from a known Git commit**, never edited silently, and never given an independent development history. Synchronize before any production build, and never overwrite the deployment `.env` or other runtime secrets during synchronization.

## 2. Architecture and data flow

```text
WA-01 bridge messages.db ----\
                               -> read-only sync worker -> PostgreSQL alrifai_v2
WA-02 bridge messages.db ----/                           | raw messages, chat, identity
                                                          v
Browser -> HTTPS :443 -> Next.js app -> domain services -> PostgreSQL
                              |
                              +-> Cash / Vessel / Employees / Attendance / Payroll
                              +-> Review / Reports / Settings / Audit

Optional MCP relay processing is a separate path; do not confuse it with
the deployed SQLite direct-import / tail worker.
```

- **One application image, two application services:** `app` and `sync`; shared external Docker network `vps-backend`.
- **Existing infrastructure retained:** PostgreSQL and two paired WhatsApp bridges.
- **No separate Redis/Kafka/vector database or extra messaging service** in this deployment.
- **One primary application database**, with 29 tables reported after the raw-import extension.
- **Raw capture is not domain interpretation:** a message in PostgreSQL does not imply it has been classified into a cash instruction, vessel order, recruitment record, or AI conversation.

## 3. Ports, URLs, services and runtime resources

| Service | Internal / host exposure | Notes |
|---|---|---|
| Public HTTPS app | Host `0.0.0.0:443` → app container `:3443` | TLS handled by `deploy/tls-entry.mjs`; certificate/key read-only mounts from `/etc/vps/apps/al-rifai/tls/` |
| Next.js HTTP | Container `:3000`; host `127.0.0.1:3001` → `:3000` | Private loopback port; not a second public site |
| Sync worker | No exposed port | Reads two bridge SQLite stores via read-only bind mounts |
| PostgreSQL | Existing `vps-infra-postgres-1` | Connection values in root `.env`; do not guess or expose credentials |
| WA-01 / WA-02 bridges | Existing bridge services | Exact relay/control ports or sockets must be inspected if needed; not established by `compose.yaml` |

**Compose-defined resource limits:** app **512 MiB**, sync **192 MiB**. Agent's last measured use: app **~80 MiB**, sync **~23 MiB**. Agent reported disk **54 GB used / 194 GB total** (~141 GB free), new DB ~74 MB; numbers are a dated snapshot, not current telemetry. `containerd` remained ~18 GB; disk target is ideally ≤40 GB without damaging active infrastructure.

**Runtime baseline (agent-reported):** HTTPS health 200 with database OK and schema `1.1.0`; authenticated access to 10 workspace pages; new app deployed; old app stopped but retained for rollback. Image reported as `local/al-rifai-platform:20261105-v3` (`sha256:c29d837c…`); confirm actual digest from Docker before any rollback.

## 4. Code and directory map

| Path | Responsibility |
|---|---|
| `app/` | Next.js App Router pages and API routes; check actual route tree before documenting a newly added URL |
| `components/` | Reusable UI |
| `lib/` | Domain services, data access, auth, identity and integration helpers |
| `lib/env.mjs` | Shared environment loader |
| `db/standalone/` | Fresh database bootstrap and additive import schema |
| `db/postgres.mjs` | PostgreSQL access and environment initialization |
| `scripts/sync-worker.mjs` | SQLite historical import / continuous tail worker |
| `scripts/standalone/` | Installer and admin reset |
| `scripts/check-env.mjs` | Checks required environment keys without printing secrets |
| `deploy/` | TLS application entry |
| `tests/` | Focused unit and standalone tests |
| `docs/STANDALONE-MAPPING.md` | Supporting feature → code → DB mapping; update if changed |
| `docs/STANDALONE-VERIFICATION.md` | Supporting test evidence; not the canonical current-state map |
| `docs/STANDALONE-REMOVED.md` | Legacy feature-removal reference |
| `compose.yaml`, `Dockerfile` | Image, services, ports, mounts and limits |
| `.env.example` | Safe placeholder config, never live credentials |

**Documentation policy:** This file is the top-level map. Detailed references may remain in `docs/`, but they must not contradict this current-state summary. If they do, reconcile them during the same code change.

## 5. Features — implemented versus proven

Status terms: **LIVE** = owner agent reported real deployment/runtime validation; **IMPLEMENTED** = code/schema present, full operational behavior not independently verified; **PARTIAL** = some path works but requested end-to-end capability is incomplete; **NOT BUILT/NOT VERIFIED** = no proof of full implementation.

| Feature | Status | Current capability | Missing / next action |
|---|---|---|---|
| HTTPS, login, sessions | **LIVE** | HTTPS 443, login, protected workspace, admin reset; three retained accounts | Maintain when auth changes |
| Dashboard | **LIVE** (page) | KPI/workspace page renders | Validate each KPI against new DB when business data grows |
| Cash / ledger | **PARTIAL** | Create instruction in REVIEW; no automatic posting; ledger schema/UI | Cash WhatsApp parser parity and real approved posting not demonstrated |
| Vessel programs | **PARTIAL** | Create program; escort employee auto-created; pay fails closed without rate | Release parser, 11-column register, richer assignment/confirmation parity |
| Employees | **IMPLEMENTED** | Profiles and linked operations; fresh DB had 0 business employees | Employee-master phases and full identity enrichment |
| Attendance | **IMPLEMENTED** | Manual records and summaries | WhatsApp-driven attendance automation |
| Payroll | **PARTIAL** | Derived pay/rate model | Configure rates; advance, food and conveyance rules not complete |
| Review / audit | **IMPLEMENTED** | Review workflows, audit schema | Verify domain-specific approval paths as added |
| Reports / CSV | **IMPLEMENTED** | Export/report features in source | Verify current datasets/permissions as needed |
| Settings | **LIVE** (page) | Accounts, rates, relay settings and password functionality | Owner rate configuration pending |
| WA-01 historical import | **LIVE** | All source rows imported; last reported WA-01 19,058 | Keep source/checkpoint reconciliation |
| WA-02 historical import | **LIVE** | All source rows imported; last reported WA-02 15,027 | New WA-02 live-event proof pending |
| WA-01 continuous sync | **LIVE** (incoming group event) | New row observed after import, tail checkpoint advanced | Exercise outgoing/direct and edits when available |
| WA-02 continuous sync | **PARTIAL** | Tailer running, caught up, no last error | Observe real new incoming/outgoing event |
| WhatsApp full identity | **PARTIAL** | Account/chat/sender JIDs, source metadata, alias table | Contact-book name, profile name, PN↔LID resolution, group participant gaps |
| WhatsApp media | **PARTIAL** | Existing media metadata in source/import | **New media bytes** capture/storage/processing not proven; old media recovery not required |
| Recruitment conversations | **NOT BUILT/NOT VERIFIED** | No complete workflow established | Design from old source/docs, implement new module |
| Employee conversations | **NOT BUILT/NOT VERIFIED** | Raw messages available | Role-based conversation routing and employee actions |
| Client CRM / customer service | **NOT BUILT/NOT VERIFIED** | Raw messages available | Client identity, case state, reply workflow |
| AI assistant / AI-origin messages | **NOT BUILT/NOT VERIFIED** | Integration placeholders | Model/tool integration, source attribution, domain actions, approvals |
| Automatic cross-domain routing | **NOT BUILT/NOT VERIFIED** | Raw capture separate from processing | Classification, authorization, domain handlers, ambiguity queue |

**Fresh-data policy:** Owner does not require historical business data import. Agent reported **0 programs, 0 cash instructions, 0 employees and 0 postings** after removing temporary test records. Raw WhatsApp history is retained. Do not confuse “empty new business DB” with “broken app.”

## 6. Pipeline/workflow inventory

**Counting rule:** A pipeline is one independently meaningful end-to-end business/data flow. Below are **14 tracked logical pipelines**, **not** a claim that 14 background workers exist. Recount when adding/removing a flow. Status reflects the weakest critical step.

| # | Pipeline / workflow | Status | What works now | What remains |
|---|---|---|---|---|
| P01 | HTTPS → login → authorized workspace | **LIVE** | TLS, session, authenticated pages | Ongoing access checks |
| P02 | Fresh schema → DB connectivity → health | **LIVE** | 29-table DB, health OK | Repeat on next schema change |
| P03 | WA-01 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P04 | WA-02 SQLite → initial PostgreSQL import | **LIVE** | Full source snapshot copied | Maintain dedup/provenance |
| P05 | WA-01 new message → automatic DB tail | **PARTIAL** | New incoming group event proven | Outgoing/direct/edits/media bytes not proven |
| P06 | WA-02 new message → automatic DB tail | **PARTIAL** | Caught up; no error | Real new-event validation |
| P07 | Raw message → shared identity/contact resolution | **PARTIAL** | JIDs and alias structure | Full PN/LID, contact book and group attribution |
| P08 | Raw message → domain classification/action | **NOT VERIFIED** | Relay/domain code may exist | End-to-end automatic routing per domain |
| P09 | Cash instruction → review → posting/ledger | **PARTIAL** | REVIEW creation; posting schema | Authorized posting and message-parser parity |
| P10 | Vessel order → program → assignment → release | **PARTIAL** | Manual program/employee path | Parser, confirmation and release parity |
| P11 | Employee → attendance → payroll | **PARTIAL** | Core tables/UI and rate calculation | Rate setup, attendance automation, extras |
| P12 | Recruitment / employee / client conversations | **NOT BUILT/NOT VERIFIED** | Raw source messages available | Conversation UI, classification, workflows |
| P13 | New media → persistent bytes → processing | **NOT BUILT/NOT VERIFIED** | Metadata only | Download, storage, media processing |
| P14 | AI/admin → reply → WhatsApp → audit | **NOT BUILT/NOT VERIFIED** | No end-to-end proof | AI tools, outbound sender, source/audit linkage |

**Summary:** 4 LIVE, 7 PARTIAL, 3 NOT BUILT/NOT VERIFIED **if using table statuses exactly?** No: count programmatically when updating; **the table itself is authoritative**. Do not copy a stale summary count. (P01–P04 LIVE; P05, P06, P07, P09, P10, P11 PARTIAL = 6; P08, P12, P13, P14 NOT VERIFIED = 4.) **Current: 4 LIVE / 6 PARTIAL / 4 NOT VERIFIED.**

## 7. WhatsApp ingestion facts and boundaries

- Latest agent report: **34,085** PostgreSQL raw messages (WA-01 **19,058**, WA-02 **15,027**), 0 duplicates on `(account_id, chat_jid, message_id)`; counts change as new messages arrive.
- The sync worker reads **both bridge `messages.db` files read-only**. It does not read or overwrite either `whatsapp.db` session store.
- Import uses stable source snapshots and checkpoints; tailer is designed to resume and avoid duplicates.
- **Capture scope and business-processing scope differ:** store raw messages from both accounts as configured; process into Cash/Vessel/HR/CRM/AI only under explicitly defined domain rules. Never treat all WhatsApp messages as automatically authorized financial or business commands.
- Both incoming and outgoing, direct and group, are target capture paths. **Do not claim all combinations proven** until corresponding live events are observed.
- LID ≠ guaranteed phone number. Preserve unresolved identity instead of inventing a number.
- WhatsApp media metadata ≠ downloaded media bytes.
- Current README section 5 describes an **optional MCP relay** and older mock-only validation. This is **not the same path** as the deployed direct-SQLite worker. Update the README to distinguish them when touching integration docs.

## 8. Database and secrets

- **Current database:** `alrifai_v2`, PostgreSQL, schema version `1.1.0`, 29 tables reported; legacy `alrifai` retained for rollback and not part of the new application's business state.
- **Installer:** fresh `schema.sql` + `002_raw_import.sql`. Do not reintroduce the legacy migration chain just to match historical DB structure.
- **Dedup key:** `(account_id, chat_jid, message_id)`. `(account_id, message_id)` alone loses one known WA-01 duplicate-ID-across-chat case.
- **Central configuration:** `/opt/vps/al-rifai-standalone/apps/al-rifai/.env`; shared loader `lib/env.mjs`; `pnpm env:check` prints missing key names, not values.
- `.env` is **never committed**, copied into Docker images, or printed. `.env.example` holds placeholders only.
- Frontend-created login passwords are **hashed**, not stored in plaintext. Bootstrap admin password can be provided via `.env`; use `pnpm admin:reset` for recovery.
- WA session keys and media decryption material remain in bridge-owned storage; not copied into the main business DB.
- The owner prioritizes rapid delivery and simple configuration, not enterprise security tooling. Keep existing functional authentication and do not introduce new infrastructure as a prerequisite to ordinary feature work.

## 9. Fast build, deploy and essential checks

Work in the canonical checkout `/opt/al-rifai-platform`, commit and push `main`, then synchronize the deployment source `/opt/vps/al-rifai-standalone/apps/al-rifai` from that commit. The live `.env` stays only in the deployment source and is never committed, copied into Git, or overwritten by synchronization.

```bash
cd /opt/al-rifai-platform
git status --short
git pull --ff-only origin main
# Make scoped code changes; update this document in the SAME commit.
git add <changed-source-paths> DEVELOPER_START_HERE.md
git commit -m "feat: <concise change>"
git push origin main
```

For production deployment, use the existing `compose.yaml` and image workflow. **Do not assume a Git push automatically deploys code.** Build a new image only when runtime code changed; deploy only when authorized, then confirm:

1. `/api/health` returns 200 and database/schema match.
2. HTTPS login works and intended pages render.
3. Both WhatsApp worker checkpoints continue advancing when source rows arrive.
4. No active bridge pairing/session is disturbed.
5. Record actual image digest, Git SHA, deployment timestamp and measured RAM/disk here.

**No unnecessary large regression suites** for a docs-only edit. Do not restart Docker daemon, wipe bridge stores, or run broad Docker/volume pruning.

## 10. Current blockers and immediate priorities

| Priority | Work | Acceptance |
|---|---|---|
| 1 | Keep GitHub `main`, the canonical checkout and the deployment source aligned | `origin/main` = local HEAD, and the deployment source matches the committed documentation/source |
| 2 | Observe WA-02 new incoming/outgoing message | New source row reaches PostgreSQL once, checkpoint advances, no error |
| 3 | Confirm direct/group and outgoing coverage on both accounts | Real observed examples; no silent skips |
| 4 | New-media bytes capture (not historical recovery) | New photo/audio/video/document bytes persist with source/message linkage |
| 5 | Complete identity map | Bridge account, chat, participant, PN/LID, saved/contact/profile names where actually available |
| 6 | Domain conversation routing | Cash/Vessel/HR/Recruitment/CRM routed to proper handlers; no unauthorized automatic posting |
| 7 | Vessel rates and missing release/parser logic | Owner-configured rates; end-to-end order/release flow |
| 8 | Recruitment, employee conversations and AI assistant | Incremental modules, measured and deployed separately |
| 9 | Reduce disk below target if practical | Identify unused cache/images without removing live services |
| 10 | Optional legacy DB/container removal | Separate explicit owner decision; not a release prerequisite |

## 11. Mandatory maintenance rule — overwrite current state, do not append history

**Every code, configuration, schema, feature, workflow, port, URL, folder, Docker, Git, or deployment change MUST update this file in the same commit.** This includes feature removals and failed/blocked implementations that materially affect the current picture.

1. Read this file **before** modifying the system.
2. Inspect only the affected source/config/runtime area; do not launch a full audit for every small edit.
3. Update **only the affected existing sections/rows**: URLs/ports, folder paths, features, pipelines, status, blockers, resource measurements and release SHA as relevant.
4. **Replace stale values**. Do **not** append daily entries, repeated reports, old snapshots or sequential change histories.
5. If a pipeline is added, removed, split or merged, **renumber/recount the inventory and update its status**.
6. Distinguish **code present**, **tested**, **live**, **pending**, and **unknown**. Never upgrade a status based on inference.
7. Update the top “Last reconciled” date, Git commit baseline (after commit), and deployed image/commit **only when actually known**. Avoid a self-referential commit-SHA loop: use the last independently verified commit SHA or state “current commit” until pushed.
8. Update relevant `README.md` or `docs/` only when their detailed instructions changed; keep this file authoritative.
9. **Commit this file with the related code change and push `main`**. A docs-only correction is a valid standalone commit; it does not require an image rebuild or deployment.
10. Final agent report should state: **what changed, which sections were refreshed, commit SHA, push status, and whether production was deployed**.

**Anti-patterns:** append-only timeline; claiming a pipeline is complete from a UI route; copying raw secrets into docs; hiding failed checks; retaining obsolete ports/URLs; confusing old production with new standalone; rebuilding the image for documentation-only changes.

## 12. Handoff in one sentence

**AL-RIFA'I is a live, lean Next.js/PostgreSQL platform with two bridge-SQLite raw-message ingestion paths and core business UIs; the next engineering work is full WA-02 live proof, richer identity/media capture, and domain-specific conversation/AI workflows—not another infrastructure rebuild.**
