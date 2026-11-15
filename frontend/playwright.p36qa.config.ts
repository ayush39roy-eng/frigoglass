import { defineConfig, devices } from '@playwright/test';

/**
 * P36 gate (qa-inspector): runs e2e/p36-gate.spec.ts against an already-running
 * DISPOSABLE stack (own Postgres/Redis/uvicorn/vite --mode e2e). No webServer.
 *   RPD_E2E_BASE_URL       vite (e2e mode) URL
 *   RPD_E2E_BACKEND_URL    uvicorn URL (dev-session apiGet / direct API calls)
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /p36-gate\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: process.env.RPD_P36_OUT ?? 'test-results-p36qa',
  use: {
    baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5936',
    viewport: { width: 1440, height: 900 },
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } } }],
});
