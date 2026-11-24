# Vessel mobile E2E regression

Small Playwright guard for `/vessel` mobile layout:

- right-aligned bold 15px `Vessel Register` header;
- text-free live dot beside `AL-RIFA’I`;
- duplicate mobile headings removed;
- two-column KPI/date/client/status group;
- one-column vessel selectors;
- four equal 44 × 44 icon actions in one row;
- no horizontal overflow at 320/375/414 px;
- desktop keeps the four-column layout and all headings.

## Run

The test needs a running environment with the staging admin credentials. It is
read-only: login, page load, CSS measurements. No POST, no data mutation.

```bash
cd tests/e2e
npm install
npx playwright install chromium
E2E_BASE_URL=https://127.0.0.1:8443 \
E2E_USER="$STAGING_ADMIN_USER" \
E2E_PASSWORD="$STAGING_ADMIN_PASSWORD" \
npm test
```

If the environment uses `STAGING_ADMIN_USER` / `STAGING_ADMIN_PASSWORD`, those
are accepted as fallbacks. The test is skipped when no credentials are set.
