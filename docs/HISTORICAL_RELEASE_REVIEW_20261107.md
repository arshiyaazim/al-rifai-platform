# Historical `RELEASE_UNSTRUCTURED` review — 2026-11-07

**Scope:** the seven production `review_items` with
`payload.releaseCategory = 'RELEASE_UNSTRUCTURED'`, all from WA-01 chat
`120363408741101070@g.us` ("Escort Release Slip"), all `INCOMING` on 2026-11-07
between 05:13 and 08:41 UTC.

**Outcome:** all seven are classified and matched to evidence **without any
production change**. No program, release date, payment, Cash posting or review
item was modified. Ambiguous records remain pending for manual review.

**Method:** production rows were read read-only; the improved
`parseUnstructuredRelease()` (`lib/release-slip.ts`) was run locally against
each exact raw text; candidate programs were looked up read-only in
`alrifai_v2_phase3` by extracted escort mobile / vessel name. Regression tests
pin all seven in `tests/standalone/historical-release-review.test.mjs`.

---

## 1. Per-item classification

| # | Review id / source message | Raw text (abridged) | Improved classification | Extracted evidence | Reusable? |
|---|---|---|---|---|---|
| 1 | `rev_da390319d03a40ee96cc` / `AC3488314AD921520B5A1EE1CFA9251E` | *(empty)* | `EMPTY` | none; reasons `EMPTY_MESSAGE`, `NO_VESSEL_IDENTITY`, `NO_ESCORT_MOBILE` | No — manual review only |
| 2 | `rev_d7c87e77d704407faef4` / `AC9A437A46EBBFEFDA399BB87CD9D7B9` | `ID: 01871663045 Md.Samir 01717909181(B) 1950/-food bill dukani bkash no` | `FOOD_BILL` | escort `01871663045`, name `Md.Samir`, food bill `195000` paisa, second mobile `01717909181` → `MULTIPLE_MOBILES` | Yes — food-bill evidence, no program update |
| 3 | `rev_3aa77fefc2b149729516` / `ACC5DD5C76F37BF9BF362B6B784C4863` | *(empty)* | `EMPTY` | none | No — manual review only |
| 4 | `rev_c0ea50971ac848f58882` / `AC71913DBA55B1DF4DCC22411A32869D` | `ID: 01871663045 Md.Samir 01871663045(B) (Relaced man)--- অফিসে আসার গাড়ি ভাড়া` | `REPLACEMENT` | escort `01871663045`, name `Md.Samir`, replacement + office car rent cue; `REPLACEMENT_NOT_AUTO_APPLIED` | Yes — replacement evidence |
| 5 | `rev_b58f76987982422cba05` / `AC5E4583FD833F41878A80A1690D020B` | `===( Ship-Cancaled)===` block | `CANCELLATION` (+ `FOOD_BILL`) | mother `Poavosa-Wisdom`, lighter `Deowan-Jobayer`, master `01711327593`, escort `01871663045` / `Md.Samir`, start `2026-10-25 (N)`, **cancel date `2026-11-07 (D)`**, 13 days, food bill `195000` paisa | Yes — richest evidence; still ambiguous on the `-1` lighter suffix |
| 6 | `rev_4b58b161b354453397a2` / `AC6A4C96C9161244232ABCCB9C4BA6BB` | *(empty)* | `EMPTY` | none | No — manual review only |
| 7 | `rev_5176f0749f274608b1a4` / `AC59A06D190824A611BAF4BD5F3B8B9D` | `D: 01920547773 Md.Nurun Nabi 01815282644(B) Righter v.s.:-Othoi-Cancaled, ব্যাচেল অথৈ থেকে নেমে … খাতিজা খাতুনে উঠছে বুট ভাড়া` | `TRANSFER` (+ `CANCELLATION`) | lighter `Othoi` (cancellation suffix stripped and flagged), escort `01920547773` / `Md.Nurun Nabi`, second mobile `01815282644`, boat-rent/transfer cue | Yes — transfer evidence; `TRANSFER` kind newly added |

None of the seven is a plain structured release; those go through
`handleReleaseSlip()` and are unaffected.

## 2. Candidate Vessel Programs (read-only source evidence)

| # | Strong key | Candidate program | Notes |
|---|---|---|---|
| 2 | escort `+8801871663045` | `lgcy-prg-6460107a3394b37f45636f544db01f2a0b9ec74a32c51e93b18bbaba21876d0e` — `Poavosa-Wisdom / Deowan-Jobayer-1`, `ASSIGNED`, start `2026-10-25` | Food bill only; no state change proposed |
| 4 | escort `+8801871663045` | same `lgcy-prg-6460107a…` | Replacement evidence; no state change proposed |
| 5 | escort `+8801871663045` + mother `Poavosa-Wisdom` + start `2026-10-25` | same `lgcy-prg-6460107a…` (`Deowan-Jobayer-1`) | Lighter in message is `Deowan-Jobayer` (no `-1`); escort mobile and mother/date agree. **Ambiguous on lighter name** → manual review |
| 7 | escort `+8801920547773` | `lgcy-prg-b61591e0eb6bd0570cea26b2847fd7ee7ca321ca038e053e17a93275dc614908` — `Union-Odyssey / Othoi-1`, `ASSIGNED`, start `2026-11-02` | Transfer to "Khatija Khatun" vessel; no destination program created. **Ambiguous** → manual review |
| 1, 3, 6 | none | — | Empty messages; no candidate |

Other `Poavosa-Wisdom` programs exist (`ZNS-2`, `Munsi-Deowan` (already
`RELEASED`), `Eurupe-1`, `Jafnun-Julfa-1`) but their escort mobiles differ, so
they are not proposed as matches for items 2/4/5.

## 3. Proposed corrections (NOT applied)

- **Release / cancellation (item 5):** evidence supports a cancellation on
  `2026-11-07 (D)` for `Poavosa-Wisdom / Deowan-Jobayer` with escort
  `01871663045`. Because the stored lighter is `Deowan-Jobayer-1` and the
  message says `Deowan-Jobayer`, an automatic `releaseProgram()` would be
  unsafe. Preserve as `RELEASE_CANCELLATION_CANDIDATE` with
  `candidateProgramIds` for a human decision.
- **Transfer (item 7):** record the transfer evidence and candidate program;
  do not create or release a new program for "Khatija Khatun".
- **Food bill (item 2):** record `foodBillMinor=195000` as evidence only; do not
  create a Cash instruction or posting.
- **Replacement (item 4):** record evidence only; do not replace an escort
  automatically.
- **Empty items (1, 3, 6):** keep pending; there is no evidence to reconstruct.
- **All seven:** keep `state='PENDING'` and `category='EXTRACTION_FAILED'`.
  No `review_decisions`, `program_events`, `program_pay`, `cash_postings` or
  `cash_instructions` rows were written.

The improved router applies to **future** messages only; it does not
retroactively rewrite these historical payloads. Re-running the router on the
old message ids would be a production business-data change and was not done.

## 4. Regression tests

`tests/standalone/historical-release-review.test.mjs` pins all seven exact raw
texts: classification, kinds, extracted fields, reasons, and the invariant that
the parser never exposes an `endDate`/`endShift` that could auto-release a
program. `tests/standalone/message-router.test.mjs` adds a router integration
test asserting `RELEASE_TRANSFER_CANDIDATE`, read-only candidate IDs,
`TRANSFER_NOT_AUTO_APPLIED` and an unchanged program state.

All suites pass: unit **128/128**, integration **124/124**, typecheck clean.
