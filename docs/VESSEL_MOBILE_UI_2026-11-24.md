# Vessel Register — mobile layout (2026-11-24)

Status: implemented on `feat/vessel-mobile-ui`, verified on staging, deployed to
production as `v3.3.26-vessel-mobile-ui`.

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

## Deploy and rollback

Deploy tag: `local/al-rifai-platform:v3.3.26-vessel-mobile-ui`.

```bash
ALRIFAI_TAG=v3.3.26-vessel-mobile-ui \
  docker compose -p al-rifai-phase3 \
  -f compose.yaml -f compose.phase3.yaml \
  up -d --no-deps app sync
```

Rollback is image-tag only: set `ALRIFAI_TAG=v3.3.25-escort-office-intake-next16.4.6`
and repeat the same command. No database restore or schema rollback is needed.

## Production deployment

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
