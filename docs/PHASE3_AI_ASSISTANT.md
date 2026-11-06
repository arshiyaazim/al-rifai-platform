# Phase 3 WA-02 AI Communication Foundation

**Status:** IMPLEMENTED AND TESTED in an isolated branch/database; **NOT DEPLOYED**
**Branch:** `feature/phase3-router-cash-vessel` at `e7ab9d1` (pushed)
**Candidate image:** `local/al-rifai-platform:phase3-ai-dev-e7ab9d1`
**Candidate digest:** `sha256:a309fc26b0c229f9e5dedcf9fbdca14c9a9b7cbb1481f914c133e03f0b3a7133`
**Tests:** 83/83 unit, 110/110 integration; typecheck, lint, Next build, Docker build, audit clean
**Gate package:** [`docs/PHASE3_PRODUCTION_GATES.md`](./PHASE3_PRODUCTION_GATES.md)
**Production:** remains schema 1.4.0 on `alrifai_v2_phase3`
**Development schema:** 1.5.0 with `009_phase3_ai_assistant.sql`
**Feature flags:** `AI_WA02_ENABLED=0`, `AI_OUTBOUND_ENABLED=0`

---

## 1. Boundary

WA-01 remains the only Cash/Vessel business source. WA-02 is a separate AI
communication channel. It cannot enter the Phase 3 Cash/Vessel router: the
router's WA-02 business-chat list stays empty and the AI worker uses its own
`ai_*` tables, not `whatsapp_messages.processing_status`.

The AI never receives raw SQL or unrestricted bridge-send access. It receives
narrow tools and writes only AI-specific tables plus normal audited domain
writes where a tool explicitly permits them.

---

## 2. Schema (migration 009)

| Table | Purpose |
|---|---|
| `ai_contacts` | explicit WA-02 contact category and employee link |
| `ai_admin_jids` | explicit WA-02 privileged Admin identities |
| `ai_conversations` | conversation state and category |
| `ai_messages` | source-linked contact/assistant/system messages |
| `ai_applicant_drafts` | deduplicated applicant drafts |
| `ai_order_drafts` | WA-02 Vessel order drafts — never confirmed programs |
| `ai_job_catalog` | public role categories and cautious descriptions |
| `ai_outbound_messages` | full outbound lifecycle, idempotency and delivery state |
| `ai_outbound_attempts` | append-only evidence for every bridge send attempt |
| `ai_tool_runs` | append-only tool authorization/execution evidence |
| `ai_escalations` | Admin review and privacy escalations |

`ai_job_catalog` seeds role categories only. It does not seed salaries,
vacancies, joining dates or employment promises.

---

## 3. Policy and tools

Pure policy (`lib/ai/policy.ts`) handles:

- intent classification;
- prompt-injection detection;
- applicant and order-field extraction;
- public recruitment wording;
- employee record-level access.

Scoped tools (`lib/ai/tools.ts`) include:

- employee search and profile;
- employee financials (own record only unless Admin);
- vessel lookup;
- Cash summary and ledger (Admin only);
- applicant draft;
- order draft;
- message draft;
- source conversation (Admin only);
- audit (Admin only).

Every tool call is recorded in `ai_tool_runs`. WA-02 contact categories are
explicit; phone/name similarity alone never grants employee access.

---

## 4. WA-02 worker gates

The optional worker starts only when all are true:

1. `AI_WA02_ENABLED=1` in the process environment;
2. `app_settings.ai_wa02_enabled = true`;
3. `app_settings.ai_wa02_start_rowid:wa-02` is an explicit non-negative number.

It processes only WA-02 INCOMING messages above that rowid that are not already
in `ai_messages`. It does not mark the Phase 3 router processing state.

---

## 5. Messaging

Implemented:

- draft creation;
- preview;
- Admin approval;
- queue/history records;
- delivery status fields;
- source-reference provenance for forwarding drafts.

Not implemented / intentionally blocked:

- no live WhatsApp sender adapter;
- `AI_OUTBOUND_ENABLED=0` by default;
- `sendOutbound()` returns `AI_OUTBOUND_DISABLED` / `AI_SENDER_NOT_CONFIGURED`;
- no message is reported as sent merely because a draft exists.

A future bridge-send permission requires separate Owner approval and an
explicit, tested adapter.

---

## 6. What WA-02 can do now (in tests/clone)

- Unknown applicant: receives public role categories, is asked for name/phone/role,
  creates one deduplicated applicant draft; no private records.
- Verified employee: sees own profile, duty, program pay and recorded payments;
  cannot read another employee's record.
- Verified Admin: grounded employee/cash/vessel queries; drafts only.
- Prompt injection: escalated, no private tool call.
- Cash text on WA-02: does not create a Cash instruction.
- Escort client: creates an unconfirmed order draft and an Admin escalation;
  never creates or confirms a Vessel Program.
- AI-generated draft: DRAFT state only; no send.

---

## 7. Optional LLM layer

`lib/ai/llm.ts` is an OpenAI-compatible adapter. It is disabled unless
`AI_LLM_ENABLED=1` and a base URL, model and key are present. It receives the
already-authorized deterministic answer and may only rephrase it in Bangla or
English. Every numeric fact in the deterministic answer must survive unchanged;
otherwise, and on any timeout, HTTP error or empty response, the deterministic
answer is used. It has no SQL, tools, credentials beyond its own API key, or
send authority. Token/cost controls: request timeout, max output tokens,
per-minute and per-day call caps.

## 8. Remaining blockers / Owner decisions

1. Gate 1: production backup, migration `009` and image deployment.
2. Gate 2: apply the protected WA-01 allowlists and enable the router.
3. Gate 3: WA-02 consumer `messages.send`, app socket mount, explicit contacts,
   Admin JIDs, `ai_wa02_enabled`, `ai_wa02_start_rowid:wa-02`, test recipient.
4. LLM provider credentials, or confirm deterministic-only.
5. Recruitment policy text, job categories, salary/vacancy wording and
   escalation recipients.
6. Gate 4: approve narrow automatic replies.

No production flags, allowlists, credentials or bridge permissions were changed.

See [`PHASE3_PRODUCTION_GATES.md`](./PHASE3_PRODUCTION_GATES.md).
