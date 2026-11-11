# Changelog

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
