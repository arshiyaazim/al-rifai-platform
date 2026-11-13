# Changelog

## v3.3.0-escort-release — Escort Release parser + review UI (Batch 10)

- Structured release-slip parser now handles multiple escort numbers on one
  label and food bills written inline with the duty-day count.
- New `/release` page: 8 metric cards, search/date/status/mother filters,
  paginated review table, approve (applies the release) and decline
  (records a decision), plus a read-only cash cross-check.
- Structured backfill applied for the eligible slip (1 of 14; 5 already applied,
  3 incomplete, 5 without an eligible program). Payment-line slips were not
  bulk-applied.
- Previous releases: `v3.2.0-home-security` (Batch 9), `v3.0.0-phase4-merged`
  (Batch 8), `v2.9.1-cash-autoconfirm` (Batch 6).

## v1.12.0 — Cash Pipeline Overhaul

- Cash data re-derived from WhatsApp messages (`whatsapp_messages`) as the source of truth.
- Migration 017: `cash_instructions.event_at` stores the real WhatsApp event time.
- `created_at` remains database insertion time; `mirrored_at` remains mirror time.
- Admin WA-01 OUTGOING payment instructions auto-POST with posting + ledger entry; no approval step for this Cash path.
- 9-column `/cash` UI: Date, Employee ID, Name, Designation, Date of Join, Payouts, Amount, Total Paid, Actions.
- Date displays real event time in Asia/Dhaka (`DD-MM-YYYY` + `HH:MM AM/PM`); names are clean single-line values.
- Backfill: 2,359 POSTED instructions, 222 employees, ৳12,11,555.00 (1,211,555.00 BDT).
- 8 incomplete blocks preserved as `cash_submissions` in `PENDING_REVIEW`.
- Legacy IMPORT Cash rows replaced by WhatsApp-linked rows.
- Vessel, OCR, Bridge-2 and deferred tasks 13–15 unchanged.
