# WhatsApp MCP Bridge → Main Database message mirror

**Verified:** 2026-11-08  
**Status:** message mirror **complete at the message-record level**; media-file/status
mirror **partial**; production repair/redeploy **pending Owner approval**.

## 1. Architecture

```text
WA-01 Bridge / messages.db ─┐
                            ├─→ scripts/sync-worker.mjs ─→ whatsapp_messages
WA-02 Bridge / messages.db ─┘                         ├─→ whatsapp_media
                                                       ├─→ whatsapp_chats
                                                       ├─→ identity_aliases
                                                       └─→ whatsapp_sync_state

whatsapp_messages ─→ phase3-router-worker.ts ─→ message parser / router / review
```

- The bridge SQLite stores are the source of truth.
- `scripts/sync-worker.mjs` is the **only** process that reads the bridge stores.
- The parser and router read **only** the Main Database (`whatsapp_messages`), never
  a bridge SQLite file.
- Stable source identity: `(account_id, chat_jid, message_id)`.
- `raw_payload` preserves the original source fields; when PostgreSQL cannot store
  NUL/lone-surrogate text, `raw_payload.content_base64` preserves the exact bytes
  and `content_sanitized:true` makes the normalization explicit.
- `whatsapp_messages.processing_status` is owned by the router; synchronization
  never resets it.

## 2. Synchronization modes

| Mode | Purpose | Writes? |
|---|---|---|
| `--mode=tail` | Continuous new-message sync (default) | Yes |
| `--mode=import` | One-shot historical catch-up | Yes |
| `--mode=reconcile` | Full source↔main comparison; inserts missing rows, updates late edits/revocations, reports extra rows | Yes |
| `--mode=media-status` | Explicit media inventory/backfill; attempts files with URL/key, marks `SKIPPED` when source metadata is absent | Yes; requires `--confirm` |
| `--mode=status` | Checkpoints/counts/errors | No |
| `scripts/verify-message-mirror.mjs` | Read-only message-level and media-level comparison | No |

Safety properties:

- Checkpoint (`whatsapp_sync_state.last_rowid`) advances only after the batch
  insert/update has committed.
- A failed batch does not advance the checkpoint; the next tick retries.
- `ON CONFLICT (account_id, chat_jid, message_id)` prevents duplicates.
- The update predicate compares all mirrored fields, so a re-read applies late
  edits/revocations instead of silently keeping stale values.
- A full reconciliation runs on startup and every `SYNC_RECONCILE_EVERY` tail
  rounds (default 60, about 5 minutes).
- Media is never falsely reported as `STORED`: `STORED` means the file was
  downloaded, decrypted and hash-verified; `FAILED` is retryable; `SKIPPED` means
  the source no longer has URL/key/hash or media capture is disabled.

## 3. Current production evidence (2026-11-08T17:01Z)

| Metric | WA-01 | WA-02 |
|---|---:|---:|
| Source messages | **19,490** | **15,333** |
| Main Database messages | **19,490** | **15,333** |
| Missing | **0** | **0** |
| Extra | **0** | **0** |
| Duplicates | **0** | **0** |
| Field mismatches | **3 timestamps** | **0** |
| Checkpoint lag | **0** | **0** |
| Source media messages | 3,414 | 2,351 |
| `whatsapp_media` rows | 133 | 227 |
| Stored media files | 133 | 121 |
| Failed media | 0 | 106 |
| Missing media rows | 3,281 | 2,124 |
| Source media with URL | 3,256 | 2,016 |
| Source media with key | 3,256 | 1,893 |

The three WA-01 timestamp mismatches are **late source edits**: the source row
timestamp changed after the original import, while content and all other fields
match. The new full reconciliation updates them.

The media gap is the remaining mirror limitation. It is **not** a message-record
gap: every source media message has its metadata in `whatsapp_messages`
(type, filename, SHA-256, length). It is a file/status gap: historical media were
intentionally skipped by `--mode=import`, and 5,405 source media messages have no
`whatsapp_media` row. Most have a source URL/key, so a controlled
`--mode=media-status` backfill can copy them (subject to WhatsApp CDN expiry);
the rest will be marked `SKIPPED`.

## 4. Parser / router data source

`lib/message-router.ts` claims rows from `whatsapp_messages` using
`processing_status`, `source_rowid`, the cutover watermark and the explicit
business-chat allowlist. It never reads a bridge SQLite store. The mirror is
therefore the authoritative processing source.

Business scope is separate from mirroring:

- Both bridges are mirrored.
- Vessel/Cash processing is currently **WA-01 only** (`isVesselAuthorized`).
- WA-02 is mirrored but not processed for Vessel; enabling it is the separate
  Bridge 2 → Bridge 1 workflow, not a mirror change.

## 5. Bridge 2 → Bridge 1 Draft delivery

Not implemented in this mirror work. WA-02 has `admin_jids=[]` and an
identity-only consumer policy. WA-01 has the narrow send capability. The
existing vessel draft worker is disabled and targets the original order
conversation (from the previous activation directive). The Owner's clarified
direction is Bridge 1 Super Admin; that requires a separate approved change to
the draft-recipient policy/worker and, if WA-02 is the receiving bridge, its
permissions.

## 6. Commands

```bash
# Read-only mirror verification (safe against production)
node scripts/verify-message-mirror.mjs
node scripts/verify-message-mirror.mjs --strict --strict-media

# Full message reconciliation (writes; requires approval)
node scripts/sync-worker.mjs --mode=reconcile

# Explicit media status/backfill (writes; requires --confirm and approval)
node scripts/sync-worker.mjs --mode=media-status --confirm

# Current checkpoints/counts (read-only)
node scripts/sync-worker.mjs --mode=status
```

Production env file:
`/opt/vps/al-rifai-standalone/apps/al-rifai/.env`
Bridge stores:
`/var/lib/vps/whatsapp/wa-01/store/messages.db`,
`/var/lib/vps/whatsapp/wa-02/store/messages.db`.

## 7. Remaining work / approvals

1. **Deploy the updated sync worker** (new image / sync container recreate) —
   production-impacting; requires approval.
2. **Run `--mode=reconcile`** once on production to apply the three late edits and
   establish the full-reconciliation baseline. Requires approval for the DB
   update.
3. **Run `--mode=media-status --confirm`** in bounded batches to create accurate
   `whatsapp_media` rows and attempt historical file capture. Requires approval;
   monitor `SYNC_MEDIA_BACKFILL_LIMIT` (default 200) and media storage.
4. **Media source limitation:** if a historical URL/key has expired, the file
   cannot be recovered from `messages.db`; the row will be `FAILED`/`SKIPPED`
   with the source SHA/length retained. A bridge MCP `download_media` path would
   need separate review.
5. **Bridge 2 order processing / Bridge 1 draft delivery** remains blocked on the
   separate business/authorization change.
