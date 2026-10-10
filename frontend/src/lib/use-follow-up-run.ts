import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { apiGet, ApiError } from '@/lib/api/client';
import { invalidateRunDerivedQueries } from '@/lib/use-schedule-run-follow';

/**
 * Watch for the coalesced follow-up run (ADR 0023, API_CONTRACT_P12 §8).
 *
 * When an auto-recalc answers `deferred` (priority move, Gantt step timing,
 * weekly check-in), the server records ONE follow-up request and runs it when
 * the in-flight run ends. The browser cannot follow that run's SSE (it has no
 * id yet), so it polls `GET /schedule-runs/active` every 5 s for up to 3 min.
 * Each time the active run id changes, every active-run-backed query is
 * invalidated (`invalidateRunDerivedQueries`: Gantt, Dashboard, Capacity,
 * Workspace, Matrix, Priority board, VIP, check-ins). Watching stops early once
 * the active run is the follow-up itself (`trigger_reason === "follow_up"`).
 *
 * Nothing is computed here: the server decides when and what runs.
 *
 * Shared by the P11 priority move, the P12 Gantt drag (frontend A) and the
 * weekly check-in page (frontend B).
 */

export const FOLLOW_UP_POLL_MS = 5_000;
export const FOLLOW_UP_TIMEOUT_MS = 3 * 60_000;

interface ActiveRunId {
  id: string;
  trigger_reason: string | null;
}

/** `null` when no run is active (404), the run otherwise. */
async function fetchActiveRunId(signal: AbortSignal): Promise<ActiveRunId | null> {
  try {
    return await apiGet<ActiveRunId>('/schedule-runs/active', { signal });
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}

interface WatchState {
  timer: ReturnType<typeof setInterval> | null;
  controller: AbortController | null;
  deadline: number;
  /** `undefined` until the first poll has read the baseline. */
  baseline: string | null | undefined;
  inFlight: boolean;
}

const IDLE: WatchState = { timer: null, controller: null, deadline: 0, baseline: undefined, inFlight: false };

export function useFollowUpRunWatcher(): { start: () => void; watching: boolean } {
  const queryClient = useQueryClient();
  const [watching, setWatching] = React.useState(false);
  const ref = React.useRef<WatchState>({ ...IDLE });

  const stop = React.useCallback(() => {
    const cur = ref.current;
    if (cur.timer !== null) clearInterval(cur.timer);
    cur.controller?.abort();
    ref.current = { ...IDLE };
    setWatching(false);
  }, []);

  React.useEffect(() => () => stop(), [stop]);

  const tick = React.useCallback(async () => {
    const cur = ref.current;
    if (cur.timer === null || cur.inFlight || cur.controller === null) return;
    if (Date.now() > cur.deadline) {
      stop();
      return;
    }
    cur.inFlight = true;
    try {
      const run = await fetchActiveRunId(cur.controller.signal);
      if (ref.current !== cur) return; // stopped or restarted meanwhile
      const id = run?.id ?? null;
      if (cur.baseline === undefined) {
        cur.baseline = id;
        return;
      }
      if (id !== cur.baseline) {
        cur.baseline = id;
        invalidateRunDerivedQueries(queryClient);
        if (run?.trigger_reason === 'follow_up') stop();
      }
    } catch {
      // A failed poll is retried on the next tick until the deadline.
    } finally {
      cur.inFlight = false;
    }
  }, [queryClient, stop]);

  const start = React.useCallback(() => {
    stop();
    const state: WatchState = {
      timer: null,
      controller: new AbortController(),
      deadline: Date.now() + FOLLOW_UP_TIMEOUT_MS,
      baseline: undefined,
      inFlight: false,
    };
    state.timer = setInterval(() => void tick(), FOLLOW_UP_POLL_MS);
    ref.current = state;
    setWatching(true);
    // Read the baseline now, so a run that lands before the first interval is seen.
    void tick();
  }, [stop, tick]);

  return { start, watching };
}
