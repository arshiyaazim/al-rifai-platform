# Mobile responsiveness audit

Scope: every authenticated workspace page (27 routes) plus `/login`.
Breakpoints checked: **320, 375, 414, 768 px**.

## Root cause

Wide `<table>` elements had no scroll container. Their min-content width
expanded the mobile layout viewport (e.g. `innerWidth = 1075` at a 375 px
device), so the `max-width: 600/768px` media queries never fired. The page was
then rendered as a shrunken desktop layout.

## Fixes

- Added an explicit Next.js `viewport` export (`width=device-width, initial-scale=1`).
- Contained every data table in its card/panel with `overflow-x: auto` so the
  panel scrolls and the page keeps the device width.
- Stacked filter grids (`filters`, `wx-filters`, `form .grid`, `ops-filterbar`,
  `inline-filters`, cash filters) to one column below 768 px.
- Filter/search/date fields and selects are full-width with a 44 px minimum
  height; submit buttons are full-width and 48 px tall.
- Touch targets: buttons, paging controls, row actions and nav links are at
  least 44 px; checkbox/radio labels are 44 px tall.
- Typography floor: visible app text is at least 14 px on mobile, including
  table cells and muted labels.
- Workspace navigation already collapses into a drawer at ≤900 px; mobile nav
  links and the hamburger button now meet the 44 px target.

## Verification

- 27 pages × 4 breakpoints: **0 horizontal page overflow**, **0 unwrapped
  tables**.
- 14 filter pages × iPhone SE / iPhone 14 / Pixel 7: **42 filter applications,
  0 failures**. Minimum field height 44 px; checkbox labels 44 px; all forms
  stayed on the same page with the filter applied.
- Hamburger/drawer opened with overlay on all three devices.
- Full-page review screenshot: before `1075 × 2345` (desktop layout viewport),
  after `375 × 2856` (device width).

## Known pre-existing issues (not caused by the responsive CSS)

- `/cash/transactions` returns HTTP 500 on the current HEAD build (backend /
  schema mismatch).
- `/transactions` times out on the current HEAD build.

## Screenshots

`before/` and `after/` contain 375 × 812 screenshots for login, dashboard,
review, cash, employees, messages, vessel drafts, payroll and settings.
`review-full.jpg` is the full-page before/after comparison. `after/detail-*.jpg`
cover the cash-instruction, review-item, vessel-program, employee and employee
directory detail routes.
