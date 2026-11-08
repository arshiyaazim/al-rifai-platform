# Vessel Draft activation — Owner approval package

**Date:** 2026-11-08
**Branch:** `feature/phase3-010-011-activation` (`03b1526`)
**Image built (not deployed):** `local/al-rifai-platform:phase3-ai-rc-activation-03b1526`
**Image digest:** `sha256:d7ae28d210f97edda9d8f05e0ea79e0f2dce82b64f1377d12ef97e222342386f`
**Production rollback image:** `local/al-rifai-platform:phase3-ai-rc-8a6c2c6`
**Production state:** unchanged, healthy, schema `1.6.0`, migrations 002–011,
49 tables, 0 delivery rows, 0 Business Paid Events, 0 posting links.

> **No message was sent.** This package requests approval for one controlled
> real WhatsApp draft delivery and for the exact activation change. The sending
> account has no `messages.send` capability today, so even an accidental gate
> change cannot deliver a message.

## 1. Exact identities

| Role | Value | Notes |
|---|---|---|
| Sending account | `8801880446111@s.whatsapp.net` (WA-01) | The only Cash/Vessel source account. WA-02 has no role. |
| Admin recipient | WA-01 Admin LID (`9328…1172@lid`) | Resolved from the Admin's own OUTGOING messages in the original order conversations. It is the same Owner identity already configured in `whatsapp_accounts.admin_jids`; it is not a client and not a group. |
| Admin fallback set | `whatsapp_accounts.admin_jids` for `wa-01` | The sending account's own phone-number identity is excluded at runtime. A group JID is always refused. |
| Original order chats | One ORDERS group and one direct LID chat (values masked here) | Client senders are never recipients. |

Run the preflight with `--show-identities` on the Owner-controlled host to print
the unmasked JIDs; this committed document deliberately masks the private LID.

## 2. Live DRAFT set (read-only production inspection)

- **8** programs are in `DRAFT`.
- **3** originate from the ORDERS group; **5** originate from the direct LID chat.
- **5 of the 8 share the same source message** (`AC8844…A7`), so they are likely
  duplicate drafts of one order. The idempotency key is per program, so enqueuing
  all eight would deliver eight messages.
- **Recommendation:** approve one controlled send for one named program first.
  Review the five same-source DRAFTs before enabling the worker for the rest.

## 3. Exact message content (approved template, one example)

Program `prog_df6a840cee55d392022df783` (read-only; no gaps):

```text
Mother Vessel: M.V. Beltokyo
Importer
Lighter Vessel:M.V. Banglar-Modhumoti-1
Master mobile:-01720-614025
Destination:
Escort Name:
Escort mobile:
07/11/26 ((N))

Al-Rifa'i Integrated Services
```

`Escort Name` and `Escort mobile` are intentionally blank. The Admin's completed
outgoing reply in the **original order chat** remains the only confirmation; the
delivery never assigns an escort and never changes a program.

## 4. Exact code behavior in this branch

| Control | Behavior |
|---|---|
| Recipient | Explicit `ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID` wins; otherwise the Admin participant in the source conversation. Client sender, group, self phone-number, ambiguous admin set and missing source message are refused and audited. |
| Sender identity | `get_native_account_identity` is called before every send and must match `ALRIFAI_VESSEL_DRAFT_SENDER_JID` (device suffix normalised). Mismatch/unreadable identity → no send. |
| Idempotency | `vdd_<sha256(programId + sha256(text) + recipientJid)>`; `UNIQUE (program_id, content_hash, recipient_jid)`. |
| Claim/retry | `FOR UPDATE SKIP LOCKED`, 60 s lease, 3 attempts, 60/120 s backoff, then `DEAD`. |
| Ambiguity | Timeout/dropped socket → terminal `DELIVERY_UNKNOWN`, never auto-resent. Abandoned lease → `DELIVERY_UNKNOWN`. |
| Audit | Append-only `audit_events`: QUEUED, RECIPIENT_BLOCKED, CLAIMED, SENT, FAILED, DELIVERY_UNKNOWN. |
| Kill switches | env `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED` **and** DB `app_settings.vessel_draft_outbound_enabled` **and** worker switch **and** approved sender/recipient **and** real socket/token. |

## 5. Exact activation change requested

1. Create **one narrow WA-01 consumer token** with `messages.send` scoped to the
   approved Admin recipient. Do not widen the existing read token; do not touch
   WA-02.
2. Mount the WA-01 bridge socket and that token read-only into the app container.
3. Set:
   - `ALRIFAI_VESSEL_DRAFT_WORKER_ENABLED=0` (manual tick first; worker later),
   - `ALRIFAI_VESSEL_DRAFT_OUTBOUND_ENABLED=1`,
   - `ALRIFAI_VESSEL_DRAFT_SENDER_JID=8801880446111@s.whatsapp.net`,
   - `ALRIFAI_VESSEL_DRAFT_RECIPIENT_JID=<the approved Admin LID>`,
   - `ALRIFAI_VESSEL_DRAFT_SENDER_SOCKET=<WA-01 socket>`,
   - `ALRIFAI_VESSEL_DRAFT_SENDER_TOKEN_FILE=<narrow token file>`.
4. Insert `app_settings.vessel_draft_outbound_enabled=true` only for the
   controlled window.
5. Run **one** controlled command:

```bash
node --experimental-strip-types scripts/standalone/vessel-draft-activation.mjs \
  --enqueue --program=<approved-program-id> --confirm-enqueue
node --experimental-strip-types scripts/standalone/vessel-draft-activation.mjs \
  --tick --limit=1 --confirm-send
```

6. Verify: bridge `success:true`, one `SENT` row with `delivery_ref`, one
   `VESSEL_DRAFT_DELIVERY_SENT` audit row, no duplicate on re-enqueue, and no
   client/group recipient.
7. Immediately set both kill switches back to off. The table can stay empty or
   retain the single audit row; no legacy data is touched.

**Rollback:** disable both kill switches (instant, no data restore), then
`ALRIFAI_TAG=phase3-ai-rc-8a6c2c6` for the previous image. No schema rollback is
needed; no migration is applied by this branch.

## 6. Business Paid activation requested separately

One environment change and restart: `PHASE3_PAID_EVENTS_ENABLED=1`. It switches
the eight dashboard cards and `/cash/paid` to verified Paid Events plus legacy
POSTED rows with no double count. It does **not** backfill, post to the ledger,
or call `postInstruction()`. Flag OFF keeps the POSTED-only basis. Approve this
separately from the Vessel send.

## 7. Approvals

- [ ] Deploy image `phase3-ai-rc-activation-03b1526`.
- [ ] Grant narrow WA-01 `messages.send` and mount socket/token.
- [ ] Approve the exact Admin recipient LID.
- [ ] Approve one named program and the exact message text in §3.
- [ ] Approve one controlled real send, then immediate kill-switch off.
- [ ] Approve `PHASE3_PAID_EVENTS_ENABLED=1` (separate).
- [ ] Confirm the five same-source DRAFTs are duplicates or should each send.

Until every box is approved: `MANUAL_COPY_ONLY`, no `messages.send`, no send, no
flag activation.
