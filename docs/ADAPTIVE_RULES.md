# Adaptive Business Rules and Identity Resolution

**Status:** implemented and tested in isolation. No production configuration changed.

---

## 1. Why

The Owner needs to change parsing, names, phone numbers, aliases, vessel spelling,
release recognition and contact authorization without rewriting the application.
The implementation separates:

1. source identity (`whatsapp_messages`, bridge),
2. authorization (`phase3_authorized_contacts`, group participant records),
3. normalization (`business-rules.mjs`),
4. intent classification (`message-classifier.ts`),
5. field extraction (`history-extraction.mjs`, `release-slip.ts`),
6. entity resolution (`employee-identity.ts`, `identity-resolution.mjs`),
7. business validation (`programs.ts`, `finance.ts`),
8. event creation and persistence,
9. review/queue handling,
10. audit and provenance.

No single parser owns authorization.

---

## 2. Versioning

`lib/business-rules.mjs` exports `RULE_VERSION` and the shared defaults:

- cash duplicate window: 7 days (employee + amount);
- vessel near-duplicate window: 1 day;
- vessel same-lighter review window: 5 days;
- phone normalization, name normalization, vessel normalization, release token.

Review payloads and parser evidence include the parser/rule version so a later
change can be compared against historical decisions.

Changing a rule is a code change with tests, not an ad-hoc database edit. A
historical reprocessing run must use the dry-run/backfill tools and preserve
source identity; it must never post or approve automatically.

---

## 3. Phone normalization

`normalizeMobile` accepts:

- `01959122300`
- `০১৯৫৯১২২৩০০`
- `01959-122300`
- `+8801959122300`
- `8801959122300`

and returns `+8801959122300`. It never pads or truncates a malformed number.
`01959122300` and `01958122300` remain different; a one-digit difference is
evidence for review, not an automatic merge.

`phoneForms` produces exact comparison forms. `sameMobile` compares exact
normalized digits only.

---

## 4. Identity levels

`lib/identity-resolution.mjs` defines:

| Level | Meaning | Automatic financial/duty attachment |
|---|---|---|
| `EXACT` | canonical employee mobile or verified JID | yes |
| `VERIFIED_ALIAS` | previously confirmed alias/alternate number | yes |
| `CONTEXT_SUPPORTED` | multiple consistent signals | no — review |
| `AMBIGUOUS` | conflicting/incomplete evidence | no — review |
| `UNRESOLVED` | no reliable identity | no — review |

`resolveEmployeeIdentity` checks, in order: canonical mobile, `identity_aliases`
link, then name/alias evidence. Name similarity never authorizes a financial
posting.

---

## 5. Authorized contact registry

The Accountant/Client/Group authorization is effective-dated and stored in:

```
app_settings.phase3_authorized_contacts:<account>
[
  {
    "role": "ACCOUNTANT",
    "jid": "8801...@s.whatsapp.net",
    "aliases": ["...@lid"],
    "status": "ACTIVE",
    "effectiveFrom": "2026-01-01",
    "effectiveTo": null,
    "approvedBy": "owner",
    "reason": "Owner-approved replacement"
  }
]
```

- If the key is absent, the existing chat-purpose rule remains (backward compatible).
- If the key is present, Cash is **fail-closed**: only an active, in-date
  `ACCOUNTANT` entry can authorize the conversation.
- Changing the number never authorizes a newly observed number automatically.

Management command (dry-run by default):

```bash
node --experimental-strip-types scripts/standalone/manage-authorized-contact.mjs \
  --account=wa-01 --role=ACCOUNTANT --jid=8801...@s.whatsapp.net \
  --replace --reason="Owner-approved replacement"
```

Add `--apply` only after the exact JID is approved. The command writes an
`AUTHORIZED_CONTACT_UPDATED` audit event.

---

## 6. Release recognition

`lib/release-slip.ts` supports English and Bangla labels, `M.V.`/`এম.ভি.`
prefixes, duplicate headers, optional label-only messages, dates in
`DD/MM/YY`/`DD.MM.YY`, shifts and food/total evidence. A release group message
never reaches the order parser: structured slips are matched to exactly one
open program, all others go to review.

---

## 7. Tests

- `tests/standalone/business-rules.test.mjs`
- `tests/standalone/history-extraction.test.mjs`
- `tests/standalone/release-slip.test.mjs`
- `tests/standalone/message-router.test.mjs` (authorized registry, release)
- `tests/standalone/ai-assistant.test.mjs` (identity/privacy boundaries)

---

## 8. Future changes

1. Change the rule/parser and add a regression test.
2. Run the full suite.
3. Run the dry-run against historical messages.
4. Review count/amount differences before applying.
5. Apply only REVIEW records, never postings.
6. Preserve source IDs and audit.
7. Deploy through the approved release process.

The Income feature can be added later as CREDIT entries and additional accounts;
existing expense/payment history does not need to be rewritten.
