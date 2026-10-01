/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// P4-T09 (qa-inspector): `/api` -> the real FastAPI backend, dev/preview-server-side
// only (never applied to `vite build` output). Used exclusively by the Playwright E2E
// harness (`--mode e2e`, see `.env.e2e.local`) so the browser's same-origin `/api/...`
// fetches are forwarded to a real backend without needing CORS middleware on the
// FastAPI app (which does not exist and is out of this task's remit to add). Inert for
// every other mode: `VITE_API_BASE_URL` defaults to `''` (same-origin, no `/api` prefix)
// everywhere else, so this proxy rule is simply never hit outside `--mode e2e`.
const E2E_BACKEND_TARGET = process.env.RPD_E2E_BACKEND_URL ?? 'http://localhost:8001';

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    // Emitted so scripts/check-bundle-size.mjs can resolve the true initial chunk
    // (entry + its static imports + their CSS) instead of eyeballing file sizes.
    manifest: true,
    target: 'es2022',
    sourcemap: false,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: E2E_BACKEND_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  preview: {
    proxy: {
      '/api': {
        target: E2E_BACKEND_TARGET,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ''),
      },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: true,
    // P4-T09 (qa-inspector): the default 5000ms per-test timeout is tight enough
    // that a handful of tests (app.test.tsx's route-navigation tests, which mount
    // the real router and cross a React.lazy chunk boundary; project-form.test.tsx's
    // long multi-field userEvent flow) intermittently time out under full
    // file-parallelism (`vitest run` with no `--no-file-parallelism`), even though
    // every one of them passes reliably in isolation or under reduced parallelism —
    // CPU contention across ~80 concurrently-transforming test files, not a real
    // hang or a broken assertion. Raising the ceiling here (test-infra-only; no
    // test's own logic/assertions changed) is the correct fix so `pnpm test`
    // (unscoped, no manual `--no-file-parallelism` workaround) is reliably green,
    // rather than leaving every future session to keep rediscovering and manually
    // working around the same flake.
    testTimeout: 10_000,
    // 2026-10-01 (flaky-suite root cause). Vitest's default is one worker per
    // logical core. That is the wrong default for THIS suite: every worker builds
    // its own jsdom, and ~130 jsdom environments plus React/Radix/TanStack module
    // graphs on a 10-core / 16 GB dev box — which is also running the Vite dev
    // server, the FastAPI backend and Postgres — oversubscribes CPU and memory
    // badly enough that individual tests inflate ~7x. Measured: a
    // `project-form.test.tsx` case that takes 1.3s alone blew past the 10s
    // `testTimeout` under full parallelism, and `session-gate.test.tsx`'s first
    // test went 1.5s → >10s. That is contention, not a hang or a bad assertion,
    // which is why it never reproduced for a single file in isolation and hit a
    // different, unrelated file on every run.
    //
    // Capping at half the cores roughly HALVES cumulative per-test wall time
    // (`tests` 274-429s → 209s, `environment` 294-360s → 135s on identical
    // hardware) for essentially the same total duration (~92-120s → ~102s),
    // because the suite was thrashing rather than working. A percentage, not a
    // literal, so CI hardware with a different core count scales with it.
    //
    // This is a complement to, not a substitute for, the real fix on the app
    // side: the Dashboard's Recharts/analytics panels are now `React.lazy` (see
    // `surfaces/dashboard/DashboardPage.tsx`), so rendering the app shell no
    // longer evaluates ~353 KB of charting code that nothing on screen needs.
    maxWorkers: '50%',
    // P4-T09 (qa-inspector): Playwright's own E2E specs live under `e2e/*.spec.ts`
    // (its default `testDir`) — Vitest's default include glob would otherwise also
    // pick them up (both use `*.spec.ts`) and fail to import `@playwright/test`
    // outside the Playwright runner.
    exclude: ['**/node_modules/**', '**/dist/**', '**/dist-e2e/**', 'e2e/**'],
    coverage: {
      provider: 'v8',
      reportsDirectory: './coverage',
      include: ['src/**/*.{ts,tsx}'],
      exclude: ['src/**/*.test.{ts,tsx}', 'src/test/**', 'src/types/**'],
    },
  },
});
