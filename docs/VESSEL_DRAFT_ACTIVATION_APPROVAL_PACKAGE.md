# Vessel Draft activation — Owner approval package

**Date:** 2026-11-08
**Branch:** `feature/phase3-010-011-activation` (`b379dd2`)
**Deployed image:** `local/al-rifai-platform:phase3-ai-rc-vd-b379dd2`
**Image digest:** `sha256:aec08d34f7f04b1a49495f74ec33ff29f21c7268e6e58e7948c83459ffa5602a`
**Production rollback image:** `phase3-ai-rc-8a6c2c6`
**Production state:** app healthy, schema `1.6.0`, migrations 002–011, 49 tables,
0 delivery rows, 0 Business Paid Events, 0 posting links. Outbound gate enabled;
delivery worker intentionally disabled until the first approved send is verified.

> **No message has been sent yet.** This package documents the corrected
> recipient rule, the duplicate investigation, the WA-01 transport, and the one
> candidate proposed for the first controlled live delivery. The first message
> requires the Owner's explicit approval of the exact program, recipient
> conversation and message text below.

## 1. Corrected recipient rule

A draft goes to the **same original authorised conversation that gave the
order**:

- direct Escort Client chat → that exact direct chat JID/LID;
- approved ORDERS group → that exact group JID;
- Admin JIDs are never a fallback;
- source message must exist and be unique;
- `programs.source_chat_jid` must exactly match the source message chat;
- the chat must be in `app_settings.phase3_business_chats:wa-01` and authorised
  with purpose `ORDERS` or `BOTH`;
- group senders must be active approved participants;
- direct senders must match the direct chat identity;
- missing, ambiguous or mismatched evidence blocks the draft with an audit row.

The worker repeats this resolution immediately before every send. A durable row
whose recipient no longer matches the source conversation is never sent.

## 2. WA-01 outbound transport

The existing WA-01 Bridge MCP broker remains the only transport. The change adds
one new consumer to the existing policy file:

| Item | Value |
|---|---|
| Consumer id | `alrifai-wa-01-send` |
| Account | `wa-01` |
| Capabilities | `messages.send`, `native.identity.read` |
| Token | New random token in `/etc/vps/apps/al-rifai/auth/wa-01-send.token`, mode 0400, owner 10001 |
| Policy | `/etc/vps/services/whatsapp/wa-01-consumer-policy.json`, mode 0600, owner 10002 |
| App mount | `/var/lib/vps/whatsapp/wa-01/control` → `/wa-01-control` read-only; token → `/etc/alrifai/wa-01-send.token` read-only |
| App group | supplementary GID 10002 so uid 10001 can connect to the 0660 socket |
| Sender identity | `8801880446111@s.whatsapp.net`; verified with `get_native_account_identity` before every send |

No WA-02 permission or scope is touched. No second WhatsApp connection is
created. No credential is committed.

## 3. Duplicate and ambiguity investigation (read-only)

Eight live DRAFT programs were inspected against their source messages.

| Program | Vessel / Lighter | Date / Shift | Source conversation | Disposition |
|---|---|---|---|---|
| `prog_5896…` | Union-Odyssey / Khadija-Khatun | 2026-11-05 / N | ORDERS group | Unique, but duty date is in the past. Not proposed. |
| `prog_1ce1…` | BELTOKYO / RIPA | 2026-11-07 / D | Direct client chat | Unique lighter. Destination in program (`ASHUGONJ`) disagrees with the source block order (`NOAPARA`), so not proposed. |
| `prog_b349…` | BELTOKYO / BANGLAR MODHUMOTI-1 | 2026-11-07 / D | Direct client chat | Same mother/lighter/date/mobile as `prog_df6a…`, different shift and source. Established ±1-day duplicate rule flags the pair. Excluded. |
| `prog_7b04…` | BELTOKYO / BEAUTY OF PATENGA | 2026-11-07 / D | Direct client chat | Unique and consistent; valid alternative candidate. Date/shift derived from the verified arrival timestamp. |
| `prog_76f4…` | BELTOKYO / SARENG-4 | 2026-11-07 / D | Direct client chat | Unique and consistent; valid alternative candidate. |
| `prog_b367…` | BELTOKYO / NAFSAN-3 | 2026-11-07 / D | Direct client chat | Unique and consistent; valid alternative candidate. |
| `prog_412b…` | Beltokyo / Nil-Doria | 2026-11-07 / D | ORDERS group | **Unique, complete, explicit date/shift. Proposed for the controlled live delivery.** |
| `prog_df6a…` | Beltokyo / Banglar-Modhumoti-1 | 2026-11-07 / N | ORDERS group | Duplicate conflict with `prog_b349…` (same mother/lighter/date/mobile). Excluded. |

The five programs from the multi-lighter order are **not** duplicates: the source
message lists five different lighters (RIPA, BANGLAR MODHUMOTI-1, BEAUTY OF
PATENGA, SARENG-4, NAFSAN-3) with different master mobiles. They are separate
lighter orders from one message.

No program was deleted, voided, merged or modified.

## 4. Proposed controlled delivery

| Field | Value |
|---|---|
| Program ID | `prog_412b6c5476ee4992e0db1c6e` |
| Mother Vessel | Beltokyo |
| Lighter Vessel | Nil-Doria |
| Master Mobile | 01711938930 |
| Destination | (blank, as in the source order) |
| Start Date | 2026-11-07 |
| Shift | D |
| Original source conversation | ORDERS group `120363426895117693@g.us` |
| Exact recipient | `120363426895117693@g.us` (same group) |
| Sender account | `8801880446111@s.whatsapp.net` (WA-01) |
| Source message | `ACD1FAD2AAD28411AAB47308B3E18AF4` |

Exact message content:

```text
Mother Vessel: M.V. Beltokyo
Importer
Lighter Vessel:M.V. Nil-Doria
Master mobile:-01711-938930
Destination:
Escort Name:
Escort mobile:
07/11/26 ((D))

Al-Rifa'i Integrated Services
```

Escort Name and Escort mobile stay blank; the Admin supplies them in the
confirmation reply in the same conversation.

## 5. Activation sequence

1. Deploy the corrected image; keep the worker disabled (`WORKER_ENABLED=0`).
2. Set `OUTBOUND_ENABLED=1`, sender JID, socket/token paths; set DB
   `vessel_draft_outbound_enabled=true`.
3. Verify the app can authenticate with the new token and read the WA-01
   identity; verify `send_message` is granted.
4. Enqueue only `prog_412b…` and run one controlled tick.
5. Verify the bridge result, WhatsApp message ID, one `SENT` row, one audit row,
   and no duplicate on re-enqueue.
6. Enable the worker (`WORKER_ENABLED=1`) for subsequent eligible drafts.
7. Rollback: disable both kill switches; restore the previous image tag. No
   schema rollback is needed.

## 6. Cash safety

`PHASE3_PAID_EVENTS_ENABLED` stays OFF. No `cash_postings`, `ledger_entries`,
`postInstruction()` or Paid Event backfill is part of this release.

## 7. Approval required

- [ ] Approve the exact program, recipient conversation and message text in §4.
- [ ] Approve the controlled live send and immediate verification.
- [ ] Approve enabling the worker after the controlled send.

Until that approval: no message is sent.
