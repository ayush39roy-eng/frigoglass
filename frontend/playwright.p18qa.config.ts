import { defineConfig, devices } from '@playwright/test';

/** P17-R + P18 gate (qa-inspector): runs `e2e/p17-(gate|tmp).spec.ts` against an already-running disposable stack. */
export default defineConfig({
  testDir: './e2e',
  testMatch: process.env.RPD_P18_MATCH ? new RegExp(process.env.RPD_P18_MATCH) : /p18-gate\.spec\.ts/,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.RPD_P18_OUT ?? 'test-results-p18qa',
  use: { baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5292', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
