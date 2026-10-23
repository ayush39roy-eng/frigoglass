import { create } from 'zustand';

import { ApiError } from '@/lib/api/client';
import { fetchMe, type MeResponse, type SurfacePermission } from '@/lib/api/session';
import type { SurfaceKey } from '@/types/enums';

/**
 * The signed-in principal (ADR 0010 §2). Populated ONCE on boot from `GET /me`
 * by `<SessionGate>` and re-read after a dev-mode user switch. Server state that
 * lives here, not in TanStack Query, on purpose: every surface, the sidebar
 * and every route guard read it synchronously on every render, and a
 * permission table that could be `undefined` mid-refetch would flicker every
 * write control on the screen.
 *
 * The permissions here are a CONVENIENCE for the UI. The server enforces the
 * matrix on every request (`docs/PROJECT_AND_STACK.md` §5); a stale or
 * tampered table only changes what the browser draws, never what it can do.
 */

export type SessionStatus = 'idle' | 'loading' | 'ready' | 'error';
export type SessionErrorKind = 'unauthorized' | 'network' | 'other';

/**
 * P31-R01 (API cold start). The Render free tier puts the API to sleep when it
 * is idle; the first request after a nap takes 30–60 s or comes back as a
 * 502/503/504 from the proxy. A failed `/me` used to become "Could not load
 * your session" at once, and the owner then signed in again. Now a transient
 * failure (network error, per-attempt timeout, 502/503/504) is retried with
 * backoff for up to {@link SESSION_RETRY_BUDGET_MS}; `SessionGate` shows a
 * "Waking up the server…" state meanwhile. A 401 still goes straight to
 * `/login`, and every other 4xx/5xx fails at once. The dev-user email in
 * storage is never touched here, so a retry never signs anyone out.
 */
export const SESSION_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 15_000];
/** Total time the retries may span, measured from the first attempt. */
export const SESSION_RETRY_BUDGET_MS = 90_000;
/** One attempt that has not answered by then is aborted and counts as a timeout. */
export const SESSION_ATTEMPT_TIMEOUT_MS = 20_000;

/** Backoff before retry number `retryIndex` (0-based); the last step repeats. */
export function sessionRetryDelay(retryIndex: number): number {
  const last = SESSION_RETRY_DELAYS_MS[SESSION_RETRY_DELAYS_MS.length - 1] ?? 15_000;
  return SESSION_RETRY_DELAYS_MS[retryIndex] ?? last;
}

const GATEWAY_STATUSES = new Set([502, 503, 504]);

/** Network failure (status 0) or a gateway error from a sleeping upstream. */
export function isTransientApiError(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 0 || GATEWAY_STATUSES.has(err.status));
}

/** Set while `/me` is being retried after a transient failure; null otherwise. */
export interface SessionWaking {
  /** `Date.now()` of the first attempt — the gate shows the time since. */
  since: number;
  /** Retries scheduled so far (1 after the first failure). */
  attempt: number;
  /** `Date.now()` at which the next attempt fires. */
  nextRetryAt: number;
}

export interface SessionState {
  status: SessionStatus;
  me: MeResponse | null;
  errorKind: SessionErrorKind | null;
  waking: SessionWaking | null;
  /** Fetch `/me`, retrying transient failures (P31-R01). Safe to call
   *  repeatedly; concurrent calls share one flight. */
  load: () => Promise<void>;
  /** Skip the current backoff wait and try `/me` now. No-op otherwise. */
  retryNow: () => void;
  /** Test/bootstrap seam: install a session without a network call. */
  seed: (me: MeResponse) => void;
  reset: () => void;
}

const NO_ACCESS: SurfacePermission = { read: false, write: false };

let inflight: Promise<void> | null = null;
/** Bumped by every `load()` and `reset()`; a stale retry loop sees it and stops. */
let generation = 0;
/** Ends the current backoff wait early (`retryNow`, `reset`). */
let wakeEarly: (() => void) | null = null;

function backoff(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      wakeEarly = null;
      resolve();
    }, ms);
    wakeEarly = () => {
      clearTimeout(timer);
      wakeEarly = null;
      resolve();
    };
  });
}

class SessionTimeoutError extends Error {}

/**
 * One `/me` attempt. It loses a race against {@link SESSION_ATTEMPT_TIMEOUT_MS}
 * (and its request is aborted) if the API has not answered by then.
 */
async function fetchMeOnce(): Promise<MeResponse> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new SessionTimeoutError('GET /me timed out'));
    }, SESSION_ATTEMPT_TIMEOUT_MS);
  });
  try {
    return await Promise.race([fetchMe({ signal: controller.signal }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function classify(err: unknown): SessionErrorKind {
  if (err instanceof SessionTimeoutError) return 'network';
  if (err instanceof ApiError) {
    if (err.isUnauthorized) return 'unauthorized';
    if (isTransientApiError(err)) return 'network';
  }
  return 'other';
}

export const useSessionStore = create<SessionState>()((set) => ({
  status: 'idle',
  me: null,
  errorKind: null,
  waking: null,

  load: () => {
    if (inflight) return inflight;
    generation += 1;
    const gen = generation;
    set({ status: 'loading', errorKind: null, waking: null });

    const run = async (): Promise<void> => {
      const startedAt = Date.now();
      for (let retryIndex = 0; ; retryIndex += 1) {
        try {
          const me = await fetchMeOnce();
          if (gen !== generation) return;
          set({ status: 'ready', me, errorKind: null, waking: null });
          return;
        } catch (err) {
          if (gen !== generation) return;
          const transient = err instanceof SessionTimeoutError || isTransientApiError(err);
          const delay = sessionRetryDelay(retryIndex);
          const now = Date.now();
          if (!transient || now - startedAt + delay > SESSION_RETRY_BUDGET_MS) {
            set({ status: 'error', me: null, errorKind: classify(err), waking: null });
            return;
          }
          set({ waking: { since: startedAt, attempt: retryIndex + 1, nextRetryAt: now + delay } });
          await backoff(delay);
          if (gen !== generation) return;
        }
      }
    };

    const flight = run().finally(() => {
      if (inflight === flight) inflight = null;
    });
    inflight = flight;
    return flight;
  },

  retryNow: () => {
    wakeEarly?.();
  },

  seed: (me) => set({ status: 'ready', me, errorKind: null, waking: null }),

  reset: () => {
    generation += 1;
    wakeEarly?.();
    inflight = null;
    set({ status: 'idle', me: null, errorKind: null, waking: null });
  },
}));

/** Pure lookup — a missing key is "no access", never a crash on an older payload. */
export function permissionFor(me: MeResponse | null, surface: SurfaceKey): SurfacePermission {
  if (!me) return NO_ACCESS;
  const cell = me.permissions[surface] as SurfacePermission | undefined;
  return cell ?? NO_ACCESS;
}

/** `{read, write}` for one surface, re-rendering only when that cell changes. */
export function usePermission(surface: SurfaceKey): SurfacePermission {
  const me = useSessionStore((s) => s.me);
  return permissionFor(me, surface);
}

export function useSession(): Pick<SessionState, 'status' | 'me' | 'errorKind'> {
  const status = useSessionStore((s) => s.status);
  const me = useSessionStore((s) => s.me);
  const errorKind = useSessionStore((s) => s.errorKind);
  return { status, me, errorKind };
}
