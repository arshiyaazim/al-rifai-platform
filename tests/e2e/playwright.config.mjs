import {defineConfig} from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: {timeout: 10_000},
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'https://127.0.0.1:8443',
    ignoreHTTPSErrors: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
});
