import { afterEach, vi } from 'vitest';
import { cleanup, configure } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
// The `/vitest` entry point (not `/matchers`) both calls `expect.extend(...)` AND
// augments vitest's `Assertion`/`AsymmetricMatchersContaining` types via `declare
// module 'vitest'` — importing `/matchers` alone leaves `toHaveTextContent` etc.
// untyped even though they work fine at runtime.
import '@testing-library/jest-dom/vitest';

// P4-T09 (qa-inspector): Testing Library's `findBy*`/`waitFor` helpers default to
// a 1000ms internal timeout, independent of Vitest's own (much larger) per-test
// `testTimeout` (vite.config.ts) — raising the latter alone does not help a
// `findByRole` that is still bound by the former. Under full file-parallelism
// (`vitest run`, no `--no-file-parallelism`), tests that cross a React.lazy
// route-chunk boundary (`app.test.tsx`'s nav tests) or drive a long multi-field
// form (`project-form.test.tsx`) intermittently exceed 1000ms under CPU
// contention alone — not a real hang, not a broken assertion. Widening this
// globally (test-infra-only) is the correct fix so `pnpm test` is reliably green
// unscoped, matching this task's acceptance criterion.
configure({ asyncUtilTimeout: 5_000 });

// jsdom has no matchMedia — the theme provider and Framer Motion's useReducedMotion both use it.
if (!window.matchMedia) {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }) as unknown as MediaQueryList;
}

// jsdom does not implement these; several Radix primitives call them.
if (!window.HTMLElement.prototype.scrollIntoView) {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}
if (!window.HTMLElement.prototype.hasPointerCapture) {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
}
if (!window.HTMLElement.prototype.releasePointerCapture) {
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}


// No unit test should hit the network. Surfaces that fetch mock `@/lib/api/*`
// explicitly; this default just turns an accidental un-mocked call into a fast,
// obvious rejection instead of a real (Node 20 global) fetch to localhost.
globalThis.fetch = vi.fn(
  () => Promise.reject(new Error('Un-mocked fetch in test — mock @/lib/api/* explicitly.')),
) as unknown as typeof fetch;

/**
 * Root-cause fix for the P5-T09 full-suite hang investigation (2026-09-05).
 *
 * Every test that renders a component wired to TanStack Query builds its own
 * `QueryClient` — `src/test/render.tsx`'s `renderWithProviders`/`renderApp`,
 * plus seven files that build one directly for `renderHook` (grep for `new
 * QueryClient(` under `src/`: `lib/api/notifications.test.tsx` and one
 * `use-*.test.tsx` per surface — pre-existing since P4, not new to P5-T09).
 * None of them were ever disposed. `@tanstack/query-core`'s own
 * `timeoutManager.js` docstring says outright: "makes liberal use of
 * timeouts to implement staleTime and gcTime... known to have scalability
 * issues with thousands of timeouts on the event loop." Concretely: every
 * query schedules a REAL `setTimeout` for `gcTime` (this app's shared
 * default is 300_000ms — `lib/query-client.ts`) the moment its last observer
 * unmounts, and only `queryCache.clear()` (via `QueryClient.clear()`) ever
 * cancels it — RTL's `cleanup()` unmounts the component tree, which
 * unsubscribes each query's observer and is what *triggers* that scheduling,
 * but it does not touch the abandoned `QueryClient`/cache itself. None of
 * these 300s timers fire during a normal ~90s suite run; they just
 * accumulate, each retaining its whole `QueryClient`/`QueryCache`/cached-
 * response object graph in memory, un-collectable, for the rest of the run.
 * Confirmed directly (temporary instrumentation, since removed): an
 * unfixed full run left ~130 such timers still pending at the end. This
 * predates P5-T09 (it's inherent to every one of those eight call sites
 * across P4 and P5), but P5-T09 makes it measurably worse: `NotificationBell`
 * is now mounted in `AppHeader`, and `app.test.tsx` (10 `renderApp()` calls,
 * the single highest-QueryClient-churn file in the suite) does not mock
 * `@/lib/api/*` at all, so its notifications query — like every other query
 * on that page — fails against the global `Promise.reject` fetch stub above
 * and retries, adding one more gc-timer-scheduling query to each of those
 * ten renders. This is the most likely mechanism behind the intermittent,
 * different-file-every-time, full-suite-only hang reported for P5-T09: real
 * timer/heap-retention pressure that compounds across the ~90-file
 * sequential `--no-file-parallelism` run (all files share a single forked
 * worker process — confirmed via `ps` during a live run) and only becomes
 * pathological (GC pauses long enough to stall whatever `waitFor`/`act`
 * polling loop happens to be running at that moment) once enough of it has
 * piled up — which is exactly why it never reproduces for a single file in
 * isolation and hits a different, unrelated test every time.
 *
 * Fix: patch `QueryClient.prototype.mount` (called once by every
 * `QueryClientProvider` for the client it wraps, regardless of which file or
 * helper constructed that client) to track every `QueryClient` instance this
 * process ever mounts, then `.clear()` every one of them (which synchronously
 * cancels every query's gc timeout — see `Removable.destroy()`/
 * `QueryCache.clear()` in `@tanstack/query-core`) after every test. This is
 * deliberately done here, patching the third-party `QueryClient` class
 * itself, rather than by having this file import `src/test/render.tsx` (or
 * any other app-code module) to reach a shared per-render cleanup function —
 * a first attempt at exactly that broke `notification-bell.test.tsx`:
 * `setup.ts` runs before every test file, so eagerly importing `render.tsx`
 * (which imports `@/app/routes` → `AppHeader` → `@/lib/api/notifications`)
 * from here caches the REAL `@/lib/api/notifications` module before that
 * test file's own hoisted `vi.mock('@/lib/api/notifications', ...)` could
 * register, so the component under test called the real `useNotifications`
 * (hitting the always-rejecting fetch stub above) instead of the test's
 * `vi.fn()` mock — 8 failures, confirmed by running that file in isolation.
 * `QueryClient` has no such hazard: it's a third-party class with no
 * per-file mock to collide with.
 *
 * Ordering also matters and is handled explicitly, not left to `afterEach`
 * registration order: `.clear()` must run *after* `cleanup()` unmounts the
 * component tree (unmounting is what unsubscribes each query's last
 * observer and triggers `scheduleGc()` in the first place — clearing first
 * only for a fresh gc timer to get scheduled moments later by the unmount
 * that follows, undoing most of the point). Both calls live in the same
 * `afterEach` below, in that order, so there is no cross-file ordering to
 * reason about.
 *
 * Confirmed by instrumentation (temporary, removed): this gets the
 * still-pending-gc-timer count at the end of a full run from ~130 down to
 * ~64 — not all the way to 0. The remaining ~64 (49 of them in
 * `app.test.tsx` alone, the rest scattered one-or-two-at-a-time across a
 * handful of pre-existing `use-*.test.tsx` hook tests) were traced to a
 * *different*, narrower cause: async work (an in-flight retry/fetch) still
 * outstanding at the exact moment a given test's `afterEach` runs, which
 * schedules its own gc timer moments later, after that test's `.clear()`
 * sweep already ran and forgot about the client. That's a real, but much
 * smaller and differently-shaped, residual — see the P5-T09 hang
 * investigation's `docs/MEMORY.md` entry for the full numbers and reasoning
 * for treating this residual as acceptable (well below the "thousands" scale
 * TanStack's own docs call out as the actual danger zone, confirmed via
 * multiple full clean suite runs both before and after this fix).
 *
 * This is test-infra-only: it does not touch `NOTIFICATIONS_POLL_INTERVAL_MS`,
 * `retryUnlessAuth`, `lib/query-client.ts`'s shared `gcTime`/`staleTime`
 * defaults, or any other shipped behavior — the 60s notifications poll and
 * every surface's real caching behavior are unchanged in the browser.
 */
const trackedQueryClients = new Set<QueryClient>();
const originalQueryClientMount = QueryClient.prototype.mount;
QueryClient.prototype.mount = function patchedMount(this: QueryClient) {
  trackedQueryClients.add(this);
  return originalQueryClientMount.call(this);
};

afterEach(() => {
  cleanup();
  // Must run after cleanup() above — see the ordering note in the
  // `QueryClient.prototype.mount` patch's docstring.
  for (const client of trackedQueryClients) {
    client.clear();
  }
  trackedQueryClients.clear();
  window.localStorage.clear();
  document.documentElement.classList.remove('dark');
});
