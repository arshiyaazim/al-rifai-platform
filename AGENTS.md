# AGENTS.md — AL-RIFA'I platform invariants

This file records the rules an automated agent or engineer must preserve when
changing this repository. It is intentionally short; detailed design notes live
in `docs/` and the Phase 3 reports.

## Safety boundary

- Never run migrations, cash postings, deployments, Docker rebuilds, WhatsApp
  pairing or outbound sends against production from this repository without a
  separate Owner approval.
- Production inspection is read-only. Schema execution, integration tests and
  experiments belong in a disposable database/container.
- Never discard unrelated dirty files, backups or branches. Do not use
  `git reset --hard`, destructive `git clean` or force-push.

## Cash / WhatsApp rules

- WA-01 is the only Cash/Vessel source account. WA-02 is identity-only and must
  never create a Cash or Vessel business record.
- A Cash payment is eligible only when it is an OUTGOING message from the
  verified Admin to the single authorized Accountant direct conversation,
  with valid provenance (message ID + block key). Do not broaden access.
- Owner single-mobile rule: when an eligible payment block has exactly one
  identifiable mobile number, that number is BOTH `employee_mobile` and
  `payout_mobile`. Two numbers keep the canonical ID + payout structure. Three
  or more numbers are ambiguous and go to review.
- Never invent a payment method. Accept only the verified markers and labels
  already used by the parser (`B/N/C/R`, `BKASH/NAGAD/CASH/ROCKET/BANK`, including
  the Bangla equivalents). A missing method is an incomplete instruction.
- An unregistered employee mobile is recorded as `UNREGISTERED`; never attach
  the payment to a different employee and never auto-create an unrelated one.

## Paid vs POSTED

- **Business Paid** = a verified `cash_payment_events` row.
- **Financial POSTED** = an immutable `cash_postings` / `ledger_entries` write.
- A verified WhatsApp payment creates a Business Paid Event automatically when
  `PHASE3_PAID_EVENTS_ENABLED=1`. It does NOT call `postInstruction()` and does
  NOT write `cash_postings` or `ledger_entries`.
- Financial posting keeps its separate `cash.post` authorization.
- Business corrections/reversals are append-only events. They must never
  generate a financial ledger reversal automatically.
- `PHASE3_PAID_EVENTS_ENABLED` defaults to `'0'`. It is separate from the
  Phase 3 router cutover setting.

## Database

- Migrations run in numeric order. 010 (`vessel_draft_deliveries`) must precede
  011 (`cash_payment_events`). Do not renumber them after they are deployed.
- Applied migration files are checksum-locked by `schema_migrations`. Changing
  an applied file requires an explicit, reviewed `--allow-checksum-change`.
- `cash_payment_events` and `cash_payment_event_postings` are append-only.
  Corrections/reversals are new rows; never UPDATE/DELETE financial history.

## Verification commands (isolated test DB only)

```bash
pnpm typecheck
pnpm lint
pnpm test:unit
pnpm test:standalone
pnpm test:paid-events
pnpm build
```

Set `PGHOST`, `PGPORT`, `PGDATABASE`, `PGSCHEMA`, `PGUSER`, `PGPASSWORD`,
`ALRIFAI_REVIEW_DB_USER` and `ALRIFAI_REVIEW_PASSWORD` to a disposable database.
Never point these at production.