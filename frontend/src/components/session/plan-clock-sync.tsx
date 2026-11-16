import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import { invalidateRunDerivedQueries } from '@/lib/use-schedule-run-follow';
import { useSessionStore } from '@/stores/session';

/** Grace after the served `week_ends_at` before refetching, so the server's
 *  clock has certainly crossed Monday 00:00 Athens. */
export const WEEK_END_GRACE_MS = 5_000;
/** At most one focus-triggered refetch per this interval. */
export const FOCUS_REFETCH_MIN_INTERVAL_MS = 15_000;
/** While the active run is behind the calendar week, re-read `/me` this often
 *  so the "recalculating…" chip clears when the rollover run lands. */
export const BEHIND_POLL_MS = 30_000;
/** Floor of the week-end timer. */
export const MIN_WEEK_END_DELAY_MS = 30_000;
/** `setTimeout` overflows past 2^31 − 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * P37 (ADR 0052 §6): keeps the served plan clock fresh. Renders nothing.
 *
 * - Refetches `/me` at the served `week_ends_at` (plus a short grace). The
 *   browser clock only schedules the timer; the week itself is always the
 *   server's.
 * - Refetches on window focus / tab becoming visible (throttled).
 * - Polls while `plan_week.status` is not `current`, so the notice clears once
 *   the rollover run is active.
 * - Invalidates every run-derived query when the active run version changes
 *   (a rollover run activated without this tab dispatching it).
 */
export function PlanClockSync(): null {
  const queryClient = useQueryClient();
  const refresh = useSessionStore((s) => s.refresh);
  const weekEndsAt = useSessionStore((s) => s.me?.week_ends_at ?? null);
  const status = useSessionStore((s) => s.me?.plan_week?.status ?? null);
  const runVersion = useSessionStore((s) => s.me?.plan_week?.run_version ?? null);
  const week = useSessionStore((s) => s.me?.current_week ?? null);

  // Week rollover.
  React.useEffect(() => {
    if (!weekEndsAt) return undefined;
    const at = Date.parse(weekEndsAt);
    if (Number.isNaN(at)) return undefined;
    // A served week end already past by the browser clock (skew, or a tab woken
    // from sleep) refetches once after the floor, never in a tight loop.
    const delay = Math.min(Math.max(at - Date.now() + WEEK_END_GRACE_MS, MIN_WEEK_END_DELAY_MS), MAX_TIMER_MS);
    const timer = setTimeout(() => void refresh(), delay);
    return () => clearTimeout(timer);
  }, [weekEndsAt, refresh]);

  // Focus / visibility.
  React.useEffect(() => {
    let last = 0;
    const onFocus = (): void => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - last < FOCUS_REFETCH_MIN_INTERVAL_MS) return;
      last = now;
      void refresh();
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [refresh]);

  // Plan behind: poll until the run catches up (or fails for the week).
  React.useEffect(() => {
    if (status !== 'recalculating' && status !== 'pending') return undefined;
    const timer = setInterval(() => void refresh(), BEHIND_POLL_MS);
    return () => clearInterval(timer);
  }, [status, refresh]);

  // A new active run or a new calendar week: every run-derived view, and the
  // calendar-week figures (remaining capacity, check-ins due), are stale.
  const stamp = `${String(runVersion)}@${String(week)}`;
  const seen = React.useRef(stamp);
  React.useEffect(() => {
    if (seen.current === stamp) return;
    seen.current = stamp;
    invalidateRunDerivedQueries(queryClient);
  }, [stamp, queryClient]);

  return null;
}
