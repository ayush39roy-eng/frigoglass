import { defineConfig, devices } from '@playwright/test';

/**
 * P19 + P20 (+P17-R05..R09) gate (qa-inspector): runs specs against an already-running
 * DISPOSABLE stack (own Postgres/Redis/Keycloak/uvicorn/vite preview). No webServer.
 *   RPD_E2E_BASE_URL       vite preview (e2e mode) URL
 *   RPD_E2E_BACKEND_URL    uvicorn URL (dev-session apiGet)
 *   RPD_E2E_KEYCLOAK_URL   disposable Keycloak (Keycloak-token specs)
 *   RPD_P19_MATCH          regex of spec files to run
 *   RPD_P19_KC=1           mint Keycloak tokens in global setup
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: process.env.RPD_P19_MATCH ? new RegExp(process.env.RPD_P19_MATCH) : /p19-gate\.spec\.ts/,
  timeout: 120_000,
  expect: { timeout: 12_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: process.env.RPD_P19_KC ? './e2e/global-setup.ts' : undefined,
  outputDir: process.env.RPD_P19_OUT ?? 'test-results-p19qa',
  use: {
    baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5920',
    screenshot: 'only-on-failure',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
