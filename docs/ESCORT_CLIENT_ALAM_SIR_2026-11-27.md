# Escort client addition — Escort Alam Sir (2026-11-27)

Status: **deployed as `v3.3.29-escort-client-alam-sir`** and merged to `main`
as `dbfc7dd`; app + sync healthy, schema `1.13.8`. No migration.

## Client identity

- Display name: `Escort Alam Sir`
- PN: `8801923008877@s.whatsapp.net`
- LID: `94107162673310@lid`
- The two identities already existed in `identity_aliases`; no new alias
  discovery was required.

## Code changes

- Added the client to the frozen Owner escort-client register.
- Added both PN and LID to the direct order-intake allowlist.
- Added both to the Vessel page client filter.
- Added both to the read-only backfill/audit client list.
- Added focused tests for registration, PN/LID intake and LID→PN phone mapping.

## Production configuration

- `whatsapp_chats` for both PN and LID: `purpose=ORDERS`,
  `source_role=ORDER_INTAKE`, `authorized=true`.
- `phase3_business_chats:wa-01` includes both JIDs.
- No `phase3_authorized_contacts` registry was configured; the existing
  verified-identity fallback authorizes both identities.
- No schema migration.

## Verification

- Production authorization check for both PN and LID returns
  `authorized=true`, `method=VERIFIED_IDENTITY`, role `ORDER_INTAKE`.
- A staging synthetic PN/LID order created a DRAFT, queued the office delivery
  with outbound disabled, and an office assignment updated the program to
  ASSIGNED with no outgoing message.
- Production live authorization processed two incoming order messages into
  three DRAFT programs. Draft copies went to the Owner and the Office group;
  no client message was sent.
- Controlled backfill (2026-11-26..27, outbound disabled):
  - 2 incoming client messages, 3 blocks, **0 missing**, 3 existing.
  - Created 0 new programs (the live router had already created them).
  - Updated 2 existing assignment rows.
  - No WhatsApp outgoing; queue counts unchanged.
- One canonicalisation edge case was found and fixed: `Glory of Srinagar 9`
  had been stored as `GLORY OF SRINAGAR 4`. The comparison now treats a
  trailing serial as identity; the program was corrected with an audit event
  (`VESSEL:LIGHTER_CORRECTED`) and `GLORY OF SRINAGAR 9` was added to the
  vessel directory.
- Two messages left in `PROCESSING` were safely retried after the 30-minute
  lease window; both completed with no duplicate programs or outgoing messages.

## Backfill safety

The backfill script forces `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=0` and passes
an explicit transaction to `createProgram`, so historical drafts are never
queued or forwarded. Before/after counts confirm:

- WhatsApp outgoing: unchanged (`8541` → `8541`).
- `vessel_draft_deliveries`: unchanged (`CANCELLED 3`, `QUEUED 17`, `SENT 41`).

## Rollback

Set `ALRIFAI_TAG=v3.3.27-vessel-mobile-header` for the previous image and repeat
the compose command. The authorization rows can be set back to their previous
`BOTH`/null state and the two JIDs removed from the business allowlist if the
Owner reverses the client addition. No schema rollback is needed.
