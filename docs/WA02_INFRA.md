# WA-02 Infrastructure — Phase 2 (config only, no send)

## Verified identity

| Item | Value |
|---|---|
| PostgreSQL account | `wa-02` |
| PN | `8801958122300@s.whatsapp.net` |
| Bridge store | `/var/lib/vps/whatsapp/wa-02/store/messages.db` |
| Bridge container | `vps-whatsapp-wa-02-cap4-20261011` |
| Current `admin_jids` | `[]` |
| Current policy | `wa-02-owner-reader` — `native.identity.read` only |
| Current sender socket | **absent** |
| Current sender token | **absent** |

## Bridge evidence (SELECT-only)

- WA-02 self messages: sender `8801958122300` (5,308 rows, `is_from_me=1`).
- Top incoming senders to WA-02:
  - Office Group `120363426895117693` (2,321)
  - `8801755627557` (1,116)
  - **`8801880446111` (696)** — Bridge-1 / Admin PN
  - `8801958122301` (258)
- The bridge store exposes multiple `@lid` chats. It does not expose a single
  authoritative paired LID row; resolve via `get_native_account_identity` when
  the WA-02 sender socket exists.

## Required policy change (NOT applied)

To mirror WA-01's sender:

```json
{
  "id": "alrifai-wa-02-send",
  "account": "wa-02",
  "capabilities": ["messages.send", "native.identity.read"]
}
```

Do **not** apply this until the Owner approves Step 19 Stage 2+. The bridge
policy lives at `/etc/vps/services/whatsapp/wa-02-consumer-policy.json` and is
outside the application repository.

## Sender paths (proposed, not created on host)

| Env | Proposed value |
|---|---|
| `ALRIFAI_WA02_SENDER_SOCKET` | `/wa-02-control/mcp.sock` |
| `ALRIFAI_WA02_SENDER_TOKEN_FILE` | `/etc/alrifai/wa-02-send.token` |

Repo example: `config/wa-02-sender.env.example`.

## Safety

- `system_feature_flags.wa02.ai_agent` stays **false**.
- No test message was sent (B5 / G4).
- Send verification is deferred to Step 19 staged unfreeze.

## Admin candidate decision

`8801880446111@s.whatsapp.net` is the strongest Admin candidate (696 incoming
messages to WA-02). `8801958122301` is the paired-number candidate. Owner must
confirm the final `admin_jids` before any WA-02 send is enabled.
