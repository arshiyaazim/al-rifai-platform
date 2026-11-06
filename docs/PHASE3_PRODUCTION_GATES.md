# AL-RIFA'I Phase 3 — Production Gate Package

**Status:** release candidate prepared; **no production migration, deployment,
feature activation or live outbound message has been performed.**
**Production baseline:** image `local/al-rifai-platform:phase3-rc-final5`,
database `alrifai_v2_phase3`, schema `1.4.0`, health 200.
**Development candidate:** schema `1.5.0`, image and digest recorded in §1.

Four approvals are required. They may be granted separately or together, but
silence is not approval.

| Gate | Scope |
|---|---|
| 1 | Production backup, migration 009 and image deployment |
| 2 | WA-01 Cash/Vessel business routing activation |
| 3 | WA-02 AI inbound, bridge send permission and first controlled outbound test |
| 4 | WA-02 narrow automatic customer-service replies |

---

## 1. Release evidence

| Item | Value |
|---|---|
| Branch | `feature/phase3-router-cash-vessel` |
| Release commit | `e3b56c4` (`main`, merge of `078352f`) |
| Feature branch | `feature/phase3-router-cash-vessel` at `078352f` |
| Candidate image | `local/al-rifai-platform:phase3-ai-rc-e3b56c4` |
| Candidate digest | `sha256:0625fd9034952ecbb861dfb3f518393742b678e01f0c1ad4830183404a6a7720` |
| Production DB | `alrifai_v2_phase3`, schema `1.4.0` |
| Test DB | `alrifai_v2_test`, schema `1.5.0`, 46 tables |
| Tests | 83/83 unit, 112/112 integration (verified at `e3b56c4`) |
| Checks | typecheck, lint, Next build, Docker build, `pnpm audit --prod` |
| Candidate smoke | health 200 on the migrated clone, `schemaVersion 1.5.0`; `/vessel`, `/employees`, `/attendance`, `/api/assistant` all 401; both workers disabled |
| GitHub | `main` and tag `v2.0.0-phase3-ai` point at the verified release source |

Migration rehearsal evidence (2026-11-06):

- Production clone `alrifai_v2_phase3_clone` restored from a `pg_dump -Fc`.
- `009_phase3_ai_assistant.sql` applied: schema `1.5.0`, 46 tables, 8 ledger rows.
- Row counts before/after identical: `whatsapp_messages=34442`,
  `whatsapp_chats=2013`, `whatsapp_accounts=2`, `cash_instructions=0`,
  `cash_postings=0`, `programs=0`, `audit_events=0`.
- AI tables created empty; `app_settings` contains no `ai_%` key.
- Fresh install and migration now both produce 46 tables and 8 migration rows
  (the previous 44/45 difference was the missing `schema_migrations` ledger row
  in the installer, now fixed).
- Migration `009` SHA-256: `319ecb43a2d4a22eb0c823205966961749ff10836715422444b7e180eda45321` (198 lines, 11 tables, 5 indexes, no destructive statement).
- Final read-only check on 2026-11-06 confirmed production is still exactly the
  rehearsal source: `messages=34442`, `chats=2013`, `accounts=2`, `postings=0`,
  `programs=0`, no `ai_%` or `phase3_%` settings, sync `wa-01=19636`,
  `wa-02=15184`. The clone remains representative.
- Production routes: `/login` 200, `/api/assistant` 401, `/api/vessel` 401,
  `/api/employees` 401 (authentication enforced).
- Disk: 125 GB free; existing rollback image `phase3-rc-final5`
  (`sha256:8681b8ab63deaeb6a9d31f38a52b96c6027db577ca6ac757b0996f34a47983ae`).

---

## 2. What changed in this release

### Corrections

- Normalized WhatsApp identity matching (bare/full/PN/LID/device forms) in
  `lib/message-router.ts`, without widening chat, group, account or direction
  authorization.
- Verified-Admin self-approval of a manual Cash instruction, with audit detail.
  General users still cannot approve or post; posting remains explicit.

### WA-02 AI

- Deterministic policy engine, explicit contact/Admin categories, scoped tools,
  applicant drafts, unconfirmed Vessel Order Drafts, escalations and audit.
- Optional OpenAI-compatible LLM that only rephrases an already-authorized
  answer and falls back on any numeric drift, timeout or error.
- Outbound lifecycle:
  `DRAFT → PREVIEW → APPROVED → QUEUED → SENDING → SENT / FAILED / DELIVERY_UNKNOWN`.
- Two kill switches: `AI_OUTBOUND_ENABLED` and `app_settings.ai_outbound_enabled`.
- Idempotency key per draft; `SENT` can never be sent again; a dropped
  connection becomes `DELIVERY_UNKNOWN` and is never auto-resent; stale
  `SENDING` rows are recovered as `DELIVERY_UNKNOWN`.
- Bridge acceptance is recorded as `BRIDGE_ACCEPTED`, not as delivered.
- Gate-4 narrow automatic replies exist but are off by default.

### Four business domains

- **Accounts:** instruction → review → approval (including audited sole-Admin
  self-approval) → explicit posting → ledger → reports; no automatic WhatsApp
  posting.
- **Vessel Register:** create, search/filter, detail view, edit, assign/replace
  escort, in-duty, release, complete and void — all through the authenticated
  UI/API with program events and audit.
- **Employee:** create, search/filter, profile, edit, status change, assignment
  and attendance history.
- **Attendance:** record, correct with reason and previous-value audit, date/
  employee filters, monthly summary and CSV export.
- **Admin Assistant:** employee, Cash, vessel, attendance/absent and running-duty
  queries through scoped tools.

---

## 3. Gate 1 — Production migration and image deployment

### 3.1 Fresh backup (read-only on production)

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p /var/lib/vps/al-rifai/backups
docker exec vps-infra-postgres-1 sh -lc \
  'pg_dump -U "$POSTGRES_USER" -Fc -d alrifai_v2_phase3' \
  > /var/lib/vps/al-rifai/backups/phase3-pre-1.5.0-$TS.dump
sha256sum /var/lib/vps/al-rifai/backups/phase3-pre-1.5.0-$TS.dump \
  > /var/lib/vps/al-rifai/backups/phase3-pre-1.5.0-$TS.sha256
docker cp /var/lib/vps/al-rifai/backups/phase3-pre-1.5.0-$TS.dump \
  vps-infra-postgres-1:/tmp/pre-1.5.0.dump
docker exec vps-infra-postgres-1 pg_restore -l /tmp/pre-1.5.0.dump | head
docker exec vps-infra-postgres-1 rm -f /tmp/pre-1.5.0.dump
```

Record `docker inspect` of the current app container and the current image ID
before replacing it.

### 3.2 Preflight and migration

```bash
cd /opt/al-rifai-phase3-test
export PATH=/opt/node22/bin:$PATH
PGHOST=vps-infra-postgres-1 PGDATABASE=alrifai_v2_phase3 PGSCHEMA=public \
  node --env-file=.env --experimental-strip-types \
  scripts/standalone/migrate.mjs --preflight
```

Expected: one pending migration, `009_phase3_ai_assistant.sql`. If anything
else is pending or a checksum mismatch appears, stop.

```bash
PGHOST=vps-infra-postgres-1 PGDATABASE=alrifai_v2_phase3 PGSCHEMA=public \
  node --env-file=.env --experimental-strip-types \
  scripts/standalone/migrate.mjs
```

Expected: `schemaVersion 1.5.0`, `tables 46`, `migrations 8`.

### 3.3 Image deployment (all feature flags still off)

```bash
cd /opt/vps/al-rifai-standalone/apps/al-rifai
ALRIFAI_TAG=phase3-ai-rc-e3b56c4 docker compose up -d app sync
docker ps --filter name=al-rifai-phase3
curl -sk https://app.al-rifai.iamazim.com/api/health
```

Expected: health 200 and `schemaVersion 1.5.0`. Keep
`PHASE3_ROUTER_WORKER_ENABLED=0`, `ALRIFAI_VESSEL_PROCESSING_ENABLED=0`,
`AI_WA02_ENABLED=0`, `AI_OUTBOUND_ENABLED=0`, `AI_AUTO_REPLY_ENABLED=0`.

### 3.4 Verification after deployment

```bash
docker logs --tail 50 al-rifai-phase3-app-1
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 -At \
  -c "select value from schema_meta where key='schema_version'" \
  -c "select count(*) from cash_postings" \
  -c "select count(*) from programs"
```

Expected: `1.5.0`, `0`, `0`; logs show both workers not started.

### 3.5 Gate 1 rollback

```bash
cd /opt/vps/al-rifai-standalone/apps/al-rifai
ALRIFAI_TAG=phase3-rc-final5 docker compose up -d app sync
```

The previous image ignores the additive 1.5.0 tables. Do **not** downgrade the
database automatically. If the schema itself is wrong, restore the verified dump
into a new database and repoint only after a separate approval.

---

## 4. Gate 2 — WA-01 Cash/Vessel routing activation

### 4.1 Revalidate scope (read-only)

```bash
cd /opt/al-rifai-phase3-test
export PATH=/opt/node22/bin:$PATH
PGHOST=vps-infra-postgres-1 PGDATABASE=alrifai_v2_phase3 \
  node --env-file=.env --experimental-strip-types \
  scripts/standalone/wa01-activation.mjs \
  --file=/var/lib/vps/al-rifai/private/phase3_activation_data.proposed.json \
  --watermark=19634
```

It prints counts only (no JIDs): 9 allowlisted chats, 26 participants, 0 WA-02
business chats, current WA-01 bridge maximum, and the number of pending
authorized messages above the watermark. `19634` is the historical continuity
watermark; the current bridge maximum was 19636 at audit time, and the verified
dry run on 2026-11-06 reported **0 pending authorized messages** above it (the
two newer rows are outside the 9-chat allowlist). The script refuses a
watermark above the bridge maximum and never derives it from the maximum.

### 4.2 Apply allowlists (router still disabled)

```bash
... scripts/standalone/wa01-activation.mjs \
  --file=/var/lib/vps/al-rifai/private/phase3_activation_data.proposed.json \
  --watermark=19634 --apply
```

This writes `whatsapp_chats` (authorized + purpose), the 26 group participant
authorizations, WA-01 Admin JIDs, `phase3_business_chats:wa-01` (9),
`phase3_business_chats:wa-02` (empty), both cutover rowids, and
`phase3_router_enabled=false`.

### 4.3 Enable routing

```bash
# DB gate
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 -c \
  "update app_settings set value='true'::jsonb where key='phase3_router_enabled'"
```

Set `PHASE3_ROUTER_WORKER_ENABLED=1` in the app `.env`; set
`ALRIFAI_VESSEL_PROCESSING_ENABLED=1` only if Vessel processing is approved in
the same gate. Recreate the app container and verify both settings read back.

### 4.4 Verify

- Only the 9 allowlisted WA-01 chats are claimed.
- WA-02 remains excluded (`phase3_business_chats:wa-02=[]`).
- Cash instructions appear in `REVIEW`; no posting occurs.
- Vessel Programs appear as `DRAFT`; only the verified Admin confirmation rule
  confirms them.
- Duplicate source instructions remain suppressed.

### 4.5 Gate 2 rollback

```bash
# Immediate: stop claiming new messages
docker exec vps-infra-postgres-1 psql -U vps_pg_admin -d alrifai_v2_phase3 -c \
  "update app_settings set value='false'::jsonb where key='phase3_router_enabled'"
```

Then set `PHASE3_ROUTER_WORKER_ENABLED=0` (and Vessel flag `0`) and recreate the
app. Preserve all created instructions/programs and audit evidence. Do not
delete `whatsapp_messages` or reset `processing_status`.

---

## 5. Gate 3 — WA-02 AI inbound and controlled outbound

### 5.1 Required bridge permission change

The WA-02 bridge policy currently grants only `wa-02-owner-reader`
(`native.identity.read`). The application has no `messages.send` consumer.

Provision a dedicated consumer (do not reuse the owner reader token):

```bash
umask 077
openssl rand -hex 32 > /etc/vps/services/whatsapp/wa-02-ai-sender.token
chown 10001:10001 /etc/vps/services/whatsapp/wa-02-ai-sender.token
chmod 400 /etc/vps/services/whatsapp/wa-02-ai-sender.token
# Mirrors the existing wa-02-reader.token ownership (uid 10001 = app user).
python3 - <<'PY'
import hashlib, pathlib
token = pathlib.Path('/etc/vps/services/whatsapp/wa-02-ai-sender.token').read_text().strip()
print(hashlib.sha256(token.encode()).hexdigest())
PY
```

Add to `/etc/vps/services/whatsapp/wa-02-consumer-policy.json` (preserve owner,
mode 600, and the existing owner reader entry):

```json
{
  "id": "wa-02-ai-sender",
  "account": "wa-02",
  "token_sha256": "<the digest printed above>",
  "capabilities": ["messages.send"]
}
```

Restart **only** the WA-02 bridge container after the policy file is valid. This
is a production bridge change and requires Gate 3 approval.

### 5.2 App container socket access

The app runs as uid 10001; the WA-02 control directory is `0710` uid/gid `10003`
and the socket is `0660` uid/gid `10003`. Mount the control directory and the
token file read-only and add group `10003`:

```yaml
services:
  app:
    group_add: ["10003"]  # gid of the WA-02 bridge control socket
    volumes:
      - type: bind
        source: /var/lib/vps/whatsapp/wa-02/control
        target: /run/whatsapp-wa-02
        read_only: true
      - type: bind
        source: /etc/vps/services/whatsapp/wa-02-ai-sender.token
        target: /run/secrets/wa-02-ai-sender.token
        read_only: true
```

Add to the app `.env`:

```
AI_WA02_SENDER_SOCKET=/run/whatsapp-wa-02/mcp.sock
AI_WA02_SENDER_TOKEN_FILE=/run/secrets/wa-02-ai-sender.token
```

### 5.3 LLM provider (optional)

No usable LLM credential exists in production. To enable natural language,
provide exactly: provider base URL, model name and API key. Then set:

```
AI_LLM_ENABLED=1
AI_LLM_BASE_URL=https://<provider>/v1
AI_LLM_MODEL=<model>
AI_LLM_API_KEY=<secret>
```

Without these, the assistant remains deterministic and fully functional for
grounded answers. The LLM never receives SQL, tools or send authority; it only
rephrases the authorized answer.

### 5.4 Stage A — inbound only

Configure explicit categories and Admin identity, then:

```sql
insert into ai_admin_jids (id, account_id, jid, label, active, verified_by)
values ('wa02-admin-owner','wa-02','<owner WA-02 JID>','Owner',true,'owner');

insert into ai_contacts (id, account_id, chat_jid, category, employee_mobile, active, verified_by)
values ('wa02-contact-<ref>','wa-02','<jid>','VERIFIED_EMPLOYEE','<mobile>',true,'owner');

insert into app_settings (key, value, updated_at)
values
  ('ai_wa02_enabled','true'::jsonb,now()),
  ('ai_wa02_start_rowid:wa-02','<explicit integer>'::jsonb,now()),
  ('ai_outbound_enabled','false'::jsonb,now())
on conflict (key) do update set value=excluded.value, updated_at=now();
```

Set `AI_WA02_ENABLED=1`, keep `AI_OUTBOUND_ENABLED=0`, recreate the app, and
verify inbound messages create conversation rows, applicant/order drafts and
escalations — with no outbound message leaving the process.

`ai_wa02_start_rowid:wa-02` must be an explicit number; do not use a moving
maximum. The WA-02 bridge maximum was **15184** at audit time. Recommended:
`15184`, which skips pre-activation backlog; a lower value requires explicit
Owner approval and a privacy review of the skipped conversations.

### 5.5 Stage B — first controlled outbound test

Set `AI_OUTBOUND_ENABLED=1` and `ai_outbound_enabled=true`. Provide one
authorized test recipient. Then use the Admin API (authenticated):

1. `draft.create` with the test recipient.
2. `draft.preview`, then `draft.approve`.
3. `draft.queue`, then `draft.send`.
4. `draft.status` — expect `SENT` and `delivery=BRIDGE_ACCEPTED`.
5. Send again — expect `AI_ALREADY_SENT`; no second bridge call.
6. Set `AI_OUTBOUND_ENABLED=0`, attempt a new send — expect
   `AI_OUTBOUND_ENV_DISABLED` (kill switch verified).

If the bridge drops the connection, expect `DELIVERY_UNKNOWN`; the message is
not retried. `draft.retry` only works for `FAILED` (explicit bridge rejection).

### 5.6 Stage C/D — Admin, recruitment, employee

- Admin conversation: employee search, employee profile, cash summary, vessel
  lookup, message draft, explicit approved send.
- Applicant: public role categories only; deduplicated applicant draft.
- Employee: own record only; another employee's record is denied.
- Prompt injection: escalated; no private tool call.
- WA-02 Cash-looking text: no Cash instruction.

### 5.7 Gate 3 rollback

Set `AI_WA02_ENABLED=0`, `AI_OUTBOUND_ENABLED=0`, and
`ai_wa02_enabled=false`. Recreate the app. Do not delete conversations, drafts,
attempts, escalations or audit rows. An already-sent message cannot be unsent;
preserve delivery evidence. To remove the bridge permission, restore the prior
policy file and restart WA-02.

---

## 6. Gate 4 — Narrow automatic customer-service replies

Enable only after Gate 3 is verified:

```
AI_AUTO_REPLY_ENABLED=1
```

Eligibility is enforced in code: only `UNKNOWN_CONTACT` / `JOB_APPLICANT`,
never prompt injection, and never a contact text or answer containing salary,
payment, employee, Cash, vessel, account, identity-document or address terms.
Eligible replies still traverse approve → queue → send with both kill switches.

Rollback: set `AI_AUTO_REPLY_ENABLED=0`; drafts become manual again.

---

## 7. Remaining Owner decisions / required inputs

1. Approve Gate 1, 2, 3 and 4 explicitly (individually or as a set).
2. Confirm WA-01 continuity watermark `19634` (or give another explicit value).
3. Approve the 9-chat / 26-participant WA-01 scope from the protected artifact.
4. Approve the bridge consumer policy change (`wa-02-ai-sender`,
   `messages.send`) and the app socket mount.
5. Provide one authorized outbound test recipient.
6. Provide LLM base URL, model and API key, or confirm deterministic-only.
7. Approve the recruitment wording/job catalog. The seeded catalog lists role
   categories only — no vacancies, salaries or joining dates.
8. Provide the WA-02 Admin JID and any verified employee contact mappings.
9. Approve the WA-02 AI start rowid.
10. Approve escalation recipients for applicant and order-draft notifications.

---

## 8. Known limitations

- Bridge acceptance is not delivery; no read/receipt tracking is implemented.
- WA-02 cannot confirm a Vessel Program; drafts remain unconfirmed and the WA-01
  Admin reply remains the only confirmation path.
- No automatic Cash posting.
- Manual `cash.ledger` entries still post directly; unchanged from Phase 3.
- LLM narrative is unavailable until credentials are provided; deterministic
  answers are used otherwise.
- GitHub Actions remains billing-locked; CI evidence is local only.
