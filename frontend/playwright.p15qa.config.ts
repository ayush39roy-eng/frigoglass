import { defineConfig, devices } from '@playwright/test';

/** P15 gate (qa-inspector): runs `e2e/p15-gate.spec.ts` against an already-running disposable stack. */
export default defineConfig({
  testDir: './e2e',
  testMatch: /p15-gate\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5271', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
