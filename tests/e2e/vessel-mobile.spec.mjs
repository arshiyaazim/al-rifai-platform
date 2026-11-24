import {test, expect} from '@playwright/test';

const USER = process.env.E2E_USER || process.env.STAGING_ADMIN_USER;
const PASS = process.env.E2E_PASSWORD || process.env.STAGING_ADMIN_PASSWORD;

async function login(page) {
  await page.goto('/login', {waitUntil: 'domcontentloaded'});
  await page.locator('input[name="username"]').fill(USER);
  await page.locator('input[name="password"]').fill(PASS);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await page.waitForURL(/\/home/, {timeout: 30_000});
  await page.goto('/vessel', {waitUntil: 'networkidle'});
  await page.locator('.vessel-filter-grid').waitFor();
}

async function box(page, selector) {
  return page.locator(selector).evaluate((el) => {
    const r = el.getBoundingClientRect();
    return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
  });
}

test.describe('vessel mobile layout', () => {
  test.use({viewport: {width: 375, height: 812}, isMobile: true, hasTouch: true});

  test('header, live dot, filters, actions and overflow', async ({page}) => {
    test.skip(!USER || !PASS, 'E2E credentials are not set');
    await login(page);

    const header = page.locator('.wx-workspace__mobile-page');
    await expect(header).toHaveText('Vessel Register');
    const headerStyle = await header.evaluate((el) => {
      const c = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const bar = el.closest('.wx-workspace__mobile-bar').getBoundingClientRect();
      return {fontSize: c.fontSize, fontWeight: c.fontWeight, textAlign: c.textAlign, rightGap: Math.round(bar.right - r.right)};
    });
    expect(headerStyle.fontSize).toBe('15px');
    expect(headerStyle.fontWeight).toBe('700');
    expect(headerStyle.textAlign).toBe('right');
    expect(headerStyle.rightGap).toBeLessThan(20);

    const dot = page.locator('.wx-workspace__mobile-bar .realtime-status--dot-only');
    await expect(dot).toBeVisible();
    await expect(dot).toHaveText('');
    await expect(dot).toHaveClass(/realtime-status--(live|reconnecting|polling|connecting)/);

    await expect(page.locator('.vessel-register-head')).toBeHidden();
    await expect(page.locator('.vessel-filter-head')).toBeHidden();
    const hiddenTitle = await box(page, '.vessel-page-head');
    expect(hiddenTitle.h).toBeLessThanOrEqual(1);

    const grid = page.locator('.vessel-filter-grid');
    const columns = await grid.evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean));
    expect(columns).toHaveLength(2);

    const kpis = page.locator('.vessel-filter-grid > .vessel-kpi');
    const kpiBoxes = await kpis.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)};
    }));
    expect(kpiBoxes).toHaveLength(4);
    expect(new Set(kpiBoxes.map((b) => b.w)).size).toBe(1);
    expect(new Set(kpiBoxes.map((b) => b.h)).size).toBe(1);
    expect(kpiBoxes[0].h).toBe(64);

    const controls = page.locator('.vessel-filter-grid > .vessel-filter-control');
    const controlBoxes = await controls.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {w: Math.round(r.width), h: Math.round(r.height)};
    }));
    expect(controlBoxes).toHaveLength(4);
    expect(controlBoxes.every((b) => b.h === 62)).toBe(true);
    expect(new Set(controlBoxes.map((b) => b.w)).size).toBe(1);

    const vesselBoxes = await page.locator('.vessel-filter-grid > .vessel-filter-vessel').evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.x), w: Math.round(r.width)};
    }));
    expect(vesselBoxes).toHaveLength(4);
    expect(new Set(vesselBoxes.map((b) => b.x)).size).toBe(1);
    expect(new Set(vesselBoxes.map((b) => b.w)).size).toBe(1);

    const actions = page.locator('.vessel-mobile-actions > button');
    const actionBoxes = await actions.evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return {x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent || '').trim(), aria: el.getAttribute('aria-label')};
    }));
    expect(actionBoxes).toHaveLength(4);
    expect(actionBoxes.every((b) => b.w === 44 && b.h === 44)).toBe(true);
    expect(new Set(actionBoxes.map((b) => b.y)).size).toBe(1);
    expect(actionBoxes.every((b) => b.text === '')).toBe(true);
    const gaps = actionBoxes.slice(1).map((b, i) => b.x - (actionBoxes[i].x + actionBoxes[i].w));
    expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThanOrEqual(1.5);
    expect(new Set(actionBoxes.map((b) => b.aria))).toEqual(new Set(['Import Chat', 'Import CSV — Import Vessel CSV', 'Export CSV', 'Print']));

    const filterCard = await box(page, '.vessel-filter-card');
    const newProgram = await box(page, '.vessel-new-program-bottom');
    expect(newProgram.y).toBeGreaterThanOrEqual(filterCard.y + filterCard.h);

    for (const width of [320, 375, 414]) {
      await page.setViewportSize({width, height: 812});
      await page.reload({waitUntil: 'networkidle'});
      await page.locator('.vessel-filter-grid').waitFor();
      const overflow = await page.evaluate(() => ({
        client: document.documentElement.clientWidth,
        scroll: document.documentElement.scrollWidth,
      }));
      expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
      await expect(header).toHaveText('Vessel Register');
      const headerOverflow = await header.evaluate((el) => ({client: el.clientWidth, scroll: el.scrollWidth}));
      expect(headerOverflow.scroll).toBeLessThanOrEqual(headerOverflow.client + 1);
    }
  });
});

test.describe('vessel desktop layout', () => {
  test.use({viewport: {width: 1366, height: 900}});

  test('desktop keeps the full headings and four-column filters', async ({page}) => {
    test.skip(!USER || !PASS, 'E2E credentials are not set');
    await login(page);

    await expect(page.locator('.wx-workspace__mobile-bar')).toBeHidden();
    await expect(page.locator('.vessel-page-head h1')).toBeVisible();
    await expect(page.locator('.vessel-register-head')).toBeVisible();
    await expect(page.locator('.vessel-filter-head')).toBeVisible();
    const columns = await page.locator('.vessel-filter-grid').evaluate((el) =>
      getComputedStyle(el).gridTemplateColumns.split(' ').filter(Boolean));
    expect(columns).toHaveLength(4);
    const overflow = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(overflow.scroll).toBeLessThanOrEqual(overflow.client + 1);
  });
});
