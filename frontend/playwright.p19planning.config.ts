import { defineConfig, devices } from '@playwright/test';

/**
 * P19-T04: mocked-route run of `e2e/p19-planning.spec.ts` on its own Vite dev
 * server (port 5293). Every `/api/**` call is answered inside the spec, so it
 * needs no backend and never touches :8001 / :5183.
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: /p19-planning\.spec\.ts/,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5293', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm exec vite --mode e2e --port 5293 --strictPort',
    url: 'http://localhost:5293',
    reuseExistingServer: true,
    timeout: 120_000,
  },
});
