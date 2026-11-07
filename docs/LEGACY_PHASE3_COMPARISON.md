# Legacy vs Phase 3 — Feature, URL and Database Comparison

**Verified:** 2026-11-07. **No production deployment of the new UI candidate yet.**
**Current production image:** `phase3-ai-rc-86d659a`.
**New UI candidate:** `phase3-ai-rc-169faa3`.

---

## 1. Route and page comparison

The legacy menu had 18 distinct browser routes. The previous candidate redirected
several to generic pages; that was incorrect. The new candidate provides an
independent Phase 3 page for every menu route.

| Legacy route | Phase 3 page | Function | Classification |
|---|---|---|---|
| `/dashboard` | `/dashboard` | KPI/dashboard | MODIFIED (Phase 3 cards, links) |
| `/transactions` | `/transactions` | Cash instructions + ledger, search/state/date, pagination, approve/reject/post/reverse, CSV | MODIFIED (core preserved) |
| `/cash` | `/cash` | Cash control, accounts, review, ledger, submissions | PRESERVED/MODIFIED |
| `/cash/transactions` | `/cash/transactions` | Cash transaction view | PRESERVED |
| `/cash/archive` | `/cash/archive` | Posted instructions + immutable ledger | MODIFIED (no legacy tab shell) |
| `/cash/submissions` | `/cash/submissions` | Cash submissions + router candidates + decisions | PRESERVED |
| `/submissions` | `/submissions` | My submissions | PRESERVED |
| `/vessel` | `/vessel` | Vessel control, review | PRESERVED |
| `/register` | `/register` | Vessel order/register workspace | PRESERVED |
| `/vessel-register` | `/vessel-register` | Vessel register | PRESERVED |
| `/vessel/register` | `/vessel/register` | Nested register | PRESERVED |
| `/vessel/vessel-register` | `/vessel/vessel-register` | Nested legacy register | PRESERVED |
| `/sources-review` | `/sources-review` | Review queue + Cash candidates | PRESERVED |
| `/insights` | `/insights` | Operational metrics | MODIFIED (tables/KPIs; no legacy charts) |
| `/income-expenditure` | `/income-expenditure` | Posted ledger income/expense, accounts, breakdown | MODIFIED (no legacy charts) |
| `/archive` | `/archive` | Audit trail + ledger archive | MODIFIED (no legacy multi-tab shell) |
| `/conversations` | `/conversations` | Chat list/counts/last activity | PRESERVED |
| `/message-mirror` | `/message-mirror` | Message search/list with identity | PRESERVED |
| `/assistant` | `/assistant` | Admin AI query page | PRESERVED/IMPROVED |
| `/employee` | `/employee` | Employee directory alias | PRESERVED |
| `/employee/[phone]` | `/employee/[phone]` | Profile + payment history | PRESERVED |
| `/transactions/employee/[phone]` | `/transactions/employee/[phone]` | Employee transactions | PRESERVED |
| `/employees`, `/attendance`, `/reports`, `/review`, `/messages`, `/settings`, `/payroll` | same | Existing Phase 3 pages | PRESERVED |
| `/signup`, `/public-site`, `/platform/*` | none | Legacy public/platform surfaces | LEGACY ONLY — OWNER DECISION |

All 29 tested routes returned HTTP 200 with an authenticated clone Admin session,
including the nested employee route.

### Known modified/missing UI details

- Legacy employee typeahead and “Add transaction drawer” are not reproduced;
  Phase 3 offers server-side filters and the Cash create form.
- Legacy insights/income chart components are replaced with accessible tables
  and KPI cards.
- Legacy archive multi-tab shell (cash/messages/vessels/evidence) is split into
  independent `/cash/archive`, `/archive`, `/conversations` and
  `/message-mirror` pages.
- Legacy public-site/signup/platform release-review surfaces have no Phase 3
  equivalent.

---

## 2. Database comparison

| Item | Legacy `alrifai` | Phase 3 `alrifai_v2_phase3` |
|---|---|---|
| Public base tables | 75 | 46 |
| Employees | 216 (`employee_master`) | 218 (216 + 2 derived) |
| Programs | 99 (`programs`; 5 incomplete drafts excluded) | 94 (41 released, 53 assigned) |
| Program assignments | 94 (`program_assignments`) | 94 (53 open, 41 closed) |
| Program pay | 93 | 94 (41 calculated, 53 unresolved) |
| Attendance | 439 | 439 |
| Cash instructions | 3,747 | 3,807 (3,747 import + 52 backfill + 8 live) |
| Cash postings | 1,586 | 1,586 |
| Ledger movements | 3,172 double-entry legs | 1,586 single DEBIT entries |
| WhatsApp messages | 42,817 processing / 14,578 original | 34,499 mirror |

### Mapping

- `employee_master` → `employees` (mobile identity, aliases, status, designation)
- `programs`/`program_assignments`/`program_pay` → `programs`/`program_assignments`/`program_pay`
- `attendance_entries` → `attendance` (confirmed source refs)
- `escort_rate_config` → `rate_config`
- `cash_instructions`/`cash_postings`/`cash_movements` →
  `cash_instructions`/`cash_postings`/`ledger_entries` (cash side of the
  double-entry legs; no invented income)
- `source_refs` → `source_message_id`/`source_hash`/`legacy`/audit evidence
- `whatsapp_*` → Phase 3 `whatsapp_messages`/`whatsapp_chats`/media/aliases

### Legacy tables/features with no direct Phase 3 equivalent

`escort_order_register` (raw order evidence beyond the normalized programs),
`business_commands`, `site_cash_archive`, `site_settlement_drafts`,
`site_payment_drafts`, `reconciliation_*`, `release_candidates`,
`apply_release_candidate`, platform workspace tables, public-site/signup,
legacy Excel cashbook archive and the old release-review workflow.

They are **not silently claimed as migrated**. Their historical source remains
in `alrifai`; importing them would require separate Owner-approved mappings.

---

## 3. Corrections implemented in the candidate

- Removed all generic legacy redirects.
- Added 19 independent pages/components for legacy menu and nested routes.
- Added `/assistant` Admin query UI using the scoped `/api/assistant` API.
- Reused Phase 3 Cash/Vessel/Employee/Attendance/Review services; no second data store.
- Fixed Date rendering in the nested employee payment page.
- Added no new migration and changed no production data.

### Clone verification

- All 29 routes 200 with an authenticated Admin session.
- No redirects for distinct pages.
- Cash tables/pagination/actions, vessel lifecycle detail links, review queue,
  conversations and message mirror render from Phase 3 data.
- Assistant query returns grounded `cash_summary` output.
- Logout and session expiry verified.

---

## 4. Live Cash evidence (production, current image)

While the candidate was in preparation, the live WA-01 router processed 8 real
Admin→Accountant messages:

- 8 new Cash instructions, all `REVIEW`;
- total **335,000 minor**;
- all 8 sender identities match the configured WA-01 Admin;
- zero duplicate source identity;
- zero postings;
- release-group messages correctly routed to review with no new programs.

This is genuine live Cash processing, not fabricated test data.

---

## 5. Remaining blockers

1. **DNS 1014** — `al-rifai.iamazim.com` still CNAME to another Cloudflare
   account. Requires Owner/Cloudflare access; see `docs/DNS_CLOUDFLARE_1014.md`.
2. **Production Admin/user credentials** — `.env` password files are empty.
   Owner must write them with `set-secret-password.mjs`; then run
   `provision-admin`/`provision-users` checks. Actual production login remains
   unverified.
3. **Candidate deployment** — image `169faa3` is built and tested but not
   deployed. Request Owner approval.
4. **Legacy features listed above** remain legacy-only; importing their tables
   would require separate approval and mapping.
