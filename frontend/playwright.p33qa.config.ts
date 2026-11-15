import { defineConfig, devices } from '@playwright/test';

/**
 * P33 gate (qa-inspector): runs e2e/p33-gate.spec.ts against an already-running
 * DISPOSABLE stack (own Postgres/Redis/uvicorn/vite --mode e2e). No webServer.
 *   RPD_E2E_BASE_URL       vite (e2e mode) URL
 *   RPD_E2E_BACKEND_URL    uvicorn URL (dev-session apiGet / direct API calls)
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: process.env.RPD_P33_MATCH ? new RegExp(process.env.RPD_P33_MATCH) : /p33-gate\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 20_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.RPD_P33_OUT ?? 'test-results-p33qa',
  use: {
    baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5933',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
