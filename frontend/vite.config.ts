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
