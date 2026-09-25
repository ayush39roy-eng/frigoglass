import { defineConfig, devices } from '@playwright/test';

/**
 * P4-T09 (qa-inspector) — Playwright E2E config for all six P4 surfaces:
 * Dashboard, Capacity, Matrix, Timeline/Gantt, Registration, and — as of this
 * task's independent re-verification session — Capacity Planning
 * (`/planning`), which was still `BLOCKED`/unbuilt when this file's original
 * header comment was written but is now DONE for its CRUD/Apply-Logic scope
 * (P4-T07). `planning.spec.ts` covers exactly that scope; it does not (and
 * cannot) exercise Auto-assign, which remains deliberately unbuilt pending
 * `docs/OPEN_QUESTIONS.md` #10 — the spec only asserts its placeholder is
 * present. P4-T08 (GDPR gate) remains out of scope: it blocks a feature
 * (named-engineer utilization) that no surface renders yet, so there is
 * nothing for Playwright to exercise.
 *
 * Runs against a REAL backend (FastAPI + Postgres + Keycloak), not a mock —
 * see `docs/MEMORY.md`'s P4-T09 entry for the full harness description.
 * `webServer` below starts the Vite preview server itself; the
 * backend/Postgres/Keycloak stack is started separately because it is
 * shared, long-lived test infrastructure, not something Playwright should
 * own the lifecycle of.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: 'playwright-report' }]],
  globalSetup: './e2e/global-setup.ts',
  use: {
    baseURL: process.env.RPD_E2E_BASE_URL ?? 'http://localhost:5183',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'pnpm run build:e2e && pnpm run preview:e2e',
    url: 'http://localhost:5183',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
