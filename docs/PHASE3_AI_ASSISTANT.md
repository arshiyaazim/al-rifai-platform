# Phase 3 WA-02 AI Communication Foundation

**Status:** IMPLEMENTED AND TESTED in an isolated branch/database; **NOT DEPLOYED**
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
| `ai_outbound_messages` | DRAFT/PREVIEW/APPROVED/QUEUED/SENT/FAILED queue |
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

## 7. Remaining blockers / Owner decisions

1. Apply migration `009` to a production clone and approve production migration.
2. Configure explicit WA-02 contacts and Admin JIDs.
3. Set `ai_wa02_enabled` and `ai_wa02_start_rowid:wa-02`.
4. Decide whether to add an approved LLM provider; current responses are
   deterministic policy/templates grounded in database tools.
5. Approve or reject a bridge send adapter; currently no live sender.
6. Approve recruitment policy text, job categories, salary/vacancy publication
   rules and escalation recipients.
7. Approve WA-02 order-draft → Admin notification workflow.

No production flags, allowlists, credentials or bridge permissions were changed.
