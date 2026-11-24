# Vessel Register — mobile layout (2026-11-24)

Status: **v3.3.27-vessel-mobile-header deployed** on 2026-11-24 05:51 UTC,
including the header refinement and the Playwright regression guard.

Scope: **mobile-only** layout of `/vessel`. Desktop, backend, database schema,
data sync, filters, imports, exports, print and all workflows are unchanged. No
migration was added or required.

## What changed

1. **Mobile header:** the existing menu + `AL-RIFA’I` bar now also shows
   `Vessel Register` on `/vessel` only.
2. **Two-column filter group:** `Total Programs`, `Last Month`,
   `Running Month`, `Clear Filters`, `Date From`, `Date To`, `Escort Client`
   and `Status` sit in two columns on phones.
   - The four KPI buttons share one width and one **64 px** height.
   - The four filter fields keep their previous **62 px** height.
   - Long labels wrap inside their own card; no item pushes another out of the
     viewport.
3. **One-column vessel selectors:** `Mother Vessel`, `Lighter Vessel`,
   `Escort Name` and `Escort Mobile` remain one per row.
4. **New Program:** moved below the filters; width/height are unchanged
   (297 × 44 px at 375 px viewport).
5. **Four icon actions:** `Print`, `Import CSV`, `Export CSV` and `Import Chat`
   are four equal **44 × 44 px** icon-only buttons in one row with equal
   spacing. No text inside the buttons; accessible labels/titles remain.

Desktop keeps the previous four-column filter grid, top action row and table
toolbar. The mobile-only rules are under `max-width: 640px`; the header title is
limited to the vessel route.

## Header refinement (v3.3.27)

- `Vessel Register` is right-aligned in the mobile bar, bold and 15px (2px larger
  than the previous 13px).
- The live indicator is a text-free colour dot beside `AL-RIFA’I`; green = live,
  amber = reconnecting/polling, grey = connecting. Its title/ARIA label still
  explains the state.
- The four duplicate mobile lines are removed visually: the page title, the
  `Vessel Register (n)` card heading, the WhatsApp-orders subtitle and the
  `Search & filters` heading. The page `<h1>` remains in the DOM as a visually
  hidden heading for assistive technology.
- Desktop keeps all four lines and the previous header/action layout.

## Verification

Tested against the current build on the isolated staging database
(`schema 1.13.8`), not production data.

| Check | Result |
|---|---|
| 320 px viewport | no horizontal overflow; 2-column filter group; 100 × 64 KPI; 44 × 44 icons |
| 375 px viewport | no horizontal overflow; 2-column filter group; 127 × 64 KPI; 44 × 44 icons |
| 414 px viewport | no horizontal overflow; 2-column filter group; 147 × 64 KPI; 44 × 44 icons |
| Desktop 1366 px | 4-column filter grid; mobile bar hidden; previous action sizes |
| Last Month / Clear | date values set and cleared correctly |
| New Program | dialog opens and cancels |
| Import Chat / Import CSV | dialogs open and close |
| Export CSV | HTTP 200, `text/csv` |
| Print | click completes without a page error |
| Typecheck | clean |
| Lint | 0 errors, 1 pre-existing unrelated warning |
| Production build | succeeded |
| Full integration suite | 239/270; 31 staging DB fixture/env failures unrelated to this UI change |
| Playwright regression | 2/2 passed (mobile 320/375/414 + desktop) |
| 320 px header | full `Vessel Register` text visible, right-aligned, bold 15px; live dot beside the brand |
| 375 px header | full `Vessel Register` text visible, right-aligned, bold 15px; live dot beside the brand |
| Duplicate mobile headings | absent; h1 remains visually hidden for assistive technology |
| Desktop | page title, card heading, subtitle and `Search & filters` all still visible |

## Automated regression test

`tests/e2e/vessel-mobile.spec.mjs` is a read-only Playwright guard. It logs in to
a staging URL, opens `/vessel`, and checks:

- right-aligned bold 15px `Vessel Register` header and full text at 320 px;
- text-free live dot beside `AL-RIFA’I`;
- removed duplicate mobile headings (with the h1 still available to assistive
  technology);
- two-column KPI/control group, 64 px KPI height, 62 px control height;
- one-column vessel selectors;
- four 44 × 44 icon-only actions in one row with equal spacing;
- New Program below the filter card;
- no horizontal overflow at 320/375/414 px;
- desktop keeps the full headings and four-column grid.

Run from `tests/e2e`:

```bash
npm install
npx playwright install chromium
E2E_BASE_URL=https://127.0.0.1:8443 \
E2E_USER="$STAGING_ADMIN_USER" \
E2E_PASSWORD="$STAGING_ADMIN_PASSWORD" \
npm test
```

Result against the staging deployment: **2/2 passed** (mobile + desktop).

## Deploy and rollback

Deploy tag: `local/al-rifai-platform:v3.3.27-vessel-mobile-header`.

```bash
ALRIFAI_TAG=v3.3.27-vessel-mobile-header \
  docker compose -p al-rifai-phase3 \
  -f compose.yaml -f compose.phase3.yaml \
  up -d --no-deps app sync
```

Rollback is image-tag only: set `ALRIFAI_TAG=v3.3.26-vessel-mobile-ui`
and repeat the same command. No database restore or schema rollback is needed.

## Production deployment (v3.3.27)

- Deployed 2026-11-24 05:51 UTC to project `al-rifai-phase3`, services `app` and
  `sync`, both on `v3.3.27-vessel-mobile-header`.
- Health: `ok`, database `ok`, schema `1.13.8`; 0 restarts and 0 startup errors.
- Pre-deploy backup: custom-format `pg_dump` of `alrifai_v2_phase3`, verified
  with `pg_restore --list`; previous `.env` saved root-only.
- Rollback: set `ALRIFAI_TAG=v3.3.26-vessel-mobile-ui` and repeat the compose
  command. No database restore is needed for this UI-only change.

## Previous deployment (v3.3.26)

- Deployed 2026-11-24 03:49 UTC to project `al-rifai-phase3`, services `app` and
  `sync`, both on `v3.3.26-vessel-mobile-ui`.
- Health: `ok`, database `ok`, schema `1.13.8`; 0 restarts and 0 startup errors.
- Pre-deploy backup: custom-format `pg_dump` of `alrifai_v2_phase3`, verified
  with `pg_restore --list`; previous `.env` saved root-only.
- Rollback: set `ALRIFAI_TAG=v3.3.25-escort-office-intake-next16.4.6` and repeat
  the compose command. No database restore is needed for this UI-only change.

## Non-goals

- No change to `/vessel/[id]`, `/vessel/drafts`, `/vessel/register` or any other
  page.
- No change to API routes, database queries, WhatsApp processing, cash, payroll,
  attendance, review or authentication.
- No data migration.
